import type { BuiltinCommandConfig } from "./types";

export function getMagicContextBuiltinCommands(): BuiltinCommandConfig {
    return {
        "mc-import-context": {
            template: "mc-import-context",
            description:
                "Import this session's legacy Magic Context compartments into mini-magic-context",
        },
        "ctx-status": {
            template: "ctx-status",
            description: "Show magic context status, pending queue, cache TTL, and debug info",
        },
        "ctx-recomp": {
            template: "ctx-recomp",
            description:
                "Rebuild compartments and facts from raw history (full or <start>-<end> range)",
        },
        "ctx-wrapup": {
            template: "ctx-wrapup",
            description: "Compact older live history while keeping the newest messages raw",
        },
        "ctx-flush": {
            template: "ctx-flush",
            description: "Force-process all pending magic context operations immediately",
        },
        "ctx-embed": {
            template: "ctx-embed",
            description:
                "Embedding status, or start/pause history compartment embedding (start | pause)",
        },
    };
}
