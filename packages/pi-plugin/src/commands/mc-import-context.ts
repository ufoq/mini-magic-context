import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	formatImportLegacySessionResult,
	importLegacySessionContext,
	parseImportSourceArg,
} from "@magic-context/core/features/magic-context/slim-import";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { readPiSessionMessages } from "../read-session-pi";
import { resolveSessionId, sendCtxStatusMessage } from "./pi-command-utils";

export function registerMcImportContextCommand(
	pi: ExtensionAPI,
	deps: {
		db: ContextDatabase;
		projectPath: string;
		resolveProject?: (ctx: { cwd: string }) => {
			projectDir: string;
			projectIdentity: string;
		};
		afterImport?: (sessionId: string) => void;
	},
): void {
	pi.registerCommand("mc-import-context", {
		description:
			"Import this session's legacy Magic Context compartments into mini-magic-context",
		handler: async (args, ctx) => {
			const sessionId = resolveSessionId(ctx);
			if (!sessionId) {
				sendCtxStatusMessage(pi, {
					title: "/mc-import-context",
					text: "## Magic Context Import\n\nNo active Pi session is available.",
					level: "error",
				});
				return;
			}

			try {
				const project = deps.resolveProject?.(ctx) ?? {
					projectDir: deps.projectPath,
					projectIdentity: deps.projectPath,
				};
				const result = importLegacySessionContext({
					targetDb: deps.db,
					sessionId,
					sourceDbPath: parseImportSourceArg(args ?? ""),
					projectPath: project.projectDir,
					readRawMessages: () => readPiSessionMessages(ctx),
				});
				deps.afterImport?.(sessionId);
				sendCtxStatusMessage(pi, {
					title: "/mc-import-context",
					text: formatImportLegacySessionResult(result),
					level: "success",
				});
			} catch (error) {
				sendCtxStatusMessage(pi, {
					title: "/mc-import-context",
					text: `## Magic Context Import\n\n${error instanceof Error ? error.message : String(error)}`,
					level: "error",
				});
			}
		},
	});
}
