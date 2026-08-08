/**
 * Commit indexer — bridges `git log` output into the plugin's storage.
 *
 * Public entry points:
 *   - indexCommitsForProject() — sweep HEAD, upsert, evict to cap
 *
 * Concurrency: guarded by a singleton in-progress flag scoped to
 * (projectPath, operation) so the dream timer can't spawn parallel
 * sweeps of the same project.
 */

import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { readGitCommitsResult } from "./git-log-reader";
import {
    enforceProjectCap,
    getLatestIndexedCommitTimeMs,
    upsertCommits,
} from "./storage-git-commits";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Max commits indexed per sweep invocation — bounds wall-clock cost. */
const _INDEX_MAX_PER_SWEEP = 500;

const indexInProgress = new Set<string>();

export interface IndexCommitsOptions {
    sinceDays: number;
    maxCommits: number;
    /** If true, skip the index step. Retained for call-site compatibility. Default false. */
    skipEmbed?: boolean;
}

export interface IndexCommitsResult {
    scanned: number;
    inserted: number;
    updated: number;
    evicted: number;
    embedded: number;
    /**
     * Set when `git log` failed structurally (directory is not a repo, or the
     * repo has no commits yet). The sweep uses this to park the project on a
     * long re-probe cooldown instead of retrying every tick.
     */
    nonIndexable: boolean;
}

/**
 * Sweep commits from `directory` (must be a git repo), upsert them for
 * `projectPath`, and enforce max-commits cap.
 *
 * Safe to call repeatedly — existing commits whose message hasn't changed
 * are skipped cheaply (SQLite WHERE clause in the UPSERT).
 */
export async function indexCommitsForProject(
    db: Database,
    projectPath: string,
    directory: string,
    options: IndexCommitsOptions,
): Promise<IndexCommitsResult> {
    const result: IndexCommitsResult = {
        scanned: 0,
        inserted: 0,
        updated: 0,
        evicted: 0,
        embedded: 0,
        nonIndexable: false,
    };

    if (indexInProgress.has(projectPath)) {
        log(`[git-commits] index already in progress for ${projectPath}, skipping`);
        return result;
    }
    indexInProgress.add(projectPath);

    try {
        // Incremental: if we've seen commits before, only fetch anything newer
        // than the latest indexed commit. Otherwise use since_days cutoff.
        const latestIndexed = getLatestIndexedCommitTimeMs(db, projectPath);
        const sinceMs =
            latestIndexed !== null
                ? // subtract 1 minute for clock skew across systems
                  Math.max(latestIndexed - 60_000, Date.now() - options.sinceDays * MS_PER_DAY)
                : Date.now() - options.sinceDays * MS_PER_DAY;

        const read = await readGitCommitsResult(directory, {
            sinceMs,
            maxCommits: options.maxCommits,
            projectIdentity: projectPath,
        });
        const commits = read.commits;
        result.scanned = commits.length;

        if (read.failure === "not_a_repo" || read.failure === "no_head") {
            result.nonIndexable = true;
            return result;
        }

        if (commits.length === 0) {
            // No new commits. Still enforce the cap in case prior runs overflowed.
            result.evicted = enforceProjectCap(db, projectPath, options.maxCommits);
            log(
                `[git-commits] no new commits for ${projectPath} (sinceMs=${sinceMs} latestIndexed=${latestIndexed ?? "none"} evicted=${result.evicted})`,
            );
            return result;
        }

        log(
            `[git-commits] read ${commits.length} commits for ${projectPath} (sinceMs=${sinceMs} latestIndexed=${latestIndexed ?? "none"})`,
        );

        const upsert = upsertCommits(db, projectPath, commits);
        result.inserted = upsert.inserted;
        result.updated = upsert.updated;
        result.evicted = enforceProjectCap(db, projectPath, options.maxCommits);

        log(
            `[git-commits] indexed ${projectPath}: scanned=${result.scanned} inserted=${result.inserted} updated=${result.updated} evicted=${result.evicted} embedded=0 (commit embedding retired)`,
        );
        return result;
    } finally {
        indexInProgress.delete(projectPath);
    }
}

/** Test-only: reset in-progress guards. */
export function _resetIndexerGuards(): void {
    indexInProgress.clear();
}
