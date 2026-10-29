import { parseModelSpec } from "@nathapp/nax-agent";
import { THINKING_LEVELS } from "@nathapp/nax-agent/internal";

export type EffortLevel = "default" | keyof typeof THINKING_LEVELS;

/** Provider default first, then the agent's declared thinking-level order. */
export const EFFORT_LEVELS: readonly EffortLevel[] = [
  "default",
  ...(Object.keys(THINKING_LEVELS) as (keyof typeof THINKING_LEVELS)[]),
];

export function isEffortLevel(text: string): text is EffortLevel {
  return EFFORT_LEVELS.some((level) => level === text);
}

export function modelEffort(model: string): EffortLevel {
  const { effort } = parseModelSpec(model);
  return effort !== undefined && isEffortLevel(effort) ? effort : "default";
}

export function withEffort(model: string, level: EffortLevel): string {
  const { model: base } = parseModelSpec(model);
  return level === "default" ? base : `${base}[${level}]`;
}

export type SupportedEffort = Exclude<EffortLevel, "default">;

/** Normalize declarations without mutating the catalog's order or array. */
export function effortLevelsFor(supported: readonly SupportedEffort[] | undefined): readonly EffortLevel[] {
  if (supported === undefined) return EFFORT_LEVELS;
  return EFFORT_LEVELS.filter((level) => level === "default" || supported.includes(level));
}

export function cycleEffort(
  level: EffortLevel,
  step: 1 | -1,
  levels: readonly EffortLevel[] = EFFORT_LEVELS,
): EffortLevel {
  const index = levels.indexOf(level);
  if (index >= 0) return levels[(index + step + levels.length) % levels.length] ?? "default";
  const rank = EFFORT_LEVELS.indexOf(level);
  return step === 1
    ? (levels.find((entry) => EFFORT_LEVELS.indexOf(entry) > rank) ?? levels[0] ?? "default")
    : (levels.findLast((entry) => EFFORT_LEVELS.indexOf(entry) < rank) ?? levels.at(-1) ?? "default");
}

/** Nearest supported non-default rank; canonical iteration breaks ties downwards. */
export function clampEffort(level: EffortLevel, levels: readonly EffortLevel[]): EffortLevel {
  if (levels.includes(level)) return level;
  const rank = EFFORT_LEVELS.indexOf(level);
  let nearest: EffortLevel = "default";
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of EFFORT_LEVELS) {
    if (candidate === "default" || !levels.includes(candidate)) continue;
    const delta = Math.abs(EFFORT_LEVELS.indexOf(candidate) - rank);
    if (delta < distance) {
      nearest = candidate;
      distance = delta;
    }
  }
  return nearest;
}

export function clampModelEffort(model: string, levels: readonly EffortLevel[]): string {
  return withEffort(model, clampEffort(modelEffort(model), levels));
}
