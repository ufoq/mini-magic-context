import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    initializeDatabase,
    LATEST_SUPPORTED_VERSION,
} from "@ufoq/mini-magic-context-core/features/magic-context/storage-db";
import { Database } from "@ufoq/mini-magic-context-core/shared/sqlite";
import {
    openExistingContextDatabase,
    openExistingContextDatabaseForMutation,
    UnsupportedSchemaVersionError,
} from "./database-access";

const tempDirs: string[] = [];
function tempDir(): string {
    const path = mkdtempSync(join(tmpdir(), "mc-cli-db-access-"));
    tempDirs.push(path);
    return path;
}
function createVersionMarker(path: string, version: number): void {
    const db = new Database(path);
    db.exec("CREATE TABLE mini_schema (version INTEGER PRIMARY KEY)");
    db.prepare("INSERT INTO mini_schema(version) VALUES (?)").run(version);
    db.close();
}
afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("CLI context database access", () => {
    it("rejects any non-current schema without changing it", () => {
        const path = join(tempDir(), "context.db");
        createVersionMarker(path, LATEST_SUPPORTED_VERSION + 1);
        const before = readFileSync(path);
        expect(() => openExistingContextDatabase(path, { readonly: false })).toThrow(
            UnsupportedSchemaVersionError,
        );
        expect(() => openExistingContextDatabaseForMutation(path)).toThrow(
            "does not match required Mini schema",
        );
        expect(readFileSync(path)).toEqual(before);
    });

    it("does not create a missing database", () => {
        const path = join(tempDir(), "context.db");
        expect(openExistingContextDatabase(path, { readonly: false })).toBeNull();
        expect(existsSync(path)).toBe(false);
    });

    it("opens the exact current schema for reads and writes", () => {
        const path = join(tempDir(), "context.db");
        const seed = new Database(path);
        initializeDatabase(seed);
        seed.close();

        const db = openExistingContextDatabase(path, { readonly: false });
        expect(db).not.toBeNull();
        db?.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
        db?.close();

        const readonlyDb = openExistingContextDatabase(path, { readonly: true });
        expect(
            readonlyDb
                ?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='probe'")
                .get(),
        ).toEqual({ name: "probe" });
        readonlyDb?.close();
    });
});
