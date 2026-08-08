/**
 * Module transport stub — removed with the Rust/subc module.
 */
export class SubcModuleTransport {
    static async connect(): Promise<SubcModuleTransport> {
        throw new Error("SubcModuleTransport is not available in Mini Magic Context");
    }
    async close(): Promise<void> {}
}
