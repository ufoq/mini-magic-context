export interface WorkMetrics {
    newWorkTokens: number;
    totalInputTokens: number;
}

export interface PiSessionEntry {
    role?: unknown;
    usage?: unknown;
    message?: unknown;
}

interface PiUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

function asNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getPiUsage(entry: unknown): PiUsage | null {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    const message =
        record.message && typeof record.message === "object"
            ? (record.message as Record<string, unknown>)
            : record;
    if (message.role !== "assistant") return null;
    if (!message.usage || typeof message.usage !== "object") return null;
    const usage = message.usage as Record<string, unknown>;
    return {
        input: asNumber(usage.input),
        output: asNumber(usage.output),
        cacheRead: asNumber(usage.cacheRead ?? usage.cache_read),
        cacheWrite: asNumber(usage.cacheWrite ?? usage.cache_write),
    };
}

/**
 * Work metrics for a Pi session: prompt tokens that are genuinely new work
 * (sum of positive prompt deltas) plus the peak prompt of each pressure phase.
 *
 * Pi session entries are already ordered, so this is a single left-to-right
 * fold with no watermarking: a fresh pass over the entries is cheap enough that
 * incremental state is not needed.
 */
export function computePiWorkMetrics(sessionEntries: PiSessionEntry[] | unknown[]): WorkMetrics {
    let previousPrompt = 0;
    let phasePeak = 0;
    let newWorkTokens = 0;
    let totalInputTokens = 0;
    let lastOutput = 0;
    let sawAssistant = false;

    for (const entry of sessionEntries) {
        const usage = getPiUsage(entry);
        if (!usage) continue;
        const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
        if (sawAssistant && prompt < previousPrompt) {
            totalInputTokens += phasePeak;
            phasePeak = prompt;
        } else {
            phasePeak = Math.max(phasePeak, prompt);
        }
        newWorkTokens += Math.max(0, prompt - previousPrompt);
        previousPrompt = prompt;
        lastOutput = usage.output;
        sawAssistant = true;
    }

    if (sawAssistant) {
        totalInputTokens += phasePeak;
        newWorkTokens += lastOutput;
    }

    return { newWorkTokens, totalInputTokens };
}
