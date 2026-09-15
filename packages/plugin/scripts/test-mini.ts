import { $ } from "bun";
import { createHash } from "node:crypto";

const KNOWN_TEST_INVENTORY_DIGEST = "b5029eea5a63b27f4d363c68f21e093d93c869cf7eb198b2029ecc889a77bead";

const NON_MINI_TESTS: ReadonlySet<string> = new Set([] as const);

// `*.test.ts` matches at every depth (git pathspec `*` crosses `/`), covering
// src/ tests plus scripts/ (build-schema, visual-memory experiments).
const allTests = (await $`git ls-files '*.test.ts'`.text()).trim().split("\n").filter(Boolean).sort();
const digest = createHash("sha256").update(`${allTests.join("\n")}\n`).digest("hex");
const staleManifestEntries = [...NON_MINI_TESTS].filter((path) => !allTests.includes(path));

if (digest !== KNOWN_TEST_INVENTORY_DIGEST || staleManifestEntries.length > 0) {
    throw new Error(`Test inventory changed; classify every new test before updating the mini manifest: ${staleManifestEntries.join(", ")}`);
}

const miniTests = allTests.filter((path) => !NON_MINI_TESTS.has(path));
const middle = Math.ceil(miniTests.length / 2);
const results = await Promise.all([
    $`bun test ${miniTests.slice(0, middle)}`.nothrow(),
    $`bun test ${miniTests.slice(middle)}`.nothrow(),
]);
const failure = results.find((result) => result.exitCode !== 0);

process.exit(failure?.exitCode ?? 0);
