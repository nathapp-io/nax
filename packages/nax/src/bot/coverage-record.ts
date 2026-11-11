/**
 * The bot review's coverage record: which required files it did not read, at the head it reviewed.
 *
 * The summary lists the same files for a human; this record is the machine-readable copy the
 * readiness gate reads back (US-013/US-014), so the two must never be able to disagree.
 */

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

/** The file lines that follow the heading; anything that is not one ends the list. */
function fileLines(lines: readonly string[]): string[] {
  const files: string[] = [];
  for (const line of lines) {
    const match = FILE_LINE.exec(line);
    if (match?.[1] === undefined) break;
    files.push(match[1]);
  }
  return files;
}

/**
 * Read a raw or forge-marked body back. A heading, its declared count and the file lines under it
 * must agree, so a truncated or edited body reads as no record at all rather than a wrong one.
 */
export function parseCoverageRecord(body: string): CoverageRecord | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => HEADING.test(line));
  if (start === -1) return null;
  const [, headSha, declared] = HEADING.exec(lines[start] ?? "") ?? [];
  if (headSha === undefined || declared === undefined) return null;
  const uncovered = fileLines(lines.slice(start + 1));
  if (uncovered.length !== Number(declared)) return null;
  return { headSha, uncovered };
}
