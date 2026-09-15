import { $ } from "bun";
import { createHash } from "node:crypto";

const KNOWN_TEST_INVENTORY_DIGEST = "fd3bbd5ec0b1843020f336ec22537910c1318bb296549f62e1392e8f4f59c095";

const NON_MINI_TESTS: ReadonlySet<string> = new Set([] as const);

const allTests = (await $`git ls-files 'src/**/*.test.ts'`.text()).trim().split("\n").filter(Boolean).sort();
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
