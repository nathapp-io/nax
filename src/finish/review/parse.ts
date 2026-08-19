/**
 * Turning a reviewer's free-form reply into structured findings.
 *
 * The reviewer's contract is text, not JSON, for two reasons. The dimension
 * references both hinge on an enumeration — a per-AC walk and a per-changed-
 * function walk — and a reply constrained to one JSON object has nowhere to put
 * one. And a text reply has no cliff: a malformed line costs that line, where an
 * unparseable JSON object used to cost the entire review (#1614).
 *
 * Every function here is pure and non-throwing. `verdict.ts` documents why that
 * is load-bearing: a throw inside an acpx `parse` fails the whole flow.
 */
import type { Finding, FindingDisposition, ReviewReport, Severity, Touchpoint } from "../types";

type Section = "touchpoints" | "walk" | "findings";

/** Headings are matched loosely — any level, any case, optional trailing colon. */
const HEADING = /^\s*#{1,6}\s*(TOUCHPOINTS|WALK|FINDINGS|DISPOSITIONS)\s*:?\s*$/i;
/**
 * The old acpx flow (`flows/nax-finish/findings-parse.ts`) joined the agent's
 * message stream with no separator, so a heading could land mid-line — for
 * example `…confidence bar.## TOUCHPOINTS` — whenever the preceding narration
 * message did not itself end in a newline. That required a `GLUED_HEADING`
 * regex here to re-insert the missing newline before parsing.
 *
 * In-process, `extractOutput` in `src/agents/acp/adapter-output.ts` builds the
 * reply by joining assistant messages with `"\n"` (`.join("\n")`), so a
 * heading can never land mid-line: every message boundary is already a
 * newline boundary. The glued-heading case this guarded against cannot arise
 * here — do not restore the regex.
 */
const BLOCK = /^\s*\[(CRITICAL|HIGH|MEDIUM|LOW)\]\s+(.+?)\s*$/;
const FIELD = /^\s*(Problem|Fix|Judgment)\s*:\s*(.*)$/i;
const NO_FINDINGS = /^\s*no findings\.?\s*$/i;
const BULLET = /^\s*[-*]\s+(.+?)\s*$/;
const DISPOSITION = /^\s*\[?(\d+)\]?\s*[.:)]?\s*(fixed|rejected)\b\s*(.*)$/i;
const EVIDENCE = /evidence\s*:\s*(\S+)/i;

/** `- path/to/file.ts:symbol — why`, tolerant of backticks and of `-` for `—`. */
function parseTouchpoint(text: string): Touchpoint | null {
  const m = /^(\S+)\s*(?:[—–-]\s*)?(.*)$/.exec(text);
  if (!m) return null;
  const locator = m[1].replace(/[`,]/g, "");
  const note = m[2].trim();
  if (/^none$/i.test(locator)) return { path: "none", note };
  const cut = locator.lastIndexOf(":");
  return cut > 0 ? { path: locator.slice(0, cut), symbol: locator.slice(cut + 1), note } : { path: locator, note };
}

function parseJudgment(value: string): { judgment: boolean; judgmentReason?: string } {
  const m = /^\s*(yes|true)\b\s*(?:[—–-]\s*)?(.*)$/i.exec(value);
  if (!m) return { judgment: false };
  const reason = m[2].trim();
  return reason ? { judgment: true, judgmentReason: reason } : { judgment: true };
}

/**
 * Parse a reviewer reply.
 *
 * Section state starts at `findings`, not "none": a reviewer that emits blocks
 * and no headings at all is a partial failure of the contract, and its findings
 * are still worth keeping — losing them is the exact failure this replaces. The
 * `saw*Section` flags stay false in that case, which is what the audit gate in
 * `steps/review-audit.ts` keys off.
 */
export function parseReviewReport(text: string): ReviewReport {
  const report: ReviewReport = {
    findings: [],
    touchpoints: [],
    walk: [],
    sawNoFindings: false,
    sawTouchpointsSection: false,
    sawWalkSection: false,
  };

  let section: Section = "findings";
  let current: Finding | null = null;
  let lastField: "problem" | "fix" | null = null;

  const flush = () => {
    if (current) report.findings.push(current);
    current = null;
    lastField = null;
  };

  for (const line of text.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const name = heading[1].toLowerCase();
      if (name === "touchpoints") {
        section = "touchpoints";
        report.sawTouchpointsSection = true;
      } else if (name === "walk") {
        section = "walk";
        report.sawWalkSection = true;
      } else {
        section = "findings";
      }
      continue;
    }

    if (section === "touchpoints") {
      const bullet = BULLET.exec(line);
      const tp = bullet ? parseTouchpoint(bullet[1]) : null;
      if (tp) report.touchpoints.push(tp);
      continue;
    }
    if (section === "walk") {
      if (line.trim().length > 0) report.walk.push(line.trim());
      continue;
    }

    const block = BLOCK.exec(line);
    if (block) {
      flush();
      current = { severity: block[1] as Severity, title: block[2], problem: "", fix: "" };
      continue;
    }
    if (NO_FINDINGS.test(line)) {
      report.sawNoFindings = true;
      continue;
    }
    if (!current) continue;
    const field = FIELD.exec(line);
    if (field) {
      const key = field[1].toLowerCase();
      if (key === "problem") {
        current.problem = field[2].trim();
        lastField = "problem";
      } else if (key === "fix") {
        current.fix = field[2].trim();
        lastField = "fix";
      } else {
        Object.assign(current, parseJudgment(field[2]));
        lastField = null;
      }
      continue;
    }
    // A continuation line for the field above it — the reviewer wraps prose, and
    // a wrapped Problem read as nothing is how detail silently disappears.
    if (lastField && line.trim().length > 0) {
      current[lastField] = `${current[lastField]} ${line.trim()}`.trim();
    }
  }
  flush();
  return report;
}

/** Parse the `## DISPOSITIONS` section of a fix node's reply. */
export function parseDispositions(text: string): FindingDisposition[] {
  const out: FindingDisposition[] = [];
  for (const line of text.split("\n")) {
    const m = DISPOSITION.exec(line);
    if (!m) continue;
    const evidence = EVIDENCE.exec(m[3])?.[1];
    out.push({
      index: Number(m[1]),
      disposition: m[2].toLowerCase() as "fixed" | "rejected",
      ...(evidence ? { evidence } : {}),
    });
  }
  return out;
}
