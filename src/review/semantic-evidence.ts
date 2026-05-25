import { isAbsolute } from "node:path";
import { getSafeLogger } from "../logger";
import { validateModulePath } from "../utils/path-security";
import type { LLMFinding } from "./semantic-helpers";
import { isBlockingSeverity } from "./semantic-helpers";
import type { SemanticReviewConfig } from "./types";

const OBSERVED_PREVIEW_CHARS = 160;
const ISSUE_PREVIEW_CHARS = 200;
/**
 * Line-anchor window. When `verifiedBy.line` is set we only accept the quote if
 * it appears within ±EVIDENCE_LINE_WINDOW of that line. Full-file substring
 * matching previously let recovered findings reinstate themselves with quotes
 * lifted from anywhere in the file, regardless of where the finding actually
 * claimed the bug was. 10 lines tolerates LLM off-by-some on line numbers and
 * multi-line observed blocks up to ~20 lines (the longest realistic finding
 * excerpt we've seen).
 */
const EVIDENCE_LINE_WINDOW = 10;

export const SEMANTIC_FINDING_DOWNGRADED_EVENT = "review.semantic.finding.downgraded";
export const ADVERSARIAL_FINDING_DOWNGRADED_EVENT = "review.adversarial.finding.downgraded";

export interface EvidenceCheckResult {
  status: "matched" | "unmatched" | "unreadable" | "missing-observed";
  file: string;
  line?: number;
  observed?: string;
}

export const _evidenceDeps = {
  getLogger: getSafeLogger,
};

/**
 * Structural shape needed for evidence substantiation. Both LLMFinding (semantic)
 * and AdversarialLLMFinding satisfy this — the substantiator only reads these
 * fields. Issue #987.
 */
export interface FindingWithEvidence {
  severity: string;
  file: string;
  line: number;
  issue: string;
  verifiedBy?: {
    command?: string;
    file: string;
    line?: number;
    observed: string;
  };
}

export async function substantiateSemanticEvidence(
  findings: LLMFinding[],
  diffMode: SemanticReviewConfig["diffMode"],
  workdir: string,
  storyId: string,
  blockingThreshold: "error" | "warning" | "info" = "error",
): Promise<LLMFinding[]> {
  if (diffMode !== "ref") return findings;
  return Promise.all(
    findings.map(async (finding) => {
      if (!isBlockingSeverity(finding.severity, blockingThreshold)) return finding;
      const evidence = await checkFindingEvidence({ finding, workdir });
      if (evidence.status !== "unmatched") return finding;
      return downgradeUnsubstantiatedFinding({ finding, storyId, ...evidence });
    }),
  );
}

export async function checkFindingEvidence(opts: {
  finding: FindingWithEvidence;
  workdir: string;
}): Promise<EvidenceCheckResult> {
  const observed = opts.finding.verifiedBy?.observed?.trim();
  const file = opts.finding.verifiedBy?.file?.trim() || opts.finding.file;
  const line = opts.finding.verifiedBy?.line ?? opts.finding.line;
  if (!observed) return { status: "missing-observed", file, line };
  const contents = await readSafeFile(opts.workdir, file);
  if (contents === null) return { status: "unreadable", file, line, observed };
  return matchesEvidence(contents, observed, line)
    ? { status: "matched", file, line, observed }
    : { status: "unmatched", file, line, observed };
}

/**
 * Two-pass evidence check:
 *   1. If `line` is set, look for the quote within a ±EVIDENCE_LINE_WINDOW
 *      window around that line. This is the strict check that prevents
 *      "recovered" findings from being substantiated by quoting anywhere in
 *      the file.
 *   2. If `line` is absent (e.g. AdversarialLLMFinding without a referenced
 *      line, or legacy findings), fall back to full-file substring match.
 */
function matchesEvidence(contents: string, observed: string, line: number | undefined): boolean {
  if (!line || line <= 0) {
    return normalizedIncludes(contents, observed);
  }
  const lines = contents.split("\n");
  // Convert to 0-based index. Clamp to [0, lines.length - 1] to keep the slice
  // sane even when the LLM cites a line past the file's end.
  const cited = Math.min(Math.max(0, line - 1), lines.length - 1);
  const start = Math.max(0, cited - EVIDENCE_LINE_WINDOW);
  const end = Math.min(lines.length, cited + EVIDENCE_LINE_WINDOW + 1);
  const windowText = lines.slice(start, end).join("\n");
  return normalizedIncludes(windowText, observed);
}

export function downgradeUnsubstantiatedFinding<F extends FindingWithEvidence>(opts: {
  finding: F;
  storyId: string;
  event?: string;
  file?: string;
  line?: number;
  observed?: string;
}): F {
  _evidenceDeps.getLogger()?.warn("review", "Downgraded unsubstantiated review finding", {
    storyId: opts.storyId,
    event: opts.event ?? SEMANTIC_FINDING_DOWNGRADED_EVENT,
    file: opts.file ?? opts.finding.verifiedBy?.file ?? opts.finding.file,
    line: opts.line ?? opts.finding.verifiedBy?.line ?? opts.finding.line,
    issue: opts.finding.issue?.slice(0, ISSUE_PREVIEW_CHARS),
    observed: opts.observed?.slice(0, OBSERVED_PREVIEW_CHARS),
  });
  return { ...opts.finding, severity: "unverifiable" };
}

async function readSafeFile(workdir: string, file: string): Promise<string | null> {
  const validated = validateModulePath(file, [workdir]);
  if (validated.valid && validated.absolutePath) {
    try {
      return await Bun.file(validated.absolutePath).text();
    } catch {
      return null;
    }
  }
  if (isAbsolute(file)) {
    try {
      return await Bun.file(file).text();
    } catch {
      return null;
    }
  }
  return null;
}

function normalizedIncludes(contents: string, observed: string): boolean {
  const normalizedObserved = normalizeEvidenceText(observed);
  return normalizedObserved.length > 0 && normalizeEvidenceText(contents).includes(normalizedObserved);
}

function normalizeEvidenceText(text: string): string {
  return stripWrappingQuotes(text).replace(/\s+/g, " ").trim();
}

function stripWrappingQuotes(text: string): string {
  let trimmed = text.trim();
  while (trimmed.length >= 2 && isMatchingWrapper(trimmed[0], trimmed[trimmed.length - 1])) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isMatchingWrapper(first: string | undefined, last: string | undefined): boolean {
  return (first === "`" && last === "`") || (first === `"` && last === `"`) || (first === "'" && last === "'");
}
