import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const CONFIG_FILE_BASENAME = "mini-magic-context";

function homeDir(): string {
    if (process.platform === "win32") {
        return process.env.USERPROFILE || process.env.HOME || homedir();
    }
    return process.env.HOME || homedir();
}

function configHome(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && isAbsolute(xdg)) return xdg;
    return join(homeDir(), ".config");
}

/** `~/.config/cortexkit/mini-magic-context`, without an extension. */
export function cortexKitUserConfigBasePath(): string {
    return join(configHome(), "cortexkit", CONFIG_FILE_BASENAME);
}

/** `<project>/.cortexkit/mini-magic-context`, without an extension. */
export function cortexKitProjectConfigBasePath(directory: string): string {
    return join(directory, ".cortexkit", CONFIG_FILE_BASENAME);
}

export function resolveCortexKitUserConfigPath(): string {
    return `${cortexKitUserConfigBasePath()}.jsonc`;
}

export function resolveCortexKitProjectConfigPath(directory: string): string {
    return `${cortexKitProjectConfigBasePath(directory)}.jsonc`;
}
