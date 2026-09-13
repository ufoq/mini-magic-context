import { $ } from "bun";
import { createHash } from "node:crypto";

const KNOWN_TEST_INVENTORY_DIGEST = "2119d00b51f8079ab8df6769815e5238887e1fcc892ae0c924c7a422fce55c03";

const NON_MINI_TESTS: ReadonlySet<string> = new Set([
    "src/features/magic-context/compression-depth-storage.test.ts",
    "src/features/magic-context/harness-migration.test.ts",
    "src/features/magic-context/migrations-race.test.ts",
    "src/features/magic-context/migrations-v10.test.ts",
    "src/features/magic-context/migrations-v11.test.ts",
    "src/features/magic-context/migrations-v12.test.ts",
    "src/features/magic-context/migrations-v13.test.ts",
    "src/features/magic-context/migrations-v16.test.ts",
    "src/features/magic-context/migrations-v17.test.ts",
    "src/features/magic-context/migrations-v18-pi-marker.test.ts",
    "src/features/magic-context/migrations-v20.test.ts",
    "src/features/magic-context/migrations-v21.test.ts",
    "src/features/magic-context/migrations-v22.test.ts",
    "src/features/magic-context/migrations-v25.test.ts",
    "src/features/magic-context/migrations-v26.test.ts",
    "src/features/magic-context/migrations-v28.test.ts",
    "src/features/magic-context/migrations-v29.test.ts",
    "src/features/magic-context/migrations-v32.test.ts",
    "src/features/magic-context/migrations-v33.test.ts",
    "src/features/magic-context/migrations-v34.test.ts",
    "src/features/magic-context/migrations-v36.test.ts",
    "src/features/magic-context/migrations-v37.test.ts",
    "src/features/magic-context/migrations-v38.test.ts",
    "src/features/magic-context/migrations-v39.test.ts",
    "src/features/magic-context/migrations-v40.test.ts",
    "src/features/magic-context/migrations-v43.test.ts",
    "src/features/magic-context/migrations-v44.test.ts",
    "src/features/magic-context/migrations-v47.test.ts",
    "src/features/magic-context/migrations-v49.test.ts",
    "src/features/magic-context/migrations-v50.test.ts",
    "src/features/magic-context/migrations-v51.test.ts",
    "src/features/magic-context/migrations-v52.test.ts",
    "src/features/magic-context/migrations-v53.test.ts",
    "src/features/magic-context/migrations-v54.test.ts",
    "src/features/magic-context/migrations-v59.test.ts",
    "src/features/magic-context/migrations-v60.test.ts",
    "src/features/magic-context/migrations-v63.test.ts",
    "src/features/magic-context/migrations-v64.test.ts",
    "src/features/magic-context/migrations-v65.test.ts",
    "src/features/magic-context/migrations-v67.test.ts",
    "src/features/magic-context/migrations-v68.test.ts",
    "src/features/magic-context/migrations-v69.test.ts",
    "src/features/magic-context/migrations-v70.test.ts",
    "src/features/magic-context/migrations-v71.test.ts",
    "src/features/magic-context/search.test.ts",
    "src/features/magic-context/storage-db-migration.test.ts",
    "src/features/magic-context/storage-historian-runs.test.ts",
    "src/features/magic-context/storage-memory-mutation-log.test.ts",
    "src/features/magic-context/storage-project-state.test.ts",
    "src/features/magic-context/storage-subagent-invocations.test.ts",
    "src/features/magic-context/sticky-injection-cas-race.test.ts",
    "src/features/magic-context/storage.test.ts",
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
