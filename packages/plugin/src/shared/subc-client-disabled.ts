export const connectionFileExists = (_connectionFile: string): boolean => false;

export class SubcCallError extends Error {
    kind = "subc_call_error";
    constructor(message: string) {
        super(message);
        this.name = "SubcCallError";
    }
}

export class SubcClient {
    static async connect(_args?: unknown): Promise<SubcClient> {
        throw new SubcCallError(
            "SUBC_DISABLED: subc daemon is not available in Mini Magic Context",
        );
    }
    async call<Response = unknown>(
        _moduleId: string,
        _method: string,
        _params?: unknown,
        _options?: {
            timeoutMs?: number;
            identity?: { project_root: string; harness: string; session: string };
            targetKind?: "management_surface" | "tool_provider";
        },
    ): Promise<Response> {
        throw new SubcCallError("SUBC_DISABLED");
    }
    close(): void {}
}
