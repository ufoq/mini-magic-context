import { describe, expect, it } from "bun:test";
import { projectPathToPiSessionSlug } from "../lib/migration-paths";
import { resolveAdaptersForCommand } from "./harness-select";
import { isPiMagicContextPackageEntry } from "./pi-package-entry";

describe("CLI hardening helpers", () => {
    it("rejects invalid harness overrides instead of treating them as absent", async () => {
        await expect(
            resolveAdaptersForCommand(["--harness", "pi-typo"], {
                allowMulti: false,
                verb: "setup",
            }),
        ).rejects.toThrow("Invalid --harness value: pi-typo");
    });

    it("recognizes source-only Pi object entries without substring matches", () => {
        expect(
            isPiMagicContextPackageEntry({
                source: "npm:@ufoq/pi-mini-magic-context@0.31.5",
            }),
        ).toBe(true);
        expect(isPiMagicContextPackageEntry("npm:@ufoq/pi-mini-magic-context-theme")).toBe(false);
    });

    it("uses Pi's Windows-safe session slug encoding", () => {
        expect(projectPathToPiSessionSlug("C:\\Users\\me\\repo", "win32")).toBe(
            "--C-Users-me-repo--",
        );
    });
});
