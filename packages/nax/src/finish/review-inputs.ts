/**
 * A4: everything the two review lenses need beyond `FinishState` — the diff's
 * file list, the PRD's stories, and A3's skipped-finding hints (spec §4.1).
 * Fail-open per input: a missing PRD or unreadable hints degrade to fewer
 * prompt sections, never to a failed finish.
 */
import { join, relative } from "node:path";
import { featureDir } from "@/config";
import { readA3Hints } from "./a3-hints";
import { changedFiles } from "./changed-files";
import type { ReviewInputs } from "./ops";
import type { FinishState } from "./state";

export const _reviewInputsDeps = {
  readText: (path: string): Promise<string | null> =>
    Bun.file(path)
      .text()
      .catch(() => null),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `{ id, title }` for every story row that has both as strings; `[]` on null or unparseable input. */
export function storiesFromText(text: string | null): ReviewInputs["stories"] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = isRecord(parsed) ? parsed.userStories : undefined;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: unknown) =>
    isRecord(row) && typeof row.id === "string" && typeof row.title === "string"
      ? [{ id: row.id, title: row.title }]
      : [],
  );
}

export async function loadReviewInputs(state: FinishState, outputDir: string | undefined): Promise<ReviewInputs> {
  const prdAbs = join(featureDir(state.workdir, state.feature), "prd.json");
  const [changed, hints, prdText] = await Promise.all([
    changedFiles(state.workdir, state.base),
    outputDir ? readA3Hints(outputDir, state.feature) : Promise.resolve([]),
    _reviewInputsDeps.readText(prdAbs),
  ]);
  return { changed, hints, stories: storiesFromText(prdText), prdPath: relative(state.workdir, prdAbs) };
}
