/**
 * Shared historian runners call this after publishing compartments. Pi keeps
 * its render cache in the Pi adapter, so the shared core has no cache to clear.
 */
export function clearInjectionCache(_sessionId: string): void {
    // No shared host cache.
}
