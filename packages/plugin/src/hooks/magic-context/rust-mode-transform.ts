import type { AuthorityStatus } from "../../features/magic-context/context-authority";

export interface RustModeModuleClient {
    call(args: unknown): Promise<unknown>;
    authorityStatus?(args: {
        context_store_uuid: string;
        project: string;
        projectRoot?: string;
        domain: "memories" | "notes";
    }): Promise<{ authority: AuthorityStatus | null }>;
}
