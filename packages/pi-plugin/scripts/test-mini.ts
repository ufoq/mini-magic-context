import { $ } from "bun";
import { createHash } from "node:crypto";

const KNOWN_TEST_INVENTORY_DIGEST = "a0375921efa36a62833dcd1eaf82fef193c3230475df59da4089709c0538e8a8";
const NON_MINI_TESTS = new Set(["src/dreamer/pi-session-api.test.ts"] as const);
const allTests = (await $`git ls-files 'src/**/*.test.ts'`.text()).trim().split("\n").filter(Boolean).sort();
const digest = createHash("sha256").update(`${allTests.join("\n")}\n`).digest("hex");
const staleManifestEntries = [...NON_MINI_TESTS].filter((path) => !allTests.includes(path));

if (digest !== KNOWN_TEST_INVENTORY_DIGEST || staleManifestEntries.length > 0) {
    throw new Error(`Test inventory changed; classify every new test before updating the mini manifest: ${staleManifestEntries.join(", ")}`);
}

const result = await $`bun test ${allTests.filter((path) => !NON_MINI_TESTS.has(path))}`.nothrow();
process.exit(result.exitCode);
