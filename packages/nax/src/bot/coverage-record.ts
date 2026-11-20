/**
 * The bot review's coverage record: which required files it did not read, at the head it reviewed.
 *
 * The summary lists the same files for a human; this record is the machine-readable copy the
 * readiness gate reads back (US-013/US-014), so the two must never be able to disagree.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { editComment, hasNaxWorkflowMarker, postPrComment, stripNaxBotMarkers, withNaxBotMarker } from "@/forge";
import { getLogger } from "@/logger";
import type { PostReviewInput } from "./post";

export const COVERAGE_RECORD_KEY = "w-coverage";

export interface CoverageRecord {
  readonly headSha: string;
  readonly uncovered: readonly string[];
}

const HEADING = /^Review coverage at ([0-9A-Fa-f]{40}): (\d+) required file\(s\) not read$/;
const FILE_LINE = /^- `([^`]+)`$/;

function heading(headSha: string, count: number): string {
  return `Review coverage at ${headSha}: ${count} required file(s) not read`;
}

/** The rendered body: the heading, then one code-span line per uncovered file. */
export function renderCoverageRecord(record: CoverageRecord): string {
  const files = record.uncovered.map((path) => `- \`${path}\``);
  return [heading(record.headSha, record.uncovered.length), ...files].join("\n");
}

/**
 * The file lines that follow the heading; anything that is not one ends the list. What is left over
 * is checked by the caller, so a body that carries more than the record is not read as one.
 */
function fileLines(lines: readonly string[]): { files: string[]; rest: readonly string[] } {
  const files: string[] = [];
  let index = 0;
  for (; index < lines.length; index++) {
    const match = FILE_LINE.exec(lines[index] ?? "");
    if (match?.[1] === undefined) break;
    files.push(match[1]);
  }
  return { files, rest: lines.slice(index) };
}

/**
 * Read a raw or forge-marked body back. A heading, its declared count, the file lines under it and an
 * otherwise empty tail must all agree, so a truncated or edited body reads as no record at all rather
 * than as a claim that fewer files went unread.
 */
export function parseCoverageRecord(body: string): CoverageRecord | null {
  const lines = stripNaxBotMarkers(body).split(/\r?\n/);
  const start = lines.findIndex((line) => HEADING.test(line));
  if (start === -1) return null;
  const [, headSha, declared] = HEADING.exec(lines[start] ?? "") ?? [];
  if (headSha === undefined || declared === undefined) return null;
  const { files: uncovered, rest } = fileLines(lines.slice(start + 1));
  if (uncovered.length !== Number(declared)) return null;
  if (rest.some((line) => line.trim() !== "")) return null;
  return { headSha, uncovered };
}

/**
 * Only a real code review of a workflow PR has coverage to record: a static (untrusted) review reads
 * nothing by design, and a conversation-only review owes no file a look.
 */
export function recordsCodeReview(input: PostReviewInput): boolean {
  if (input.staticMode || input.scope === "conversation-only") return false;
  return hasNaxWorkflowMarker(input.info.body);
}

/**
 * The record a later readiness check reads back (US-013/US-014): the head this review looked at and the
 * required files it did not read. The summary lists the same files, so the two can never disagree.
 *
 * Best-effort: the record is a claim *about* the review. A forge that refuses the write must not turn a
 * completed review into a failed one, so the failure is logged and the outcome left alone. It is
 * reported separately (B2), because the reviewed head must not advance on a record this head never
 * replaced: the next default review of an advanced head is conversation-only and could never write it.
 */
export async function postCoverageRecord(input: PostReviewInput): Promise<boolean> {
  if (!recordsCodeReview(input)) return true;
  try {
    const body = withNaxBotMarker(
      renderCoverageRecord({ headSha: input.info.headSha, uncovered: input.unreadFiles ?? [] }),
      COVERAGE_RECORD_KEY,
    );
    const own = input.own.find(({ key }) => key === COVERAGE_RECORD_KEY);
    if (own) await editComment(input.ref, own.comment, body, input.deps, input.cwd);
    else await postPrComment(input.ref, body, input.deps, input.cwd);
    return true;
  } catch (cause) {
    getLogger()?.warn("bot-post", "Could not write the review coverage record", {
      pr: input.ref.number,
      error: errorMessage(cause),
    });
    return false;
  }
}
