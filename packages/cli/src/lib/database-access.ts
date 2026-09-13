import { existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
    getPersistedSchemaVersion as getCorePersistedSchemaVersion,
    isCurrentMiniDatabase,
    LATEST_SUPPORTED_VERSION,
} from "@magic-context/core/features/magic-context/storage-db";
import type { Database as DatabaseType } from "@magic-context/core/shared/sqlite";
import { Database } from "@magic-context/core/shared/sqlite";

export function getPersistedSchemaVersion(db: DatabaseType): number {
    return getCorePersistedSchemaVersion(db);
}

export class UnsupportedSchemaVersionError extends Error {
    readonly path: string;
    readonly persistedVersion: number;
    readonly supportedVersion: number;

    constructor(path: string, persistedVersion: number, supportedVersion: number) {
        super(
            `Refusing to open ${path}: database schema v${persistedVersion} does not match required Mini schema v${supportedVersion}. Start with a fresh database.`,
        );
        this.name = "UnsupportedSchemaVersionError";
        this.path = path;
        this.persistedVersion = persistedVersion;
        this.supportedVersion = supportedVersion;
    }
}

/**
 * Opens an existing SQLite file without silently creating an empty replacement.
 * Callers must treat null as a graceful missing-database path.
 */
export function openExistingDatabase(
    path: string,
    options: { readonly: boolean },
): DatabaseType | null {
    if (!existsSync(path)) return null;
    if (options.readonly) {
        const db = new Database(path, { readonly: true });
        return db;
    }

    // Open read-write WITHOUT SQLITE_OPEN_CREATE, so the race where the file
    // disappears between the existence check and the constructor errors instead
    // of silently creating an empty database. The two backends need different
    // spellings: bun:sqlite's Linux build rejects file:// URIs ("unable to open
    // database file") but honors { create: false }, while node:sqlite has no
    // create option and needs the URI's mode=rw.
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
        // create/readwrite are bun:sqlite-only options, absent from the shared
        // better-sqlite3-shaped Options type the wrapper exports.
        const db = new Database(path, { create: false, readwrite: true } as unknown as {
            readonly: boolean;
        });
        return db;
    }
    const uri = pathToFileURL(path);
    uri.searchParams.set("mode", "rw");
    const db = new Database(uri.href);
    return db;
}

/**
 * Applies the shared schema fence immediately after opening context.db. No query
 * or write may run until this check accepts the current schema identity.
 */
export function openExistingContextDatabase(
    path: string,
    options: { readonly: boolean },
): DatabaseType | null {
    const db = openExistingDatabase(path, options);
    if (db === null) return null;

    try {
        const persistedVersion = getPersistedSchemaVersion(db);
        if (!isCurrentMiniDatabase(db)) {
            throw new UnsupportedSchemaVersionError(
                path,
                persistedVersion,
                LATEST_SUPPORTED_VERSION,
            );
        }
        return db;
    } catch (error) {
        db.close();
        throw error;
    }
}

/**
 * Opens a live, exact-current context database for a CLI mutation without
 * initializing or modifying its schema.
 */
export function openExistingContextDatabaseForMutation(path: string): DatabaseType | null {
    return openExistingContextDatabase(path, { readonly: false });
}

/** Create a consistent SQLite snapshot, including committed WAL contents. */
export async function backupDatabaseSnapshot(db: DatabaseType, destination: string): Promise<void> {
    const serializable = db as DatabaseType & { serialize?: () => Uint8Array };
    if (typeof serializable.serialize === "function") {
        writeFileSync(destination, serializable.serialize(), { flag: "wx" });
        return;
    }

    const moduleName = "node:" + "sqlite";
    const sqlite = (await import(moduleName)) as {
        backup?: (source: unknown, path: string) => Promise<void>;
    };
    if (typeof sqlite.backup !== "function") {
        throw new Error("The active SQLite runtime does not provide a snapshot backup API");
    }
    await sqlite.backup(db, destination);
}
