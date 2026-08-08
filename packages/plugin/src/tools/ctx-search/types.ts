import type { Database } from "../../shared/sqlite";
import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";

export type CtxSearchSource = "message";

export interface CtxSearchArgs extends ImitatedReducedArgs {
    query?: string;
    limit?: number;
    sources?: CtxSearchSource[];
}

export interface CtxSearchToolDeps {
    db: Database;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
    /**
     * Resolve the project identity for the session's directory at call time.
     * See CtxMemoryToolDeps.resolveProjectPath for why this is a function:
     * OpenCode's top-level `ctx.directory` reflects the launch dir, not the
     * session's working directory.
     */
    resolveProjectPath: (directory: string) => string | undefined;
    embeddingEnabled?: boolean;
    /** Override message reader for testing (avoids opening OpenCode DB in CI). */
    readMessages?: (sessionId: string) => Array<{
        ordinal: number;
        id: string;
        role: string;
        parts: unknown[];
    }>;
}
