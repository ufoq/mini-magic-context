import { describe, expect, it } from "bun:test";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { resolveHistorianFromConfig } from "./index";

describe("Pi config resolvers", () => {
	it("returns undefined for historian when disabled", () => {
		const config = MagicContextConfigSchema.parse({
			historian: { disable: true, model: "test/historian" },
		});

		expect(resolveHistorianFromConfig(config)).toBeUndefined();
	});

	it("returns undefined for historian when no model is configured", () => {
		const config = MagicContextConfigSchema.parse({
			historian: { model: "" },
		});

		expect(resolveHistorianFromConfig(config)).toBeUndefined();
	});
});
