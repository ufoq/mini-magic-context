import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    getPiMagicContextPackageSpecifier,
    getPiPackageEntryName,
    hasPiMagicContextPackage,
    isPiMagicContextPackageEntry,
} from "./pi-package-entry";

function makeLocalPackage(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-pkg-entry-"));
    const pkgDir = join(dir, "the-plugin");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, version: "0.1.0" }));
    return dir;
}

describe("Pi package entry recognition", () => {
    it("matches npm specifiers by package name", () => {
        expect(isPiMagicContextPackageEntry("npm:@ufoq/pi-mini-magic-context")).toBe(true);
        expect(isPiMagicContextPackageEntry("npm:@ufoq/pi-mini-magic-context@0.1.0")).toBe(true);
    });

    it("does not substring-match a similarly named package", () => {
        expect(isPiMagicContextPackageEntry("npm:@ufoq/pi-mini-magic-context-theme")).toBe(false);
    });

    it("matches a relative local-path install by reading its manifest", () => {
        const baseDir = makeLocalPackage("@ufoq/pi-mini-magic-context");
        expect(isPiMagicContextPackageEntry("the-plugin", { baseDir })).toBe(true);
        expect(getPiPackageEntryName("the-plugin", { baseDir })).toBe(
            "@ufoq/pi-mini-magic-context",
        );
    });

    it("matches an absolute local-path install", () => {
        const baseDir = makeLocalPackage("@ufoq/pi-mini-magic-context");
        expect(isPiMagicContextPackageEntry(join(baseDir, "the-plugin"))).toBe(true);
    });

    it("does not treat an unrelated local package as Magic Context", () => {
        const baseDir = makeLocalPackage("some-other-plugin");
        expect(isPiMagicContextPackageEntry("the-plugin", { baseDir })).toBe(false);
    });

    it("does not resolve a path entry without a base directory to a false positive", () => {
        // A bare relative path that happens to exist in cwd must not be
        // mistaken for the plugin when no baseDir is supplied and cwd differs.
        expect(isPiMagicContextPackageEntry("../not-a-real-plugin")).toBe(false);
    });

    it("handles object entries with source or name", () => {
        const baseDir = makeLocalPackage("@ufoq/pi-mini-magic-context");
        expect(isPiMagicContextPackageEntry({ source: "the-plugin" }, { baseDir })).toBe(true);
        expect(isPiMagicContextPackageEntry({ name: "the-plugin" }, { baseDir })).toBe(true);
    });

    it("returns the configured specifier for local installs", () => {
        const baseDir = makeLocalPackage("@ufoq/pi-mini-magic-context");
        expect(getPiMagicContextPackageSpecifier("the-plugin", { baseDir })).toBe("the-plugin");
    });

    it("detects presence across a mixed package list", () => {
        const baseDir = makeLocalPackage("@ufoq/pi-mini-magic-context");
        expect(hasPiMagicContextPackage(["npm:other-extension", "the-plugin"], { baseDir })).toBe(
            true,
        );
        expect(hasPiMagicContextPackage(["npm:other-extension"])).toBe(false);
    });
});
