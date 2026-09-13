export interface RawMessageParts {
    id: string;
    role: string;
    parts: unknown[];
    createdAt?: number | null;
    version?: string | number | null;
}

export interface RawMessage extends RawMessageParts {
    ordinal: number;
}

export interface RawMessageOrdinalAnchor {
    timeCreated: number;
    id: string;
}

export interface RawMessageOrdinalEntry extends RawMessageOrdinalAnchor {
    contributesOrdinal: boolean;
    hasValidInfo: boolean;
}

export interface InMemoryMessageView {
    id: string;
    role: string;
    parts: unknown[];
    summary?: boolean;
    finish?: string;
}

export interface InMemoryTailResult {
    messages: RawMessage[];
    absoluteMessageCount: number;
    anchorFound: boolean;
}

/** Build absolute raw-message ordinals from Pi's current in-memory branch. */
export function buildInMemoryTailRawMessages(args: {
    messages: readonly InMemoryMessageView[];
    lastCompartmentEnd: number;
    anchorMessageId: string | null;
}): InMemoryTailResult | null {
    const { messages, lastCompartmentEnd, anchorMessageId } = args;
    const filtered = messages.filter((message) => !(message.summary && message.finish === "stop"));
    if (filtered.length === 0) return null;

    let startIndex = 0;
    let baseOrdinal = Math.max(1, lastCompartmentEnd + 1);
    let anchorFound = false;
    if (anchorMessageId) {
        const anchorIndex = filtered.findIndex((message) => message.id === anchorMessageId);
        if (anchorIndex >= 0) {
            anchorFound = true;
            startIndex = anchorIndex;
            baseOrdinal = lastCompartmentEnd;
        }
    }

    const messagesWithOrdinals: RawMessage[] = [];
    let ordinal = baseOrdinal;
    for (let index = startIndex; index < filtered.length; index += 1) {
        const message = filtered[index];
        if (!message?.id) {
            ordinal += 1;
            continue;
        }
        messagesWithOrdinals.push({
            ordinal,
            id: message.id,
            role: message.role,
            parts: message.parts,
            version: null,
        });
        ordinal += 1;
    }

    return {
        messages: messagesWithOrdinals,
        absoluteMessageCount: Math.max(0, ordinal - 1),
        anchorFound,
    };
}
