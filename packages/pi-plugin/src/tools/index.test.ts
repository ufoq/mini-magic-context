import { describe, expect, it } from "bun:test";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb } from "../test-utils.test";
import { registerMagicContextTools } from "./index";

describe("registerMagicContextTools", () => {
	it("can omit session-scoped tools for lean subagents", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => {
					registered.push(tool.name);
				},
				registerCommand: (name: string) => {
					commands.push(name);
				},
			} as never;

			registerMagicContextTools(pi, {
				db,
				memoryToolEnabled: false,
				sessionScopedToolsDisabled: true,
				todowriteCommandEnabled: false,
			});

			expect(registered).toContain("ctx_search");
			expect(registered).not.toContain("ctx_expand");
			expect(registered).toContain("todowrite");
			expect(commands).not.toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});

	it("advertises only real ctx_* fields and allows additional properties", () => {
		const db = createTestDb();
		try {
			const registered = new Map<
				string,
				{
					name: string;
					parameters: {
						properties?: Record<string, unknown>;
						additionalProperties?: unknown;
					};
				}
			>();
			const pi = {
				registerTool: (tool: {
					name: string;
					parameters: {
						properties?: Record<string, unknown>;
						additionalProperties?: unknown;
					};
				}) => registered.set(tool.name, tool),
				registerCommand: () => undefined,
			} as never;

			registerMagicContextTools(pi, { db });

			const expectedFields: Record<string, string[]> = {
				ctx_search: ["query", "limit", "sources"],
				ctx_expand: ["start", "end", "verbose", "message"],
			};
			for (const [name, fields] of Object.entries(expectedFields)) {
				const definition = registered.get(name);
				expect(definition).toBeDefined();
				expect(
					Object.keys(definition?.parameters.properties ?? {}).sort(),
				).toEqual([...fields].sort());
				expect(definition?.parameters.properties).not.toHaveProperty("reduced");
				expect(definition?.parameters.properties).not.toHaveProperty("summary");
				expect(definition?.parameters.additionalProperties).toBe(true);
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("registers todowrite and /todos by default", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => registered.push(tool.name),
				registerCommand: (name: string) => commands.push(name),
			} as never;

			registerMagicContextTools(pi, { db });

			expect(registered).toContain("todowrite");
			expect(commands).toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});

	it("omits todowrite and /todos when todowrite is disabled", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => registered.push(tool.name),
				registerCommand: (name: string) => commands.push(name),
			} as never;

			registerMagicContextTools(pi, { db, todowriteEnabled: false });

			expect(registered).toContain("ctx_search");
			expect(registered).not.toContain("todowrite");
			expect(commands).not.toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});

	it("can keep /todos off for lean subagent entries", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const commands: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => registered.push(tool.name),
				registerCommand: (name: string) => commands.push(name),
			} as never;

			registerMagicContextTools(pi, { db, todowriteCommandEnabled: false });

			expect(registered).toContain("todowrite");
			expect(commands).not.toContain("todos");
		} finally {
			closeQuietly(db);
		}
	});
});
