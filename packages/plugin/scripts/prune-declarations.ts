import { rm } from "node:fs/promises";

const publicDeclaration = "dist/index.d.ts";

for await (const path of new Bun.Glob("dist/**/*.d.ts").scan(".")) {
    if (path !== publicDeclaration) {
        await rm(path);
    }
}

for await (const path of new Bun.Glob("dist/**/*.d.ts.map").scan(".")) {
    await rm(path);
}
