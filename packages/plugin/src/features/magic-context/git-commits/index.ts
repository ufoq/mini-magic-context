export type { GitCommit, ReadGitCommitsOptions } from "./git-log-reader";
export { parseGitLogOutput, readGitCommits } from "./git-log-reader";
export {
    _resetIndexerGuards,
    type IndexCommitsOptions,
    type IndexCommitsResult,
    indexCommitsForProject,
} from "./indexer";
export {
    type GitCommitSearchHit,
    type SearchGitCommitsOptions,
    searchGitCommitsSync,
} from "./search-git-commits";
export {
    enforceProjectCap,
    getCommitCount,
    getLatestIndexedCommitTimeMs,
    type StoredGitCommit,
    upsertCommits,
} from "./storage-git-commits";
export {
    acquireGitSweepLease,
    GIT_SWEEP_COOLDOWN_MS,
    GIT_SWEEP_LEASE_RENEWAL_MS,
    GIT_SWEEP_LEASE_TTL_MS,
    type GitSweepCoordinatorState,
    type GitSweepLeaseResult,
    getGitSweepCoordinatorState,
    markGitSweepSuccessAndRelease,
    parkGitSweepNonIndexable,
    releaseGitSweepLease,
    renewGitSweepLease,
} from "./sweep-coordinator";
