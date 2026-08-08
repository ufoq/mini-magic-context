import { createHash } from "node:crypto";

import type { EmbeddingConfig } from "../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../config/schema/magic-context";
import { log } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import {
    buildCanonicalChunkTextFromFts,
    buildCompartmentSummaryFallbackText,
    type CompartmentChunkBackfillCandidate,
    chunkCanonicalText,
    chunkEmbeddingWindowsAreCurrent,
    countSessionCompartmentEmbedCoverage,
    countUnembeddedSessionCompartments,
    loadUnembeddedSessionChunkCandidates,
    normalizeCompartmentChunkMaxInputTokens,
    replaceCompartmentChunkEmbeddings,
    type SaveCompartmentChunkEmbeddingInput,
} from "./compartment-chunk-embedding";
import { getEmbeddingProviderIdentity } from "./memory/embedding-identity";
import { LocalEmbeddingProvider } from "./memory/embedding-local";
import { OpenAICompatibleEmbeddingProvider } from "./memory/embedding-openai";
import type { EmbeddingProvider, EmbeddingPurpose } from "./memory/embedding-provider";
import {
    recordSessionProjectIdentity,
    repairMisScopedCompartmentChunkEmbeddingsForProject,
} from "./session-project-storage";

const OFF_PROVIDER_IDENTITY = "embedding-provider:off";
// Session backfill (/ctx-embed) holds the coordinator lease for an unbounded
// run, so it must renew before the TTL lapses.
const _SESSION_EMBED_LEASE_RENEWAL_MS = 60 * 1000;
// Resilience for the session drain. The provider NEVER throws (it returns null /
// all-null vectors and owns its own HTTP circuit breaker), so "retry" here is the
// drain's stop policy, not HTTP retry.
const EMBED_SLICE_RETRY_ATTEMPTS = 3;
const EMBED_SLICE_RETRY_BASE_MS = 250;
// If a single failed provider call took at least this long, treat it as a
// timeout (not a transient blip) and do NOT retry it — re-sending the same
// payload would just burn another full timeout. A healthy small call (≤2
// windows) returns in a few seconds, well under this.
const EMBED_SLOW_FAILURE_NO_RETRY_MS = 10_000;
const MAX_CONSECUTIVE_FAILED_BATCHES = 3;
const EMBEDDING_IDENTITY_GC_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const STALE_EMBEDDING_GC_BATCH_SIZE = 250;
// Hard cap on embedding-window texts sent in ONE provider call. Deliberately
// SMALL: a local embedding endpoint (LMStudio/Ollama) runs one forward pass per
// input, so batching many max_input_tokens-sized windows into a single request
// makes that request too slow to finish inside the HTTP timeout. Compartments are
// never split across calls; a compartment with more windows than this still
// embeds as its own over-cap call.
const MAX_WINDOWS_PER_EMBED_CALL = 2;

export interface EmbeddingFeatures {
    memoryEnabled: boolean;
    gitCommitEnabled: boolean;
}

export interface ProjectEmbeddingRegistrationSnapshot {
    projectIdentity: string;
    sourceDirectory: string;
    providerIdentity: string;
    runtimeFingerprint: string;
    generation: number;
    features: EmbeddingFeatures;
    enabled: boolean;
    gitCommitEnabled: boolean;
    modelId: string;
    chunkModelId: string;
    /** Friendly configured model name (e.g. "text-embedding-qwen3-embedding-4b"),
     *  for user-facing status. "off" when no provider / observation mode. */
    model: string;
    /** Configured provider kind (e.g. "openai-compatible", "local"). */
    provider: string;
}

interface ProjectEmbeddingRegistration {
    projectIdentity: string;
    sourceDirectory: string;
    config: EmbeddingConfig;
    providerIdentity: string;
    runtimeFingerprint: string;
    provider: EmbeddingProvider | null;
    generation: number;
    features: EmbeddingFeatures;
    modelId: string;
    chunkModelId: string;
    observationMode: boolean;
}

type EmbeddingIdentityScope = "chunk";

interface StaleIdentityRow {
    modelId: string;
}

const projectRegistrations = new Map<string, ProjectEmbeddingRegistration>();

const upsertActiveIdentityStatements = new WeakMap<Database, PreparedStatement>();
const backfillActiveIdentityStatements = new WeakMap<Database, PreparedStatement>();
const staleIdentityStatements = new WeakMap<Database, PreparedStatement>();
const deleteActiveIdentityStatements = new WeakMap<Database, PreparedStatement>();
let globalRegistrationGeneration = 0;

