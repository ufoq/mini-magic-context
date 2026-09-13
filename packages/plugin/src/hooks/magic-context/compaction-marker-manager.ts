import type { Database } from "../../shared/sqlite";

/**
 * Pi owns compaction markers in its native session history. Shared historian
 * runners call this hook after publication, but no secondary host database is
 * mutated.
 */
export function updateCompactionMarkerAfterPublication(
    _db: Database,
    _sessionId: string,
    _lastCompartmentEnd: number,
    _directory?: string,
): boolean {
    return true;
}

export interface OrphanMarkerReconcileResult {
    removed: number;
    failed: boolean;
}

/** Pi has no foreign-host marker rows to reconcile. */
export function reconcileForkOrphanedCompactionMarkers(
    _db: Database,
    _sessionId: string,
): OrphanMarkerReconcileResult {
    return { removed: 0, failed: false };
}
