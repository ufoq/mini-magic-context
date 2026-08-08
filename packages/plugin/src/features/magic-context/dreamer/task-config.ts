import type { PiThinkingLevel } from "../../../config/schema/magic-context";
import { resolveFallbackChain } from "../../../shared/resolve-fallbacks";
import { CANONICAL_DREAM_TASKS, type DreamTaskName } from "./task-registry";
import type { DreamTaskRuntimeConfig } from "./task-scheduler";

type ScheduledTaskConfig = {
    readonly schedule?: string;
    readonly timeout_minutes?: number;
    readonly model?: string;
    readonly fallback_models?: readonly string[];
    readonly thinking_level?: PiThinkingLevel;
    readonly promotion_threshold?: number;
};

type DetachedDreamSchedule = {
    readonly model?: string;
    readonly fallback_models?: readonly string[];
    readonly thinking_level?: PiThinkingLevel;
    readonly tasks?: Partial<Record<DreamTaskName, ScheduledTaskConfig>>;
};

/**
 * Resolve the full per-task runtime config the scheduler consumes from the
 * validated dreamer config: each task's schedule + its effective model chain
 * (task override → dreamer-level default), thinking level, timeout, and
 * task-specific params. One place owns the inheritance rule.
 */
export function buildDreamTaskRuntimeConfigs(
    dreamer: DetachedDreamSchedule,
    language?: string,
): DreamTaskRuntimeConfig[] {
    // Defensive: `tasks` is always the v2 record after config load (Zod default),
    // but background/test callers can hand a partially-shaped object; treat a
    // missing entry as a disabled task with defaults rather than crashing.
    const tasks = dreamer.tasks ?? {};
    return CANONICAL_DREAM_TASKS.map((task) => {
        const t = tasks[task] ?? {
            schedule: "",
            timeout_minutes: 20,
        };
        // Per-task model override falls back to the dreamer-level model. Fallback
        // chain: per-task list if set, else the dreamer-level list (resolved/deduped).
        const model = t.model ?? dreamer.model;
        const fallbackModels = resolveFallbackChain(t.fallback_models ?? dreamer.fallback_models);
        const thinkingLevel = t.thinking_level ?? dreamer.thinking_level;
        return {
            task,
            schedule: t.schedule ?? "",
            model,
            fallbackModels,
            thinkingLevel,
            language,
            timeoutMinutes: t.timeout_minutes ?? 20,
            promotionThreshold: t.promotion_threshold,
        };
    });
}

/**
 * The collection privacy gate (Option C): user-behavior observation candidates
 * are stored during historian runs ONLY when the user has scheduled the
 * review-user-memories task (schedule != ""). Replaces the v1
 * `user_memories.enabled` flag, which both gated collection AND review.
 */
export function userMemoryCollectionEnabled(dreamer: DetachedDreamSchedule | undefined): boolean {
    const schedule = dreamer?.tasks?.["review-user-memories"]?.schedule;
    return typeof schedule === "string" && schedule.trim() !== "";
}

/** The promotion threshold for user-memory review (collection + review share it). */
export function userMemoryPromotionThreshold(dreamer: DetachedDreamSchedule | undefined): number {
    return dreamer?.tasks?.["review-user-memories"]?.promotion_threshold ?? 3;
}

/** True when a task is scheduled (schedule != ""). Generic enable check. */
export function dreamTaskScheduled(
    dreamer: DetachedDreamSchedule | undefined,
    task: DreamTaskName,
): boolean {
    const schedule = dreamer?.tasks?.[task]?.schedule;
    return typeof schedule === "string" && schedule.trim() !== "";
}

/** Names of the tasks the user has scheduled (schedule != ""), in canonical order. */
export function enabledDreamTasks(dreamer: DetachedDreamSchedule | undefined): DreamTaskName[] {
    const tasks = dreamer?.tasks;
    if (!tasks) return [];
    return CANONICAL_DREAM_TASKS.filter((t) => tasks[t]?.schedule?.trim());
}

/** A compact `/ctx-status`-style schedule summary, e.g.
 *  "verify 0 3 * * *, curate 0 4 * * 0" — or "manual-only" when nothing is
 *  scheduled. */
export function summarizeDreamSchedule(dreamer: DetachedDreamSchedule | undefined): string {
    const enabled = enabledDreamTasks(dreamer);
    if (enabled.length === 0) return "manual-only";
    return enabled.map((t) => `${t} ${dreamer?.tasks?.[t]?.schedule}`).join(", ");
}
