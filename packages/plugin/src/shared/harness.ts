/** Mini Magic Context runs only inside Pi. */
export type HarnessId = "pi";

/** Retained as an idempotent boot assertion for callers that initialize host state. */
export function setHarness(value: HarnessId): void {
    if (value !== "pi") throw new Error(`Unsupported harness: ${String(value)}`);
}

export function getHarness(): HarnessId {
    return "pi";
}

/** Test helper retained for source compatibility; Pi identity is immutable. */
export function _resetHarnessForTesting(): void {
    // No mutable harness state.
}
