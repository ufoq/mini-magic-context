import { $ } from "bun";
import { createHash } from "node:crypto";

const KNOWN_TEST_INVENTORY_DIGEST = "0a3b447c6a3555608d6ace63975fd2e2c170f92e1296610895669dbd9238888d";
const NON_MINI_TESTS = new Set([] as const);
const allTests = (await $`git ls-files 'src/**/*.test.ts'`.text()).trim().split("\n").filter(Boolean).sort();
const digest = createHash("sha256").update(`${allTests.join("\n")}\n`).digest("hex");
const staleManifestEntries = [...NON_MINI_TESTS].filter((path) => !allTests.includes(path));

if (digest !== KNOWN_TEST_INVENTORY_DIGEST || staleManifestEntries.length > 0) {
    throw new Error(`Test inventory changed; classify every new test before updating the mini manifest: ${staleManifestEntries.join(", ")}`);
}

const result = await $`bun test ${allTests.filter((path) => !NON_MINI_TESTS.has(path))}`.nothrow();
process.exit(result.exitCode);
