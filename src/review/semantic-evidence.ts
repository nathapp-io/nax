import { isAbsolute } from "node:path";
import { getSafeLogger } from "../logger";
import { validateModulePath } from "../utils/path-security";
import type { LLMFinding } from "./semantic-helpers";
import { isBlockingSeverity } from "./semantic-helpers";
import type { SemanticReviewConfig } from "./types";

const OBSERVED_PREVIEW_CHARS = 160;
const ISSUE_PREVIEW_CHARS = 200;

export const SEMANTIC_FINDING_DOWNGRADED_EVENT = "review.semantic.finding.downgraded";

export interface EvidenceCheckResult {
  status: "matched" | "unmatched" | "unreadable" | "missing-observed";
  file: string;
  line?: number;
  observed?: string;
}

export const _evidenceDeps = {
  getLogger: getSafeLogger,
};

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
  finding: LLMFinding;
  workdir: string;
}): Promise<EvidenceCheckResult> {
  const observed = opts.finding.verifiedBy?.observed?.trim();
  const file = opts.finding.verifiedBy?.file?.trim() || opts.finding.file;
  const line = opts.finding.verifiedBy?.line ?? opts.finding.line;
  if (!observed) return { status: "missing-observed", file, line };
  const contents = await readSafeFile(opts.workdir, file);
  if (contents === null) return { status: "unreadable", file, line, observed };
  return normalizedIncludes(contents, observed)
    ? { status: "matched", file, line, observed }
    : { status: "unmatched", file, line, observed };
}

export function downgradeUnsubstantiatedFinding(opts: {
  finding: LLMFinding;
  storyId: string;
  event?: string;
  file?: string;
  line?: number;
  observed?: string;
}): LLMFinding {
  _evidenceDeps.getLogger()?.warn("review", "Downgraded unsubstantiated semantic error finding", {
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
