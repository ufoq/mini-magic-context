import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const PI_MAGIC_CONTEXT_PACKAGE_NAME = "@ufoq/pi-mini-magic-context";

function stripNpmPrefix(value: string): string {
    return value.startsWith("npm:") ? value.slice("npm:".length) : value;
}

function packageNameFromSpecifier(value: string): string {
    const normalized = stripNpmPrefix(value.trim());
    if (!normalized) return normalized;
    if (normalized.startsWith("@")) {
        const slash = normalized.indexOf("/");
        if (slash < 0) return normalized;
        const versionAt = normalized.indexOf("@", slash + 1);
        return versionAt > 0 ? normalized.slice(0, versionAt) : normalized;
    }
    const versionAt = normalized.indexOf("@");
    return versionAt > 0 ? normalized.slice(0, versionAt) : normalized;
}

/**
 * Read the `name` field of a package.json on disk, or null when the path does
 * not point at a readable package manifest.
 */
function packageNameFromDirectory(dir: string, baseDir?: string): string | null {
    try {
        const resolved = isAbsolute(dir) ? dir : resolve(baseDir ?? process.cwd(), dir);
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return null;
        const manifestPath = join(resolved, "package.json");
        if (!existsSync(manifestPath)) return null;
        const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name?: unknown };
        return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : null;
    } catch {
        return null;
    }
}

/**
 * Resolve the package name an entry refers to, for entries that are not plain
 * npm specifiers. `pi install <local path>` stores the path verbatim (often
 * relative to the settings directory), so the only way to know which package it
 * is, is to read the manifest it points at.
 *
 * `baseDir` is the directory the stored path is relative to — the directory
 * containing the settings file.
 */
function packageNameFromPathEntry(value: string, baseDir?: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // npm/git specifiers are resolved by their own name/URL, not the filesystem.
    if (/^(npm|git|https?|ssh|file):/i.test(trimmed)) return null;
    return packageNameFromDirectory(trimmed, baseDir);
}

export interface PiPackageEntryContext {
    /**
     * Directory that relative path entries are resolved against. Defaults to
     * the settings file's directory via the caller; falls back to cwd.
     */
    baseDir?: string;
}

export function getPiPackageEntryName(
    entry: unknown,
    context?: PiPackageEntryContext,
): string | null {
    if (typeof entry === "string") {
        return packageNameFromPathEntry(entry, context?.baseDir) ?? packageNameFromSpecifier(entry);
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const object = entry as Record<string, unknown>;
        for (const key of ["name", "source"] as const) {
            const name = getPiPackageEntryName(object[key], context);
            if (name) return name;
        }
    }
    return null;
}

export function isPiMagicContextPackageEntry(
    entry: unknown,
    context?: PiPackageEntryContext,
): boolean {
    return getPiPackageEntryName(entry, context) === PI_MAGIC_CONTEXT_PACKAGE_NAME;
}

export function getPiMagicContextPackageSpecifier(
    entry: unknown,
    context?: PiPackageEntryContext,
): string | null {
    if (typeof entry === "string") {
        return isPiMagicContextPackageEntry(entry, context) ? entry.trim() : null;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const object = entry as Record<string, unknown>;
        return (
            getPiMagicContextPackageSpecifier(object.source, context) ??
            getPiMagicContextPackageSpecifier(object.name, context)
        );
    }
    return null;
}

export function hasPiMagicContextPackage(
    entries: unknown[],
    context?: PiPackageEntryContext,
): boolean {
    return entries.some((entry) => isPiMagicContextPackageEntry(entry, context));
}

export function describePiPackageEntry(entry: unknown): string {
    if (typeof entry === "string") return entry;
    const name = getPiPackageEntryName(entry);
    if (name) return name;
    try {
        return JSON.stringify(entry);
    } catch {
        return String(entry);
    }
}