/**
 * Projects whose most-recent config load was untrusted (parse/IO error, legacy
 * config unmigrated, or an embedding-affecting substitution/recovery failure).
 * While a project is latched here we keep serving its last-known-good provider
 * for reads/writes but SUPPRESS the destructive stale-identity GC — a degraded
 * load must never delete embedding rows off a config we don't trust. The latch
 * clears the next time a trusted config successfully registers the project.
 */
const untrustedLoadProjects = new Set<string>();

/** Latch a project as currently loaded from an untrusted config (suppresses GC). */
export function markProjectLoadUntrusted(projectIdentity: string): void {
    untrustedLoadProjects.add(projectIdentity);
}
let testProviderFactory: ((config: EmbeddingConfig) => EmbeddingProvider | null) | null = null;

function resolveEmbeddingConfig(config?: EmbeddingConfig): EmbeddingConfig {
    if (!config || config.provider === "local") {
        return {
            provider: "local",
            model: config?.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
            ...(config?.max_input_tokens
                ? {
                      max_input_tokens: normalizeCompartmentChunkMaxInputTokens(
                          config.max_input_tokens,
                      ),
                  }
                : {}),
        };
    }

    if (config.provider === "off") {
        return { provider: "off" };
    }

    if (config.provider === "openai-compatible") {
        const apiKey = config.api_key?.trim();
        const inputType = config.input_type?.trim();
        const queryInputType = config.query_input_type?.trim();
        const truncate = config.truncate?.trim();
        return {
            provider: "openai-compatible",
            model: config.model.trim(),
            endpoint: config.endpoint.trim(),
            ...(apiKey ? { api_key: apiKey } : {}),
            // Preserve provider-specific request fields (NVIDIA NIM input_type;
            // truncate). They must survive normalization so (a) they reach the
            // provider request body and (b) a change to either is part of the
            // config identity hash → a real config change correctly wipes stale
            // vectors. query_input_type shapes per-call requests only and is
            // intentionally omitted from identity (stored vectors use passage).
            ...(inputType ? { input_type: inputType } : {}),
            ...(queryInputType ? { query_input_type: queryInputType } : {}),
            ...(truncate ? { truncate } : {}),
            ...(config.max_input_tokens
                ? {
                      max_input_tokens: normalizeCompartmentChunkMaxInputTokens(
                          config.max_input_tokens,
                      ),
                  }
                : {}),
        };
    }
    throw new Error("Unsupported embedding provider");
}

function createProvider(
    config: EmbeddingConfig,
    _context?: { projectRoot: string; session: string },
): EmbeddingProvider | null {
    if (testProviderFactory) {
        return testProviderFactory(config);
    }

    if (config.provider === "openai-compatible") {
        return new OpenAICompatibleEmbeddingProvider({
            endpoint: config.endpoint,
            model: config.model,
            apiKey: config.api_key,
            inputType: config.input_type,
            queryInputType: config.query_input_type,
            truncate: config.truncate,
            maxInputTokens: config.max_input_tokens,
        });
    }

    if (config.provider === "local") {
        return new LocalEmbeddingProvider(config.model, config.max_input_tokens);
    }
    if (config.provider === "off") {
        return null;
    }
    throw new Error("Unsupported embedding provider");
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
        );
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function sha256Prefix(value: string, length = 16): string {
    return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function contentSha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function getRuntimeFingerprint(config: EmbeddingConfig): string {
    return `${getEmbeddingProviderIdentity(config)}:${sha256Prefix(stableStringify(config))}`;
}

function getChunkEmbeddingModelId(config: EmbeddingConfig, providerIdentity: string): string {
    // Chunk vectors depend on the provider vector space AND the exact windowing
    // contract used to derive chunk text.
    const chunkIdentity = {
        providerIdentity,
        // v2: windowing targets CHUNK_WINDOW_SAFETY_RATIO * max_input_tokens
        // instead of the raw ceiling, so boundaries shifted — bump to re-embed.
        chunkerVersion: 2,
        maxInputTokens: normalizeCompartmentChunkMaxInputTokens(
            "max_input_tokens" in config ? config.max_input_tokens : undefined,
        ),
        truncate: config.provider === "openai-compatible" ? (config.truncate ?? "") : "",
    };
    return `${providerIdentity}:chunk:${sha256Prefix(stableStringify(chunkIdentity))}`;
}

function sameFeatures(a: EmbeddingFeatures, b: EmbeddingFeatures): boolean {
    return a.memoryEnabled === b.memoryEnabled && a.gitCommitEnabled === b.gitCommitEnabled;
}

function snapshotFor(
    registration: ProjectEmbeddingRegistration,
): ProjectEmbeddingRegistrationSnapshot {
    const providerIsOn = registration.providerIdentity !== OFF_PROVIDER_IDENTITY;
    const enabled = !registration.observationMode && providerIsOn;
    const gitCommitEnabled =
        !registration.observationMode && providerIsOn && registration.features.gitCommitEnabled;
    const configuredModel =
        "model" in registration.config && typeof registration.config.model === "string"
            ? registration.config.model.trim()
            : "";
    return {
        projectIdentity: registration.projectIdentity,
        sourceDirectory: registration.sourceDirectory,
        providerIdentity: registration.providerIdentity,
        runtimeFingerprint: registration.runtimeFingerprint,
        generation: registration.generation,
        features: { ...registration.features },
        enabled,
        gitCommitEnabled,
        modelId: registration.observationMode || !providerIsOn ? "off" : registration.modelId,
        chunkModelId:
            registration.observationMode || !providerIsOn ? "off" : registration.chunkModelId,
        model:
            registration.observationMode || !providerIsOn
                ? "off"
                : configuredModel
                  ? configuredModel
                  : registration.modelId,
        provider:
            registration.observationMode || !providerIsOn
                ? "off"
                : (registration.config.provider ?? "local"),
    };
}

function disposeProvider(provider: EmbeddingProvider | null): void {
    if (!provider) return;
    void provider.dispose().catch((error) => {
        log("[magic-context] embedding provider dispose failed:", error);
    });
}

function getUpsertActiveIdentityStatement(db: Database): PreparedStatement {
    let stmt = upsertActiveIdentityStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT INTO embedding_identity_active (project_path, scope, model_id, last_active_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(project_path, scope, model_id) DO UPDATE SET
                 last_active_at = excluded.last_active_at`,
        );
        upsertActiveIdentityStatements.set(db, stmt);
    }
    return stmt;
}

function getBackfillActiveIdentityStatement(db: Database): PreparedStatement {
    let stmt = backfillActiveIdentityStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT OR IGNORE INTO embedding_identity_active (project_path, scope, model_id, last_active_at)
             SELECT ?, ?, model_id, ?
             FROM (
                 SELECT DISTINCT e.model_id AS model_id
                 FROM compartment_chunk_embeddings e
                 WHERE e.project_path = ?
             )
             WHERE model_id IS NOT NULL`,
        );
        backfillActiveIdentityStatements.set(db, stmt);
    }
    return stmt;
}

