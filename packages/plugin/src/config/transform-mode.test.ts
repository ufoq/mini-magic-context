import { describe, expect, it } from "bun:test";

import { resolveTransformMode } from "./transform-mode";

describe("resolveTransformMode", () => {
    it("always returns ts mode", () => {
        expect(resolveTransformMode()).toEqual({ mode: "ts", warnings: [] });
    });
});
