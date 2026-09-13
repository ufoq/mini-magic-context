/**
 * Harness-neutral client surface used by the shared historian/recomp runners.
 *
 * The shared runner code was originally written against OpenCode's plugin SDK
 * client (`session.create/prompt/messages/delete/get/abort`). Pi emulates the
 * exact same shape on top of its own subagent runner (see
 * `packages/pi-plugin/src/pi-recomp-client-shared.ts`), so the runners stay
 * harness-agnostic and we no longer import an SDK type into the shared core.
 *
 * Keep this structural (not SDK-derived): the only contract is the handful of
 * `session.*` calls the runners actually make.
 */
export interface HarnessClient {
    session: {
        create(args: {
            body?: Record<string, unknown>;
            query?: Record<string, unknown>;
        }): Promise<unknown>;
        prompt(args: {
            path: { id: string };
            body?: Record<string, unknown>;
            query?: Record<string, unknown>;
            signal?: AbortSignal;
        }): Promise<unknown>;
        messages(args: { path: { id: string }; query?: Record<string, unknown> }): Promise<unknown>;
        delete(args: { path: { id: string }; query?: Record<string, unknown> }): Promise<unknown>;
        get(args: { path: { id: string } }): Promise<unknown>;
        abort(args: { path: { id: string } }): Promise<unknown>;
    };
}
