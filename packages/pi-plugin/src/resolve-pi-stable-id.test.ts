import { describe, expect, it } from "bun:test";
import { resolvePiStableId } from "./read-session-pi";

describe("resolvePiStableId", () => {
	const msg = { role: "assistant", timestamp: 1700 };

	it("prefers the reference identity", () => {
		const refs = new Map<object, string>([[msg, "entry-ref"]]);
		expect(resolvePiStableId(msg, 0, ["entry-pos"], refs)).toBe("entry-ref");
	});

	it("uses the positional entry id when the reference map misses", () => {
		expect(resolvePiStableId(msg, 0, ["entry-pos"], new Map())).toBe(
			"entry-pos",
		);
	});

	it("refuses to synthesize an unstable id for an unresolved message", () => {
		expect(resolvePiStableId(msg, 0)).toBeUndefined();
		expect(resolvePiStableId(msg, 0, [""])).toBeUndefined();
	});

	it("keeps a real id stable across an index shift", () => {
		const refs = new Map<object, string>([[msg, "entry-stable"]]);
		expect(resolvePiStableId(msg, 7, [], refs)).toBe("entry-stable");
		expect(resolvePiStableId(msg, 2, [], refs)).toBe("entry-stable");
	});
});
