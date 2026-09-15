import { $ } from "bun";
import { createHash } from "node:crypto";

const KNOWN_TEST_INVENTORY_DIGEST = "bd335d4a49fcf98ac02dcd753a9115fcbed1df5999e0e7371cb9ac4fe0669d93";
const NON_MINI_TESTS = new Set([] as const);
// `*.test.ts` matches at every depth (git pathspec `*` crosses `/`), so this
// covers root-level src tests as well as nested ones. Using `src/**/*.test.ts`
// silently skipped the root-level files, which is how several stale tests
// drifted out of the gated run.
const allTests = (await $`git ls-files '*.test.ts'`.text()).trim().split("\n").filter(Boolean).sort();
const digest = createHash("sha256").update(`${allTests.join("\n")}\n`).digest("hex");
const staleManifestEntries = [...NON_MINI_TESTS].filter((path) => !allTests.includes(path));

if (digest !== KNOWN_TEST_INVENTORY_DIGEST || staleManifestEntries.length > 0) {
    throw new Error(`Test inventory changed; classify every new test before updating the mini manifest: ${staleManifestEntries.join(", ")}`);
}

const result = await $`bun test ${allTests.filter((path) => !NON_MINI_TESTS.has(path))}`.nothrow();
process.exit(result.exitCode);
