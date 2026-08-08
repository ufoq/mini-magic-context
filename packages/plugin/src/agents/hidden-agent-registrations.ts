import { applyDisallowedTools, buildAllowOnlyPermission } from "./permissions";

export interface HiddenAgentRegistration {
    id: string;
    prompt: string | undefined;
    allowedTools: readonly string[];
    maxSteps: number;
    overrides?: Record<string, unknown>;
    lockPermissions?: boolean;
}

interface HistorianRegistrationArgs {
    historianPrompt: string | undefined;
    historianRecompPrompt?: string | undefined;
    historianEditorPrompt: string | undefined;
    historianOverrides?: Record<string, unknown>;
    historianDisallowed: readonly string[];
}

function clampStepLimit(value: unknown, cap: number): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.min(value, cap) : cap;
}

export function buildHiddenAgentRegistrations(
    args: HistorianRegistrationArgs,
): HiddenAgentRegistration[] {
    const allowedTools = applyDisallowedTools(
        ["read", "aft_outline", "aft_zoom", "aft_search"],
        args.historianDisallowed,
    );
    return [
        {
            id: "historian",
            prompt: args.historianPrompt,
            allowedTools,
            maxSteps: 40,
            overrides: args.historianOverrides,
        },
        {
            id: "historian-recomp",
            prompt: args.historianRecompPrompt ?? args.historianPrompt,
            allowedTools,
            maxSteps: 40,
            overrides: args.historianOverrides,
        },
        {
            id: "historian-editor",
            prompt: args.historianEditorPrompt,
            allowedTools,
            maxSteps: 40,
            overrides: args.historianOverrides,
        },
    ];
}

export function buildHiddenAgentConfig(
    prompt: string,
    allowedTools: readonly string[],
    maxSteps: number,
    overrides?: Record<string, unknown>,
    agentLabel?: string,
    lockPermissions = false,
) {
    const {
        permission: overridePermission,
        tools: overrideTools,
        prompt: overridePrompt,
        system: overrideSystem,
        ...rest
    } = (overrides ?? {}) as {
        permission?: Record<string, unknown>;
        tools?: Record<string, boolean>;
        prompt?: unknown;
        system?: unknown;
        [key: string]: unknown;
    };
    const passthrough = lockPermissions
        ? rest
        : {
              ...rest,
              ...(overrideTools === undefined ? {} : { tools: overrideTools }),
              ...(overridePrompt === undefined ? {} : { prompt: overridePrompt }),
              ...(overrideSystem === undefined ? {} : { system: overrideSystem }),
          };
    return {
        prompt,
        ...passthrough,
        steps: clampStepLimit(passthrough.steps, maxSteps),
        maxSteps: clampStepLimit(passthrough.maxSteps, maxSteps),
        permission: {
            ...buildAllowOnlyPermission(allowedTools, agentLabel),
            ...(lockPermissions ? {} : (overridePermission ?? {})),
        },
        mode: "subagent" as const,
        hidden: true,
    };
}
