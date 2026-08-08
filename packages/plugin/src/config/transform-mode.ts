export type ResolvedTransformMode = "ts";

export function resolveTransformMode(): {
    mode: ResolvedTransformMode;
    warnings: string[];
} {
    return { mode: "ts", warnings: [] };
}
