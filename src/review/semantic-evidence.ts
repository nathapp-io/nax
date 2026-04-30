import { getSafeLogger } from "../logger";
import { validateModulePath } from "../utils/path-security";
import type { LLMFinding } from "./semantic-helpers";
import type { SemanticReviewConfig } from "./types";

const OBSERVED_PREVIEW_CHARS = 160;
const ISSUE_PREVIEW_CHARS = 200;

/**
 * Stable telemetry marker for the substring-substantiation downgrade.
 * Surfaced on every "Downgraded unsubstantiated semantic error finding" log
 * line so audit / dashboards can measure how often this filter suppresses
 * findings (#826).
 */
export const SEMANTIC_FINDING_DOWNGRADED_EVENT = "review.semantic.finding.downgraded";

/**
 * Injectable deps so tests can capture log calls without poking the logger
 * singleton. Production code should never override this.
 */
export const _evidenceDeps = {
  getLogger: getSafeLogger,
};

export async function substantiateSemanticEvidence(
  findings: LLMFinding[],
  diffMode: SemanticReviewConfig["diffMode"],
  workdir: string,
  storyId: string,
): Promise<LLMFinding[]> {
  if (diffMode !== "ref") return findings;
  return Promise.all(findings.map((finding) => substantiateFinding(finding, workdir, storyId)));
}

async function substantiateFinding(finding: LLMFinding, workdir: string, storyId: string): Promise<LLMFinding> {
  if (finding.severity !== "error") return finding;

  const observed = finding.verifiedBy?.observed?.trim();
  if (!observed) return finding;

  const file = finding.verifiedBy?.file?.trim() || finding.file;
  const contents = await readSafeFile(workdir, file);
  if (contents !== null && normalizedIncludes(contents, observed)) return finding;

  _evidenceDeps.getLogger()?.warn("review", "Downgraded unsubstantiated semantic error finding", {
    storyId,
    event: SEMANTIC_FINDING_DOWNGRADED_EVENT,
    file,
    line: finding.verifiedBy?.line ?? finding.line,
    issue: finding.issue?.slice(0, ISSUE_PREVIEW_CHARS),
    observed: observed.slice(0, OBSERVED_PREVIEW_CHARS),
  });

  return { ...finding, severity: "unverifiable" };
}

async function readSafeFile(workdir: string, file: string): Promise<string | null> {
  const validated = validateModulePath(file, [workdir]);
  if (!validated.valid || !validated.absolutePath) return null;

  try {
    return await Bun.file(validated.absolutePath).text();
  } catch {
    return null;
  }
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
