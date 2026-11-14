import { ledgerText } from "./ledger";
import type { StoryLoopEnv } from "./story-loop";
import type { StoryReviewVerdict } from "./types";

const NOTES = {
  spec: "story review verdict inconsistent: spec fail without a blocking spec finding; findings kept",
  quality: "story review verdict inconsistent: quality changes without a blocking finding; findings kept",
} as const;

/** Persist mismatch facts without turning them into findings. */
export async function recordVerdictMismatch(env: StoryLoopEnv, verdict: StoryReviewVerdict): Promise<void> {
  const kinds = verdict.mismatch;
  if (!kinds?.length) return;
  for (const kind of new Set(kinds)) await env.sink.ledger(ledgerText.note(NOTES[kind]));
  const model = env.steps.modelFor?.("story-review")?.model;
  await env.sink.update({ verdictMismatch: { kinds, ...(model === undefined ? {} : { model }) } });
}