function recordScopeActiveIdentity(
    db: Database,
    projectIdentity: string,
    scope: EmbeddingIdentityScope,
    modelId: string,
    now: number,
): void {
    getUpsertActiveIdentityStatement(db).run(projectIdentity, scope, modelId, now);
    getBackfillActiveIdentityStatement(db).run(projectIdentity, scope, now, projectIdentity);
}

function recordActiveEmbeddingIdentity(
    db: Database,
    projectIdentity: string,
    currentChunkIdentity: string,
): void {
    if (currentChunkIdentity === OFF_PROVIDER_IDENTITY) {
        return;
    }

    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
        repairMisScopedCompartmentChunkEmbeddingsForProject(db, projectIdentity);
        recordScopeActiveIdentity(db, projectIdentity, "chunk", currentChunkIdentity, now);
        db.exec("COMMIT");
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // The transaction may already be closed by SQLite after a fatal error.
        }
        throw error;
    }
}

function getStaleIdentityStatement(db: Database): PreparedStatement {
    let stmt = staleIdentityStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT model_id AS modelId
             FROM embedding_identity_active
             WHERE project_path = ?
               AND scope = 'chunk'
               AND model_id <> ?
               AND last_active_at < ?`,
        );
        staleIdentityStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteActiveIdentityStatement(db: Database): PreparedStatement {
    let stmt = deleteActiveIdentityStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `DELETE FROM embedding_identity_active
             WHERE project_path = ? AND scope = ? AND model_id = ?`,
        );
        deleteActiveIdentityStatements.set(db, stmt);
    }
    return stmt;
}

function staleModelsForScope(
    db: Database,
    projectIdentity: string,
    currentModelId: string,
    cutoff: number,
    protectedModelIds: ReadonlySet<string> = new Set([currentModelId]),
): string[] {
    const rows = getStaleIdentityStatement(db).all(
        projectIdentity,
        currentModelId,
        cutoff,
    ) as StaleIdentityRow[];
    return rows
        .map((row) => row.modelId)
        .filter((modelId) => typeof modelId === "string" && !protectedModelIds.has(modelId));
}

export interface StaleEmbeddingSweepResult {
    memoryRowsDeleted: number;
    commitRowsDeleted: number;
    chunkRowsDeleted: number;
    trackingRowsDeleted: number;
}

function deleteStaleChunkEmbeddingBatch(
    db: Database,
    projectIdentity: string,
    modelId: string,
    limit: number,
): number {
    return db
        .prepare(
            `DELETE FROM compartment_chunk_embeddings
             WHERE id IN (
                 SELECT id
                 FROM compartment_chunk_embeddings
                 WHERE project_path = ? AND model_id = ?
                 LIMIT ?
             )`,
        )
        .run(projectIdentity, modelId, limit).changes;
}

function hasStaleChunkEmbeddingRows(
    db: Database,
    projectIdentity: string,
    modelId: string,
): boolean {
    return Boolean(
        db
            .prepare(
                `SELECT 1
                 FROM compartment_chunk_embeddings
                 WHERE project_path = ? AND model_id = ?
                 LIMIT 1`,
            )
            .get(projectIdentity, modelId),
    );
}

export function sweepStaleEmbeddingIdentitiesForProject(
    db: Database,
    projectIdentity: string,
    now = Date.now(),
): StaleEmbeddingSweepResult {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    const result: StaleEmbeddingSweepResult = {
        memoryRowsDeleted: 0,
        commitRowsDeleted: 0,
        chunkRowsDeleted: 0,
        trackingRowsDeleted: 0,
    };
    if (!snapshot) return result;

    // A degraded/untrusted config load must never drive deletion: the snapshot
    // we'd GC against may be last-known-good while the on-disk config is broken
    // or mid-migration. Reads keep serving the cached vectors; GC waits until a
    // trusted register clears the latch.
    if (untrustedLoadProjects.has(projectIdentity)) return result;

    const cutoff = now - EMBEDDING_IDENTITY_GC_GRACE_MS;
    const deleteTracking = getDeleteActiveIdentityStatement(db);
    const currentModelId = snapshot.chunkModelId;

    // One invocation removes at most one bounded batch. Keeping the stale
    // identity marker until its final vector is gone makes later timer ticks
    // resume safely without holding a writer lock across the whole backlog.
    let remainingBudget = STALE_EMBEDDING_GC_BATCH_SIZE;
    db.exec("BEGIN IMMEDIATE");
    try {
        if (snapshot.enabled && currentModelId !== "off") {
            for (const modelId of staleModelsForScope(
                db,
                projectIdentity,
                currentModelId,
                cutoff,
            )) {
                if (remainingBudget === 0) break;
                const deleted = deleteStaleChunkEmbeddingBatch(
                    db,
                    projectIdentity,
                    modelId,
                    remainingBudget,
                );
                remainingBudget -= deleted;
                result.chunkRowsDeleted += deleted;

                if (!hasStaleChunkEmbeddingRows(db, projectIdentity, modelId)) {
                    result.trackingRowsDeleted += deleteTracking.run(
                        projectIdentity,
                        "chunk",
                        modelId,
                    ).changes;
                } else if (deleted === 0) {
                    // Avoid spinning through an unexpectedly undeletable backlog.
                    remainingBudget = 0;
                }
            }
        }
        db.exec("COMMIT");
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // The transaction may already be closed by SQLite after a fatal error.
        }
        throw error;
    }

    return result;
}

export function registerProjectEmbedding(
    db: Database,
    projectIdentity: string,
    config: EmbeddingConfig,
    features: EmbeddingFeatures,
    sourceDirectory: string,
): ProjectEmbeddingRegistrationSnapshot {
    const resolvedConfig = resolveEmbeddingConfig(config);
    const providerIdentity = getEmbeddingProviderIdentity(resolvedConfig);
    const runtimeFingerprint = getRuntimeFingerprint(resolvedConfig);
    const chunkModelId = getChunkEmbeddingModelId(resolvedConfig, providerIdentity);
    const prior = projectRegistrations.get(projectIdentity);
    const canReuseProvider =
        prior !== undefined &&
        !prior.observationMode &&
        prior.runtimeFingerprint === runtimeFingerprint &&
        prior.providerIdentity === providerIdentity;
    recordActiveEmbeddingIdentity(db, projectIdentity, chunkModelId);
    // A trusted registration just landed — clear any prior untrusted-load latch
    // so GC can resume for this project.
    untrustedLoadProjects.delete(projectIdentity);
    const generationChanged =
        prior === undefined ||
        prior.observationMode ||
        prior.runtimeFingerprint !== runtimeFingerprint ||
        prior.chunkModelId !== chunkModelId ||
        !sameFeatures(prior.features, features);
    const generation = generationChanged ? ++globalRegistrationGeneration : prior.generation;
    const registration: ProjectEmbeddingRegistration = {
        projectIdentity,
        sourceDirectory,
        config: resolvedConfig,
        providerIdentity,
        runtimeFingerprint,
        provider: canReuseProvider ? prior.provider : null,
        generation,
        features: { ...features },
        modelId: providerIdentity === OFF_PROVIDER_IDENTITY ? "off" : providerIdentity,
        chunkModelId: providerIdentity === OFF_PROVIDER_IDENTITY ? "off" : chunkModelId,
        observationMode: false,
    };

    projectRegistrations.set(projectIdentity, registration);

    if (!canReuseProvider) {
        disposeProvider(prior?.provider ?? null);
    }

    return snapshotFor(registration);
}

export function registerProjectInObservationMode(
    db: Database,
    projectIdentity: string,
    sourceDirectory: string,
    failedConfig: EmbeddingConfig,
    failureSummary: string,
): ProjectEmbeddingRegistrationSnapshot {
    void db;
    const prior = projectRegistrations.get(projectIdentity);
    const runtimeFingerprint = `observation:${sha256Prefix(failureSummary)}`;
    const generation =
        prior?.runtimeFingerprint === runtimeFingerprint && prior.observationMode
            ? prior.generation
            : ++globalRegistrationGeneration;
    const registration: ProjectEmbeddingRegistration = {
        projectIdentity,
        sourceDirectory,
        config: resolveEmbeddingConfig(failedConfig),
        providerIdentity: OFF_PROVIDER_IDENTITY,
        runtimeFingerprint,
        provider: null,
        generation,
        features: { memoryEnabled: false, gitCommitEnabled: false },
        modelId: "off",
        chunkModelId: "off",
        observationMode: true,
    };

    projectRegistrations.set(projectIdentity, registration);
    disposeProvider(prior?.provider ?? null);

    return snapshotFor(registration);
}

export function getProjectEmbeddingSnapshot(
    projectIdentity: string,
): ProjectEmbeddingRegistrationSnapshot | null {
    const registration = projectRegistrations.get(projectIdentity);
    return registration ? snapshotFor(registration) : null;
}

export function getProjectChunkEmbeddingModelId(projectIdentity: string): string {
    const registration = projectRegistrations.get(projectIdentity);
    return registration && !registration.observationMode ? registration.chunkModelId : "off";
}

export function getProjectEmbeddingMaxInputTokens(projectIdentity: string): number {
    const registration = projectRegistrations.get(projectIdentity);
    const configMax =
        registration?.config && "max_input_tokens" in registration.config
            ? registration.config.max_input_tokens
            : undefined;
    return normalizeCompartmentChunkMaxInputTokens(
        registration?.provider?.maxInputTokens ?? configMax,
    );
}

function getOrCreateProjectProvider(
    registration: ProjectEmbeddingRegistration,
): EmbeddingProvider | null {
    if (registration.providerIdentity === OFF_PROVIDER_IDENTITY || registration.observationMode) {
        return null;
    }
    if (registration.provider) {
        return registration.provider;
    }
    const provider = createProvider(registration.config, {
        projectRoot: registration.sourceDirectory,
        session: `project:${registration.projectIdentity}`,
    });
    registration.provider = provider;
    return provider;
}

export async function embedTextForProject(
    projectIdentity: string,
    text: string,
    signal?: AbortSignal,
    purpose: EmbeddingPurpose = "passage",
): Promise<{
    vector: Float32Array;
    modelId: string;
    chunkModelId: string;
    generation: number;
} | null> {
    const registration = projectRegistrations.get(projectIdentity);
    if (!registration) return null;
    const generation = registration.generation;
    const modelId = registration.modelId;
    const provider = getOrCreateProjectProvider(registration);
    if (!provider) return null;

    const vector = await provider.embed(text, signal, purpose);
    if (!vector) return null;

    const current = projectRegistrations.get(projectIdentity);
    if (
        !current ||
        current.generation !== generation ||
        current.runtimeFingerprint !== registration.runtimeFingerprint
    ) {
        return null;
    }

    return { vector, modelId, chunkModelId: registration.chunkModelId, generation };
}

export async function embedBatchForProject(
    projectIdentity: string,
    texts: string[],
    signal?: AbortSignal,
    purpose: EmbeddingPurpose = "passage",
): Promise<{ vectors: (Float32Array | null)[]; modelId: string; generation: number } | null> {
    if (texts.length === 0) {
        const registration = projectRegistrations.get(projectIdentity);
        if (!registration || registration.observationMode) return null;
        return { vectors: [], modelId: registration.modelId, generation: registration.generation };
    }

    const registration = projectRegistrations.get(projectIdentity);
    if (!registration) return null;
    const generation = registration.generation;
    const modelId = registration.modelId;
    const runtimeFingerprint = registration.runtimeFingerprint;
    const provider = getOrCreateProjectProvider(registration);
    if (!provider) return null;

    const vectors = await provider.embedBatch(texts, signal, purpose);
    const current = projectRegistrations.get(projectIdentity);
    if (
        !current ||
        current.generation !== generation ||
        current.runtimeFingerprint !== runtimeFingerprint
    ) {
        return null;
    }

    return { vectors, modelId, generation };
}

export async function embedItemsForProject(
    projectIdentity: string,
    items: readonly { id: string; text: string; contentSha256: string }[],
    signal?: AbortSignal,
    db?: Database,
    sessionId = projectIdentity,
): Promise<{ vectors: Map<string, Float32Array>; modelId: string; generation: number } | null> {
    void db;
    void sessionId;
    const registration = projectRegistrations.get(projectIdentity);
    if (!registration || registration.observationMode || items.length === 0) return null;
    const generation = registration.generation;
    const modelId = registration.modelId;
    const runtimeFingerprint = registration.runtimeFingerprint;
    const provider = getOrCreateProjectProvider(registration);
    if (!provider) return null;

    let vectors: Map<string, Float32Array>;
    try {
        if (provider.embedItems) {
            vectors = await provider.embedItems(items, signal);
        } else {
            const positional = await provider.embedBatch(
                items.map((item) => item.text),
                signal,
                "passage",
            );
            vectors = new Map(
                items.flatMap((item, index) => {
                    const vector = positional[index];
                    return vector ? [[item.id, vector] as const] : [];
                }),
            );
        }
    } catch (error) {
        log("[magic-context] embedding batch failed:", error);
        return null;
    }

    const current = projectRegistrations.get(projectIdentity);
    if (
        !current ||
        current.generation !== generation ||
        current.runtimeFingerprint !== runtimeFingerprint
    ) {
        return null;
    }
    return { vectors, modelId, generation };
}

/** Keep domain items bounded to the same per-call window cap used by positional providers. */
async function embedItemsWindowBounded(
    projectIdentity: string,
    items: readonly { id: string; text: string; contentSha256: string }[],
    signal?: AbortSignal,
    db?: Database,
): Promise<Awaited<ReturnType<typeof embedItemsForProject>>> {
    if (items.length <= MAX_WINDOWS_PER_EMBED_CALL) {
        return embedItemsForProject(projectIdentity, items, signal, db, projectIdentity);
    }
    const vectors = new Map<string, Float32Array>();
    let modelId: string | null = null;
    let generation: number | null = null;
    for (let start = 0; start < items.length; start += MAX_WINDOWS_PER_EMBED_CALL) {
        const result = await embedItemsForProject(
            projectIdentity,
            items.slice(start, start + MAX_WINDOWS_PER_EMBED_CALL),
            signal,
            db,
            projectIdentity,
        );
        if (!result) return null;
        if (modelId === null) {
            modelId = result.modelId;
            generation = result.generation;
        } else if (modelId !== result.modelId || generation !== result.generation) {
            return null;
        }
        for (const [id, vector] of result.vectors) vectors.set(id, vector);
    }
    return modelId === null || generation === null ? null : { vectors, modelId, generation };
}

interface CandidateChunkBatchResult {
    /** Compartments fully embedded + persisted this call. */
    embedded: number;
    /** Candidates that yielded NO embeddable work (empty canonical text or
     *  windows already current) — they are not failures and the session drain
     *  must skip past them rather than re-select them forever. */
    noWork: number[];
    /** Candidates the provider could not embed this call even after retries
     *  (returned no/partial vectors). NOT permanent: excluded for the rest of
     *  THIS run so the cursor advances, but re-attempted on a future run. */
    failed: number[];
}

/** Embed + persist chunk vectors for an already-selected candidate batch.
 *  Provider calls are sub-batched by window count
 *  (`MAX_WINDOWS_PER_EMBED_CALL`) so a single large compartment (or a big
 *  `batchSize`) can't build one enormous payload tensor. Each compartment is the
 *  atomic persist unit — its windows are never split across provider calls. */
async function embedCandidateChunkBatch(
    db: Database,
    projectIdentity: string,
    modelId: string,
    candidates: CompartmentChunkBackfillCandidate[],
    signal?: AbortSignal,
): Promise<CandidateChunkBatchResult> {
    const noWork: number[] = [];
    const failed: number[] = [];
    if (candidates.length === 0) return { embedded: 0, noWork, failed };
    const maxInputTokens = getProjectEmbeddingMaxInputTokens(projectIdentity);

    type Prepared = {
        candidate: CompartmentChunkBackfillCandidate;
        windows: ReturnType<typeof chunkCanonicalText>;
    };
    const prepared: Prepared[] = [];
    for (const candidate of candidates) {
        const canonicalText =
            buildCanonicalChunkTextFromFts(
                db,
                candidate.sessionId,
                candidate.startMessage,
                candidate.endMessage,
            ) || buildCompartmentSummaryFallbackText(db, candidate.id);
        if (canonicalText.length === 0) {
            noWork.push(candidate.id);
            continue;
        }
        const windows = chunkCanonicalText(
            canonicalText,
            candidate.startMessage,
            candidate.endMessage,
            maxInputTokens,
        );
        if (
            windows.length === 0 ||
            chunkEmbeddingWindowsAreCurrent(db, candidate.id, modelId, windows, projectIdentity)
        ) {
            noWork.push(candidate.id);
            continue;
        }
        prepared.push({ candidate, windows });
    }

    if (prepared.length === 0) return { embedded: 0, noWork, failed };

    let embedded = 0;
    let i = 0;
    while (i < prepared.length) {
        if (signal?.aborted) break;
        const slice: Prepared[] = [];
        let windowCount = 0;
        do {
            const item = prepared[i];
            slice.push(item);
            windowCount += item.windows.length;
            i += 1;
        } while (
            i < prepared.length &&
            windowCount + prepared[i].windows.length <= MAX_WINDOWS_PER_EMBED_CALL
        );

        const items = slice.flatMap((item) =>
            item.windows.map((window) => ({
                id: `chunk:${item.candidate.id}:${window.windowIndex}`,
                text: window.text,
                contentSha256: contentSha256(window.text),
            })),
        );

        const persistedIds = new Set<number>();
        for (let attempt = 0; attempt < EMBED_SLICE_RETRY_ATTEMPTS; attempt++) {
            if (signal?.aborted) break;
            let result: Awaited<ReturnType<typeof embedItemsForProject>> = null;
            const attemptStart = Date.now();
            try {
                result = await embedItemsWindowBounded(projectIdentity, items, signal, db);
            } catch (error) {
                log("[magic-context] failed to proactively embed compartment chunks:", error);
            }
            if (signal?.aborted) break;
            if (result) {
                for (const item of slice) {
                    if (persistedIds.has(item.candidate.id)) continue;
                    const vectors = item.windows.map((window) =>
                        result.vectors.get(`chunk:${item.candidate.id}:${window.windowIndex}`),
                    );
                    if (vectors.length !== item.windows.length || vectors.some((v) => !v)) {
                        continue;
                    }
                    const rows: SaveCompartmentChunkEmbeddingInput[] = item.windows.map(
                        (window, index) => ({
                            compartmentId: item.candidate.id,
                            sessionId: item.candidate.sessionId,
                            projectPath: projectIdentity,
                            window,
                            modelId,
                            vector: vectors[index] as Float32Array,
                        }),
                    );
                    replaceCompartmentChunkEmbeddings(db, rows);
                    persistedIds.add(item.candidate.id);
                }
            }
            if (persistedIds.size === slice.length) break; // whole slice done
            if (persistedIds.size > 0) break;
            if (Date.now() - attemptStart >= EMBED_SLOW_FAILURE_NO_RETRY_MS) break;
            if (attempt < EMBED_SLICE_RETRY_ATTEMPTS - 1) {
                await new Promise((resolve) =>
                    setTimeout(resolve, EMBED_SLICE_RETRY_BASE_MS * 2 ** attempt),
                );
            }
        }

        embedded += persistedIds.size;
        if (!signal?.aborted) {
            for (const item of slice) {
                if (!persistedIds.has(item.candidate.id)) failed.push(item.candidate.id);
            }
        }
    }
    return { embedded, noWork, failed };
}

export interface SessionChunkBackfillProgress {
    /** Compartments fully embedded so far this run. */
    embedded: number;
    /** Total compartments that needed embedding when the run started. */
    total: number;
}

export type SessionChunkBackfillOutcome =
    | { status: "done"; embedded: number; total: number; failed: number }
    | { status: "nothing"; embedded: 0; total: 0 }
    | { status: "disabled"; embedded: 0; total: 0 }
    | { status: "busy"; embedded: 0; total: number }
    | { status: "aborted"; embedded: number; total: number; failed: number }
    // Some candidates could not be embedded this run (provider returned no
    // vectors for them after retries) and were not skippable no-work rows —
    // surfaced so the command can tell the user it stopped early (with how many
    // failed) instead of falsely "done". `remaining` is still-embeddable count.
    | { status: "stalled"; embedded: number; total: number; remaining: number; failed: number };

/**
 * Backfill ALL un-embedded compartment chunks for ONE session in a single run
 * (the `/ctx-embed` command path), oldest-first so progress fills
 * chronologically. Unlike the passive project drain this has no per-sweep cap —
 * the user asked for the whole session. Idempotent + resumable via chunk_hash;
 * re-running embeds only what's still missing.
 */
export async function embedSessionCompartmentChunks(
    db: Database,
    projectIdentity: string,
    sessionId: string,
    options?: {
        signal?: AbortSignal;
        onProgress?: (p: SessionChunkBackfillProgress) => void;
        batchSize?: number;
    },
): Promise<SessionChunkBackfillOutcome> {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled || snapshot.chunkModelId === "off") {
        return { status: "disabled", embedded: 0, total: 0 };
    }
    // The session command path resolves this identity from the host session;
    // persist it before counting so stale rows under another project cannot make
    // this session look already embedded forever.
    recordSessionProjectIdentity(db, sessionId, projectIdentity);
    const total = countUnembeddedSessionCompartments(
        db,
        projectIdentity,
        sessionId,
        snapshot.chunkModelId,
    );
    if (total === 0) return { status: "nothing", embedded: 0, total: 0 };

    const drainAbort = new AbortController();
    const forwardCallerAbort = (): void => drainAbort.abort();
    if (options?.signal?.aborted) drainAbort.abort();
    else options?.signal?.addEventListener("abort", forwardCallerAbort, { once: true });

    const batchSize = Math.max(1, options?.batchSize ?? 8);
    const skipIds: number[] = [];
    const failedIds: number[] = [];
    let embedded = 0;
    let aborted = false;
    let providerDown = false;
    let consecutiveFailedBatches = 0;
    try {
        options?.onProgress?.({ embedded, total });
        for (;;) {
            if (drainAbort.signal.aborted) {
                aborted = true;
                break;
            }
            const candidates = loadUnembeddedSessionChunkCandidates(
                db,
                projectIdentity,
                sessionId,
                snapshot.chunkModelId,
                batchSize,
                [...skipIds, ...failedIds],
            );
            if (candidates.length === 0) break;
            const {
                embedded: n,
                noWork,
                failed,
            } = await embedCandidateChunkBatch(
                db,
                projectIdentity,
                snapshot.chunkModelId,
                candidates,
                drainAbort.signal,
            );
            for (const id of noWork) skipIds.push(id);
            for (const id of failed) failedIds.push(id);

            if (n === 0 && noWork.length === 0) {
                consecutiveFailedBatches += 1;
                if (consecutiveFailedBatches >= MAX_CONSECUTIVE_FAILED_BATCHES) {
                    providerDown = true;
                    break;
                }
            } else {
                consecutiveFailedBatches = 0;
            }

            embedded += n;
            options?.onProgress?.({ embedded: Math.min(embedded, total), total });
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    } finally {
        options?.signal?.removeEventListener("abort", forwardCallerAbort);
    }
    if (aborted) return { status: "aborted", embedded, total, failed: failedIds.length };
    if (providerDown || failedIds.length > 0) {
        const remaining = Math.max(
            0,
            countUnembeddedSessionCompartments(
                db,
                projectIdentity,
                sessionId,
                snapshot.chunkModelId,
            ) - skipIds.length,
        );
        if (remaining > 0) {
            return { status: "stalled", embedded, total, remaining, failed: failedIds.length };
        }
    }
    return { status: "done", embedded, total, failed: failedIds.length };
}

export interface EmbeddingCoverageStatus {
    enabled: boolean;
    model: string;
    provider: string;
    session: { embedded: number; total: number };
    memories: { embedded: number; total: number };
    commits: { embedded: number; total: number; gitEnabled: boolean };
}

export function getEmbeddingCoverageStatus(
    db: Database,
    projectIdentity: string,
    sessionId: string,
): EmbeddingCoverageStatus {
    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled || snapshot.chunkModelId === "off") {
        return {
            enabled: false,
            model: snapshot?.model ?? "off",
            provider: snapshot?.provider ?? "off",
            session: { embedded: 0, total: 0 },
            memories: { embedded: 0, total: 0 },
            commits: { embedded: 0, total: 0, gitEnabled: false },
        };
    }
    const session = countSessionCompartmentEmbedCoverage(
        db,
        projectIdentity,
        sessionId,
        snapshot.chunkModelId,
    );
    return {
        enabled: true,
        model: snapshot.model,
        provider: snapshot.provider,
        session,
        memories: { embedded: 0, total: 0 },
        commits: { embedded: 0, total: 0, gitEnabled: false },
    };
}

export function _setTestProviderFactoryForProject(
    factory: ((config: EmbeddingConfig) => EmbeddingProvider | null) | null,
): void {
    testProviderFactory = factory;
}

export function _resetProjectEmbeddingRegistryForTests(): void {
    for (const registration of projectRegistrations.values()) {
        disposeProvider(registration.provider);
    }
    projectRegistrations.clear();
    untrustedLoadProjects.clear();
    globalRegistrationGeneration = 0;
    testProviderFactory = null;
}
