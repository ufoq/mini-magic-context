import { $ } from "bun";
import { createHash } from "node:crypto";

const KNOWN_TEST_INVENTORY_DIGEST = "9a064066e7d17e016698822fdb7db321c0ac419d2247252bd2f5b2aa7651f6a7";
const NON_MINI_TESTS = new Set([] as const);
const allTests = (await $`git ls-files 'src/**/*.test.ts'`.text()).trim().split("\n").filter(Boolean).sort();
const digest = createHash("sha256").update(`${allTests.join("\n")}\n`).digest("hex");
const staleManifestEntries = [...NON_MINI_TESTS].filter((path) => !allTests.includes(path));

if (digest !== KNOWN_TEST_INVENTORY_DIGEST || staleManifestEntries.length > 0) {
    throw new Error(`Test inventory changed; classify every new test before updating the mini manifest: ${staleManifestEntries.join(", ")}`);
}

const result = await $`bun test ${allTests.filter((path) => !NON_MINI_TESTS.has(path))}`.nothrow();
process.exit(result.exitCode);
