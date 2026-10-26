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
  pi.registerCommand("release-native-compaction", {
    description: "Seed a pre-MC native compaction for late-adoption testing",
    handler: async (_args, ctx) => {
      const messages = ctx.sessionManager.getBranch().filter(
        (e) => e.type === "message" && e.message.role === "user",
      );
      const kept = messages[10];
      if (!kept) throw new Error("Need at least 11 user turns");
      (ctx.sessionManager as unknown as {
        appendCompaction(summary: string, firstKeptEntryId: string, tokens: number): string;
      }).appendCompaction("NATIVE ADOPTION SUMMARY: archivecanary port 47319", kept.id, 1000);
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
