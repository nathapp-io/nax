/**
 * The advisor half of the finish PR body: a pure deterministic renderer over
 * the advisor's decisions.
 *
 * Everything else this module used to build — the title, the stories table, the
 * verification block, the review rounds, the unresolved section and the
 * template merge — went with the finish machine.
 */

import type { AdviceDecision } from "@/advisor";
import { describeTarget } from "@/advisor";

const ADVISOR_TEXT_CAP = 300;

/** Free text from the advisor goes into a PR body: one line, no HTML tags, capped. */
function flat(text: string): string {
  const one = text
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > ADVISOR_TEXT_CAP ? `${one.slice(0, ADVISOR_TEXT_CAP)}…` : one;
}

/** A1: flagged decisions first, then the rest, then every supersede as an amendment to apply. Null when none. */
export function buildAdvisorSection(decisions: AdviceDecision[] | undefined): string | null {
  if (!decisions || decisions.length === 0) return null;
  const detail = (d: AdviceDecision): string => {
    if (d.action.type === "carry")
      return `carry → ${flat(d.action.toStories.join(", "))} — ${flat(d.action.instruction)}`;
    if (d.action.type === "answer") return `answer — ${flat(d.action.text)}`;
    return `${d.action.type} — ${flat(d.rationale)}`;
  };
  const line = (d: AdviceDecision): string => {
    const acs = d.acceptanceChanges?.length
      ? ` — acceptance tests changed: ${flat(d.acceptanceChanges.join(", "))}`
      : "";
    return `- **${flat(d.id)}**${d.needsHumanConfirm ? " (needs confirmation)" : ""} ${flat(d.storyId ?? "feature")} · ${detail(d)}${acs}`;
  };
  const ordered = [...decisions.filter((d) => d.needsHumanConfirm), ...decisions.filter((d) => !d.needsHumanConfirm)];
  const amendments = decisions.flatMap((d) =>
    d.action.type === "supersede"
      ? [`- ${flat(describeTarget(d.action.target))}: ${flat(d.action.newText)} (${flat(d.id)})`]
      : [],
  );
  const parts = [ordered.map(line).join("\n")];
  if (amendments.length > 0) parts.push(`### Spec amendments to apply\n${amendments.join("\n")}`);
  return parts.join("\n\n");
}
