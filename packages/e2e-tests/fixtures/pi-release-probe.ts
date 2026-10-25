import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Test-only companion: drive custom-message runs and /tree through public APIs.
export default function (pi: ExtensionAPI) {
  pi.registerCommand("release-trigger", {
    description: "Trigger a custom-message run for compatibility tests",
    handler: async () => {
      pi.sendMessage(
        {
          customType: "release-probe",
          content: "release custom run",
          display: false,
        },
        { triggerTurn: true },
      );
    },
  });
  pi.registerCommand("release-navigate", {
    description: "Navigate to a persisted entry without summarizing",
    handler: async (target, ctx) => {
      await ctx.navigateTree(target.trim(), { summarize: false });
    },
  });
  pi.registerCommand("release-snapshot", {
    description: "Record the host runtime, branch, and tool loadout",
    handler: async (_args, ctx) => {
      writeFileSync(
        join(ctx.cwd, "release-snapshot.json"),
        JSON.stringify({
          cli: process.argv[1],
          runtime: process.execPath,
          tools: pi.getActiveTools(),
          branch: ctx.sessionManager.getBranch(),
        }),
      );
    },
  });
}
