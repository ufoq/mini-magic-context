import type { ToolDefinition } from "@opencode-ai/plugin";
import type { MagicContextPluginConfig } from "../config";
import { resolveProjectIdentityForSession } from "../features/magic-context/memory/project-identity";
import {
    getDatabasePersistenceError,
    isDatabasePersisted,
    openDatabase,
} from "../features/magic-context/storage";
import { getErrorMessage } from "../shared/error-message";
import { log } from "../shared/logger";
import type { Database } from "../shared/sqlite";
import { createCtxExpandTools } from "../tools/ctx-expand";
import { createCtxSearchTools } from "../tools/ctx-search";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "./embedding-bootstrap";
import { normalizeToolArgSchemas } from "./normalize-tool-arg-schemas";
import type { PluginContext } from "./types";

export function createToolRegistry(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
}): Record<string, ToolDefinition> {
    const { ctx, pluginConfig } = args;

    if (pluginConfig.enabled !== true) {
        return {};
    }

    // Storage failure (binary ABI mismatch, unwritable path, etc.) must
    // disable Magic Context cleanly instead of silently degrading. We never
    // expose ctx_* tools when storage isn't healthy — see openDatabase()
    // for the reasoning.
    let db: Database;
    try {
        const opened = openDatabase();
        // openDatabase returns null on the schema-fence path (DB newer than this
        // binary) and throws on a fatal open error — handle both as "storage
        // unavailable, disable tools cleanly".
        if (!opened || !isDatabasePersisted(opened)) {
            const reason = getDatabasePersistenceError(opened);
            console.warn(
                `[magic-context] persistent storage unavailable; disabling magic-context tools${reason ? `: ${reason}` : ""}`,
            );
            return {};
        }
        db = opened;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // console.warn intentional: this runs during plugin init before the file logger is
        // guaranteed to be ready, and storage failure is user-visible enough to warrant stderr.
        console.warn(
            `[magic-context] persistent storage unavailable; disabling magic-context tools: ${reason}`,
        );
        return {};
    }

    // Fire-and-forget: registration failure (including a database handle that
    // closed during process teardown) must never surface as an unhandled
    // rejection from plugin init. The next boot or embed path re-registers.
    void ensureProjectRegisteredFromOpenCodeDirectory(ctx.directory, db).catch((error) => {
        log(`[magic-context] embedding registration skipped: ${getErrorMessage(error)}`);
    });

    // Tools resolve project per-call from `toolContext.directory` because
    // OpenCode's top-level `ctx.directory` reflects the launch dir, not the
    // session's actual working directory (e.g. when launched via
    // `opencode -s <id>` from outside the project).
    const resolveProjectPath = (directory: string) => resolveProjectIdentityForSession(directory);

    const allTools: Record<string, ToolDefinition> = {
        ...createCtxExpandTools({ db }),
        ...createCtxSearchTools({
            db,
            resolveProjectPath,
            ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
        }),
    };

    // Patch arg schemas so property-level .describe() text survives JSON Schema serialization.
    // Without this, the LLM sees bare types with no description for each parameter.
    for (const toolDefinition of Object.values(allTools)) {
        normalizeToolArgSchemas(toolDefinition);
    }

    return allTools;
}
