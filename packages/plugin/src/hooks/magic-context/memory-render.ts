/**
 * Legacy memory / user-profile / workspace / mural rendering helpers.
 *
 * Mini keeps the compartment injection path structurally free of project-memory,
 * user-profile, workspace, and mural rendering (the m[0]/m[1] renderers emit only
 * project docs + compartments). These helpers are retained only for the
 * production-dead consumers that still typecheck against them (m0-token-breakdown,
 * mural-selection) and for tests. Nothing on the live injection path imports this
 * module.
 */
import { escapeXmlAttr, escapeXmlContent } from "../../features/magic-context/compartment-storage";
import { V2_MEMORY_CATEGORIES } from "../../features/magic-context/memory/constants";
import type { Memory } from "../../features/magic-context/memory/types";
import type { UserMemory } from "../../features/magic-context/user-memory/storage-user-memory";
import type { WorkspaceIdentitySet } from "../../features/magic-context/workspaces";
import { sessionLog } from "../../shared/logger";
import { estimateTokens } from "./read-session-formatting";

export interface WorkspaceRenderContext {
    identities: string[];
    expandedIdentities: string[];
    ownIdentities: string[];
    shareCategories: string[] | null;
    namesByIdentity: Map<string, string>;
    canonicalIdentityByStoredPath: Map<string, string>;
    isWorkspaced: boolean;
}

export interface MemoryRenderOptions {
    sourceNameByMemoryId?: ReadonlyMap<number, string>;
}

export function memorySelectionOrder(left: Memory, right: Memory): number {
    if (left.status === "permanent" && right.status !== "permanent") return -1;
    if (right.status === "permanent" && left.status !== "permanent") return 1;
    const leftImportance = left.importance ?? Number.NEGATIVE_INFINITY;
    const rightImportance = right.importance ?? Number.NEGATIVE_INFINITY;
    const importanceDiff = rightImportance - leftImportance;
    if (importanceDiff !== 0) return importanceDiff;
    return left.id - right.id;
}

export function memoryRenderOrder(left: Memory, right: Memory): number {
    const leftPriority = V2_MEMORY_CATEGORIES.indexOf(
        left.category as (typeof V2_MEMORY_CATEGORIES)[number],
    );
    const rightPriority = V2_MEMORY_CATEGORIES.indexOf(
        right.category as (typeof V2_MEMORY_CATEGORIES)[number],
    );
    if (leftPriority >= 0 || rightPriority >= 0) {
        if (leftPriority < 0) return 1;
        if (rightPriority < 0) return -1;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    } else if (left.category !== right.category) {
        return left.category < right.category ? -1 : 1;
    }
    return left.id - right.id;
}

/**
 * Incremental token accounting for the grouped memory block. Trimming probes
 * hundreds of candidates against the budget; re-rendering and re-tokenizing the
 * whole block per probe is O(n²) in tokenizer passes. Instead: measure the
 * wrapper once, each candidate line once, and each category's open/close tags
 * once when that category first appears. BPE merges across the newline joins can
 * only shrink the whole relative to the sum of its parts, so this additive
 * account is a slight UPPER bound on the rendered block.
 */
export function createMemoryBlockAccounting(renderOptions: MemoryRenderOptions) {
    const seenCategories = new Set<string>();
    const categoryCost = new Map<string, number>();
    return {
        usedTokens: estimateTokens("<project-memory>\n</project-memory>"),
        candidateCost(memory: Memory): number {
            const line = renderMemoryLineV2(
                memory,
                renderOptions.sourceNameByMemoryId?.get(memory.id),
            );
            let cost = estimateTokens(`${line}\n`);
            if (!seenCategories.has(memory.category)) {
                let tags = categoryCost.get(memory.category);
                if (tags === undefined) {
                    tags = estimateTokens(
                        `<${escapeXmlAttr(memory.category)}>\n</${escapeXmlAttr(memory.category)}>\n`,
                    );
                    categoryCost.set(memory.category, tags);
                }
                cost += tags;
            }
            return cost;
        },
        admit(memory: Memory, cost: number): void {
            this.usedTokens += cost;
            seenCategories.add(memory.category);
        },
    };
}

/** Render one compact memory fact line. Importance still controls selection, but
 * is deliberately absent from the wire so classification-only updates do not change bytes. */
export function renderMemoryLineV2(memory: Memory, sourceName?: string): string {
    const source = sourceName ? ` [${escapeXmlContent(sourceName)}]` : "";
    return `#${memory.id}${source}: ${escapeXmlContent(memory.content)}`;
}

export function renderMemoryBlockV2(
    memories: Memory[],
    wrapper = "project-memory",
    renderOptions: MemoryRenderOptions = {},
): string {
    if (memories.length === 0) return "";
    const ordered = [...memories].sort(memoryRenderOrder);
    const lines = [`<${wrapper}>`];
    let openCategory: string | undefined;
    for (const memory of ordered) {
        if (memory.category !== openCategory) {
            if (openCategory !== undefined) lines.push(`</${escapeXmlAttr(openCategory)}>`);
            openCategory = memory.category;
            lines.push(`<${escapeXmlAttr(openCategory)}>`);
        }
        lines.push(renderMemoryLineV2(memory, renderOptions.sourceNameByMemoryId?.get(memory.id)));
    }
    if (openCategory !== undefined) lines.push(`</${escapeXmlAttr(openCategory)}>`);
    lines.push(`</${wrapper}>`);
    return lines.join("\n");
}

