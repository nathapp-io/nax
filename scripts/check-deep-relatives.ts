#!/usr/bin/env bun
/**
 * Permanent gate: forbids deep relative imports. The path-alias migration
 * (#1647/#1651) brought the codebase to 0 deep relatives; the baseline stays
 * pinned at 0 from here on rather than being deleted, so a regression fails
 * the build instead of silently reappearing.
 *
 * "Deep relative" = an import with 2+ `../` segments (`../../` or deeper)
 * that could be replaced by a path alias (`@/*` for src/, `@test/*` for test/,
 * `@scripts/*` for scripts/).
 *
 * On every run, fails if the count is above the baseline (0). `--update-baseline`
 * exists only to record byFile detail after a deliberate, reviewed exemption —
 * never use it to hide a regression back above 0.
 *
 * Usage:
 *   bun scripts/check-deep-relatives.ts                   # check (CI mode)
 *   bun scripts/check-deep-relatives.ts --update-baseline # save new baseline
 *   bun scripts/check-deep-relatives.ts --list            # print all violations
 *
 * Exit codes:
 *   0 — no new violations (count <= baseline)
 *   1 — ratchet breached (count > baseline) or baseline missing
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BASELINE_FILE = join(import.meta.dir, "baselines", "deep-relatives-baseline.json");
const SCAN_DIRS = ["src", "test", "bin", "scripts"] as const;

const EXEMPT_FILES = new Set<string>(["scripts/check-deep-relatives.ts"]);

export interface DeepRelativeViolation {
  file: string;
  line: number;
  importPath: string;
  suggestion: string;
}

interface Baseline {
  count: number;
  updatedAt: string;
  /** Per-file violation counts. Present in baselines saved after this field was added.
   *  Used to pinpoint which files introduced new violations on failure. */
  byFile?: Record<string, number>;
}

/** Computes [start, end) offsets of every string/template literal in `content`,
 *  so matches found only inside fixture text (not real imports) can be skipped.
 *  Comments are deliberately NOT treated as literals — matches inside comments
 *  still count as violations. */
function computeStringLiteralSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const len = content.length;
  let i = 0;
  while (i < len) {
    const c = content[i];
    const next = content[i + 1];
    if (c === "/" && next === "/") {
      i += 2;
      while (i < len && content[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < len && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      const start = i;
      i++;
      while (i < len) {
        if (content[i] === "\\") {
          i += 2;
          continue;
        }
        if (content[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      spans.push([start, i]);
      continue;
    }
    i++;
  }
  return spans;
}

function isInsideSpan(offset: number, spans: readonly (readonly [number, number])[]): boolean {
  for (const [start, end] of spans) {
    if (start > offset) break;
    if (offset >= start && offset < end) return true;
  }
  return false;
}

function suggestAlias(spec: string, fileRelative: string): string {
  const parts = spec.split("/");
  let upCount = 0;
  while (parts[upCount] === "..") upCount++;

  const fileDirParts = fileRelative.split("/").slice(0, -1);
  const resolved = [
    ...fileDirParts.slice(0, fileDirParts.length - upCount),
    ...parts.slice(upCount),
  ];

  const anchorTop = resolved[0];
  const sub = resolved.slice(1).join("/");

  if (anchorTop === "src") return sub ? `@/${sub}` : "@/";
  if (anchorTop === "test") return sub ? `@test/${sub}` : "@test/";
  return spec;
}

export function scanForDeepRelatives(rootDir: string): DeepRelativeViolation[] {
  const violations: DeepRelativeViolation[] = [];

  function* walk(dir: string): Generator<string> {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        yield* walk(full);
      } else if (st.isFile() && (entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
        yield full;
      }
    }
  }

  for (const sub of SCAN_DIRS) {
    for (const file of walk(join(rootDir, sub))) {
      const rel = relative(rootDir, file);
      if (EXEMPT_FILES.has(rel)) continue;

      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }

      const spans = computeStringLiteralSpans(content);
      const lines = content.split("\n");
      let lineOffset = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const matches = [
          ...line.matchAll(/from\s+["'](\.\.\/\.\.(?:\/[^"']*)?)['"]/g),
          ...line.matchAll(/import\(\s*["'](\.\.\/\.\.(?:\/[^"']*)?)['"]\s*\)/g),
        ];
        for (const m of matches) {
          const spec = m[1];
          if (!spec) continue;
          const offset = lineOffset + (m.index ?? 0);
          if (isInsideSpan(offset, spans)) continue;
          violations.push({
            file: rel,
            line: i + 1,
            importPath: spec,
            suggestion: suggestAlias(spec, rel),
          });
        }
        lineOffset += line.length + 1;
      }
    }
  }

  return violations;
}

function loadBaseline(): Baseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

function saveBaseline(violations: readonly DeepRelativeViolation[]): void {
  const byFile: Record<string, number> = {};
  for (const v of violations) {
    byFile[v.file] = (byFile[v.file] ?? 0) + 1;
  }
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(
    BASELINE_FILE,
    JSON.stringify({ count: violations.length, updatedAt: new Date().toISOString(), byFile }, null, 2) + "\n",
  );
  console.log(`[OK] Baseline saved: ${violations.length} deep-relative imports across ${Object.keys(byFile).length} files.`);
}

export function formatReport(
  violations: readonly DeepRelativeViolation[],
  baseline: Baseline | null,
): { message: string; ok: boolean } {
  const count = violations.length;

  if (baseline === null) {
    return {
      ok: false,
      message:
        "[FAIL] No baseline found. Run `bun scripts/check-deep-relatives.ts --update-baseline` first.",
    };
  }

  const delta = count - baseline.count;

  if (delta <= 0) {
    const improved = delta < 0 ? ` (↓ ${Math.abs(delta)} migrated since last baseline)` : "";
    return {
      ok: true,
      message: `[OK] ${count} deep-relative imports remaining (baseline: ${baseline.count})${improved}.`,
    };
  }

  const lines = [
    `[FAIL] ${delta} new deep-relative import(s) added (${count} total, baseline: ${baseline.count}).`,
    "Refactor the imports in your changed files to use path aliases (@/ for src/, @test/ for test/).",
    "Run `git diff --name-only` to identify your changed files, then convert their 2+ level relative imports.",
    "",
  ];

  if (baseline.byFile) {
    // Identify violations from files that exceeded their per-file baseline count.
    const currentByFile: Record<string, number> = {};
    for (const v of violations) currentByFile[v.file] = (currentByFile[v.file] ?? 0) + 1;

    const newViolations = violations.filter((v) => {
      const baseCount = baseline.byFile![v.file] ?? 0;
      return (currentByFile[v.file] ?? 0) > baseCount;
    });

    lines.push(`New violations (${newViolations.length}):`);
    for (const v of newViolations.slice(0, delta)) {
      lines.push(`  ${v.file}:${v.line}  "${v.importPath}"  →  "${v.suggestion}"`);
    }
    if (newViolations.length > delta) lines.push(`  ... and ${newViolations.length - delta} more`);
  } else {
    lines.push("Re-run `--update-baseline` to enable per-file violation tracking for more precise output.");
    lines.push(`All current violations (first 20 shown — includes pre-existing baseline violations):`);
    for (const v of violations.slice(0, 20)) {
      lines.push(`  ${v.file}:${v.line}  "${v.importPath}"  →  "${v.suggestion}"`);
    }
    if (count > 20) lines.push(`  ... and ${count - 20} more`);
  }

  return { ok: false, message: lines.join("\n") };
}

function main(): void {
  const args = process.argv.slice(2);

  const violations = scanForDeepRelatives(ROOT);

  if (args.includes("--update-baseline")) {
    saveBaseline(violations);
    return;
  }

  if (args.includes("--list")) {
    for (const v of violations) {
      console.log(`${v.file}:${v.line}  "${v.importPath}"  →  "${v.suggestion}"`);
    }
    console.log(`\nTotal: ${violations.length}`);
    return;
  }

  const baseline = loadBaseline();
  const { ok, message } = formatReport(violations, baseline);
  if (ok) {
    console.log(message);
  } else {
    console.error(message);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
