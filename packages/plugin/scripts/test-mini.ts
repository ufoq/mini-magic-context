import { $ } from "bun";
import { createHash } from "node:crypto";

const KNOWN_TEST_INVENTORY_DIGEST = "366fc69679d20fdda45296b0296c35df21e360de5f6eacd546688ceaf6ebde15";

const NON_MINI_TESTS: ReadonlySet<string> = new Set([
    "src/features/magic-context/compression-depth-storage.test.ts",
    "src/features/magic-context/search.test.ts",
    "src/features/magic-context/storage-historian-runs.test.ts",
    "src/features/magic-context/storage-subagent-invocations.test.ts",
    "src/features/magic-context/sticky-injection-cas-race.test.ts",
    "src/features/magic-context/tagger-recovery.test.ts",
    "src/features/magic-context/transform-decision-log.test.ts",
    "src/features/magic-context/user-memory/storage-user-memory.test.ts",
    "src/features/magic-context/workspaces.test.ts",
] as const);

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
