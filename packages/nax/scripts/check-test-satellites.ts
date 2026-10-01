#!/usr/bin/env bun
/**
 * Ratchet: stop ticket-named test files from re-accumulating.
 *
 * `.nax/rules/test-architecture.md` allows `<module>-<concern>.test.ts` as a
 * describe-block split of an oversized file and forbids `<module>-<ticket>.test.ts`
 * outright ("Placement Rules" §2). The rule was never gated, so 385 such files
 * accumulated one nax story at a time — every bug fix added a file
 * (docs/plans/STATUS-test-consolidation-drain.md §0.3). This gate is the missing
 * enforcement: fix a bug by adding a test to the module's existing file, split by
 * concern at ~650 lines, never by ticket.
 *
 * Scope decisions, each of which is load-bearing:
 *
 *   - **FILENAME only.** `TICKET_RE` also matches file *content*, so a PR adding
 *     "see #1234" to a compliant test file's header would fail CI. §1.1 of the
 *     STATUS doc already says a human must read the file to judge; a gate cannot,
 *     so it judges only what it can see cheaply and unambiguously — the basename.
 *   - **Mirrors excluded.** A test file with a same-named `src/` module is the
 *     rule's own ideal ("One test file per source file"). Its basename is a
 *     module name, not a ticket, but exclude it anyway so the gate can never
 *     fail on a rule-compliant file.
 *   - **`test/e2e/` out of scope** — its own CI step, same as the ranker.
 *
 * Growth-only ratchet: the baseline records the ticket-named files that existed
 * when the gate landed. No NEW one may appear; as existing ones are renamed or
 * merged the baseline can be lowered, and the gate prints a hint when it can.
 *
 * Usage:
 *   bun scripts/check-test-satellites.ts                   # check (CI mode)
 *   bun scripts/check-test-satellites.ts --update-baseline # save new baseline
 *   bun scripts/check-test-satellites.ts --list            # print offending files
 *
 * Exit codes:
 *   0 — no new ticket-named test files (current ⊆ baseline)
 *   1 — a new ticket-named test file appeared, or the baseline is missing
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { byCodePoint } from "../src/utils/sort";
import { mirrorsSrcModule, SCAN_DIRS, TICKET_RE, walk } from "./report-test-consolidation";

const BASELINE_FILE = join(import.meta.dir, "baselines", "test-satellites-baseline.json");

export interface Baseline {
  updatedAt: string;
  /** Grandfathered ticket-named test files, keyed by repo-relative path. */
  byFile: Record<string, true>;
}

export interface RatchetOutcome {
  ok: boolean;
  message: string;
  newViolations: string[];
}

/** Filename-only ticket detection. Deliberately does not read the file. */
export function isTicketNamed(file: string): boolean {
  return TICKET_RE.test(basename(file));
}

/**
 * Ticket-named test files in scope, mirrors excluded, sorted.
 *
 * `isMirror` is injected rather than calling `mirrorsSrcModule` directly so the
 * unit test can run against a fixture tree with no real `src/` module.
 */
export function findTicketSatellites(paths: string[], isMirror: (p: string) => boolean): string[] {
  return paths.filter((p) => isTicketNamed(p) && !isMirror(p)).sort(byCodePoint);
}

export function formatReport(current: string[], baseline: Baseline | null): RatchetOutcome {
  if (baseline === null) {
    return {
      ok: false,
      message:
        "[FAIL] No satellites baseline found. Run " + "`bun scripts/check-test-satellites.ts --update-baseline` first.",
      newViolations: [],
    };
  }

  const known = new Set(Object.keys(baseline.byFile));
  const newViolations = current.filter((p) => !known.has(p));

  if (newViolations.length === 0) {
    const removed = Object.keys(baseline.byFile).filter((p) => !current.includes(p));
    let message = `[OK] ${current.length} ticket-named test file(s) (baseline: ${known.size}).`;
    if (removed.length > 0) {
      message += `\nBaseline can be lowered with --update-baseline (${removed.length} fixed since).`;
    }
    return { ok: true, message, newViolations: [] };
  }

  const lines = [
    `[FAIL] ${newViolations.length} new ticket-named test file(s) (baseline: ${known.size}).`,
    "Add the test to the module's existing file, split by concern at ~650 lines — never by ticket.",
    ...newViolations.map((p) => `  ${p}`),
  ];
  return { ok: false, message: lines.join("\n"), newViolations };
}

function loadBaseline(): Baseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

function saveBaseline(current: string[]) {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  const byFile = Object.fromEntries([...current].sort(byCodePoint).map((p) => [p, true as const]));
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ updatedAt: new Date().toISOString(), byFile }, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes("--update-baseline");
  const list = args.includes("--list");

  const current = findTicketSatellites(
    SCAN_DIRS.flatMap((d) => walk(d)),
    mirrorsSrcModule,
  );

  if (list) {
    for (const p of current) console.log(p);
    console.log(`\nTotal: ${current.length} ticket-named test file(s).`);
    return;
  }

  if (update) {
    saveBaseline(current);
    console.log(`[OK] Baseline saved: ${current.length} ticket-named test file(s).`);
    return;
  }

  const baseline = loadBaseline();
  const { ok, message } = formatReport(current, baseline);
  if (ok) {
    console.log(message);
    return;
  }
  console.error(message);
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
