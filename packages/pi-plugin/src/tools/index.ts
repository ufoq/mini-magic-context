/**
 * Pi-side tool registration.
 *
 * Registers the mini journal tool surface against the live Pi extension API.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { createCtxExpandTool } from "./ctx-expand";
import { createCtxSearchTool } from "./ctx-search";
import { registerTodosCommand } from "./todo-view-pi";
import { createTodowriteTool } from "./todowrite";

export interface RegisterToolsOptions {
	db: ContextDatabase;
	ensureProjectRegistered?: (
		directory: string,
		db: ContextDatabase,
	) => Promise<void>;
	embeddingEnabled?: boolean;
	sessionScopedToolsDisabled?: boolean;
	/** When false, omit Magic Context's Pi todowrite tool entirely. */
	todowriteEnabled?: boolean;
	/** Main Pi entry registers /todos; lean subagent entries keep commands off. */
	todowriteCommandEnabled?: boolean;
}

export function registerMagicContextTools(
	pi: ExtensionAPI,
	opts: RegisterToolsOptions,
): void {
	pi.registerTool(
		createCtxSearchTool({
			db: opts.db,
			ensureProjectRegistered: opts.ensureProjectRegistered,
			embeddingEnabled: opts.embeddingEnabled,
		}),
	);

	if (!opts.sessionScopedToolsDisabled) {
		pi.registerTool(createCtxExpandTool({ db: opts.db }));
	}

	if (opts.todowriteEnabled !== false) {
		// `todowrite` parity with OpenCode. Pi-coding-agent has no built-in
		// task list tool, so without this the synthetic-todowrite injector
		// would never have anything to surface. The tool just captures the
		// `todos` arg and echoes a pretty-printed JSON ack; `message_end`
		// in index.ts snapshots `params.todos` into `session_meta.last_todo_state`
		// for downstream synthesis. See `tools/todowrite.ts` header for rationale.
		pi.registerTool(createTodowriteTool());
		if (opts.todowriteCommandEnabled !== false) {
			registerTodosCommand(pi);
		}
	}
}
