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

export function cycleEffort(level: EffortLevel, step: 1 | -1): EffortLevel {
  const index = EFFORT_LEVELS.indexOf(level);
  return EFFORT_LEVELS[(index + step + EFFORT_LEVELS.length) % EFFORT_LEVELS.length] as EffortLevel;
}
