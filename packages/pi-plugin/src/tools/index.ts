/**
 * Pi-side tool registration.
 *
 * Registers the mini journal tool surface against the live Pi extension API.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextDatabase } from "@ufoq/mini-magic-context-core/features/magic-context/storage";
import { createCtxExpandTool } from "./ctx-expand";
import { createCtxSearchTool } from "./ctx-search";

export interface RegisterToolsOptions {
	db: ContextDatabase;
	ensureProjectRegistered?: (
		directory: string,
		db: ContextDatabase,
	) => Promise<void>;
	embeddingEnabled?: boolean;
	sessionScopedToolsDisabled?: boolean;
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
}