export interface TrimMemoriesResultV2 {
    selected: Memory[];
    renderOrder: Memory[];
}

export function trimMemoriesToBudgetV2(
    sessionId: string,
    memories: Memory[],
    budgetTokens: number,
    renderOptions: MemoryRenderOptions = {},
): TrimMemoriesResultV2 {
    const selectionOrder = [...memories].sort(memorySelectionOrder);
    const selected: Memory[] = [];
    const accounting = createMemoryBlockAccounting(renderOptions);

    for (const memory of selectionOrder) {
        const cost = accounting.candidateCost(memory);
        if (accounting.usedTokens + cost > budgetTokens) continue;
        accounting.admit(memory, cost);
        selected.push(memory);
    }

    if (selected.length < memories.length) {
        sessionLog(
            sessionId,
            `v2 trimmed memories from ${memories.length} to ${selected.length} to fit injection budget of ${budgetTokens} tokens`,
        );
    }

    const renderOrder = [...selected].sort(memoryRenderOrder);

    return { selected, renderOrder };
}

function resolveStoredPathWorkspaceIdentity(
    storedPath: string | null | undefined,
    identities: readonly string[],
    canonicalIdentityByStoredPath: ReadonlyMap<string, string>,
): string | null {
    if (!storedPath) return null;
    const canonical = canonicalIdentityByStoredPath.get(storedPath);
    if (canonical && identities.includes(canonical)) return canonical;
    return identities.includes(storedPath) ? storedPath : null;
}

function memoryCanonicalIdentity(memory: Memory, workspace: WorkspaceRenderContext): string | null {
    return resolveStoredPathWorkspaceIdentity(
        memory.projectPath,
        workspace.identities,
        workspace.canonicalIdentityByStoredPath,
    );
}

export function trimWorkspaceMemoriesToBudgetV2(
    sessionId: string,
    memories: Memory[],
    budgetTokens: number,
    workspace: WorkspaceRenderContext,
    renderOptions: MemoryRenderOptions = {},
): TrimMemoriesResultV2 {
    if (!workspace.isWorkspaced) {
        return trimMemoriesToBudgetV2(sessionId, memories, budgetTokens, renderOptions);
    }

    const selected: Memory[] = [];
    const selectedIds = new Set<number>();
    const accounting = createMemoryBlockAccounting(renderOptions);
    const trySelect = (memory: Memory): boolean => {
        if (selectedIds.has(memory.id)) return false;
        const cost = accounting.candidateCost(memory);
        if (accounting.usedTokens + cost > budgetTokens) return false;
        selected.push(memory);
        selectedIds.add(memory.id);
        accounting.admit(memory, cost);
        return true;
    };

    for (const memory of memories
        .filter((candidate) => candidate.status === "permanent")
        .sort(memorySelectionOrder)) {
        trySelect(memory);
    }

    const remainingAfterPermanent = Math.max(0, budgetTokens - accounting.usedTokens);
    const floorTokens = remainingAfterPermanent / Math.max(1, workspace.identities.length);
    const byIdentity = new Map<string, Memory[]>();
    for (const memory of memories) {
        if (memory.status === "permanent") continue;
        const identity = memoryCanonicalIdentity(memory, workspace);
        if (!identity) continue;
        const list = byIdentity.get(identity) ?? [];
        list.push(memory);
        byIdentity.set(identity, list);
    }

    for (const identity of workspace.identities) {
        let memberTokens = 0;
        const candidates = (byIdentity.get(identity) ?? []).sort(memorySelectionOrder);
        for (const memory of candidates) {
            if (selectedIds.has(memory.id)) continue;
            const cost = accounting.candidateCost(memory);
            if (memberTokens + cost > floorTokens) continue;
            if (accounting.usedTokens + cost > budgetTokens) continue;
            selected.push(memory);
            selectedIds.add(memory.id);
            accounting.admit(memory, cost);
            memberTokens += cost;
        }
    }

    const remaining = memories
        .filter((memory) => !selectedIds.has(memory.id))
        .sort(memorySelectionOrder);
    for (const memory of remaining) {
        trySelect(memory);
    }

    if (selected.length < memories.length) {
        sessionLog(
            sessionId,
            `v2 trimmed memories from ${memories.length} to ${selected.length} to fit injection budget of ${budgetTokens} tokens`,
        );
    }

    return { selected, renderOrder: [...selected].sort(memoryRenderOrder) };
}

export function renderUserProfileBlock(memories: UserMemory[], wrapper = "user-profile"): string {
    if (memories.length === 0) return "";
    const lines = [`<${wrapper}>`];
    for (const memory of memories) {
        lines.push(`- ${escapeXmlContent(memory.content)}`);
    }
    lines.push(`</${wrapper}>`);
    return lines.join("\n");
}

export function trimUserMemoriesToBudget(
    memories: UserMemory[],
    budgetTokens: number,
): UserMemory[] {
    const selected: UserMemory[] = [];
    let usedTokens = 0;
    for (const memory of memories) {
        const tokens = estimateTokens(`- ${memory.content}`) + 4;
        if (usedTokens + tokens > budgetTokens) continue;
        selected.push(memory);
        usedTokens += tokens;
    }
    return selected;
}

export type { UserMemory, WorkspaceIdentitySet };
