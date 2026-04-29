import { getSafeLogger } from "../logger";
import { validateModulePath } from "../utils/path-security";
import type { LLMFinding } from "./semantic-helpers";
import type { SemanticReviewConfig } from "./types";

const OBSERVED_PREVIEW_CHARS = 160;

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

  getSafeLogger()?.warn("review", "Downgraded unsubstantiated semantic error finding", {
    storyId,
    file,
    line: finding.verifiedBy?.line ?? finding.line,
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
