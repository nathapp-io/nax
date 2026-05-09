#!/usr/bin/env bun
/**
 * Ratchet check: prevents new deep relative imports from being added.
 *
 * "Deep relative" = an import with 2+ `../` segments (`../../` or deeper)
 * that could be replaced by a path alias (`@/*` for src/, `@test/*` for test/).
 *
 * On first run, use --update-baseline to record the current violation count.
 * On every subsequent run, fails if the count has INCREASED above the baseline.
 * The baseline shrinks as files are migrated — delete it once it reaches 0.
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

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const matches = [
          ...line.matchAll(/from\s+["'](\.\.\/\.\.(?:\/[^"']*)?)['"]/g),
          ...line.matchAll(/import\(\s*["'](\.\.\/\.\.(?:\/[^"']*)?)['"]\s*\)/g),
        ];
        for (const m of matches) {
          const spec = m[1];
          if (!spec) continue;
          violations.push({
            file: rel,
            line: i + 1,
            importPath: spec,
            suggestion: suggestAlias(spec, rel),
          });
        }
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

function saveBaseline(count: number): void {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(
    BASELINE_FILE,
    JSON.stringify({ count, updatedAt: new Date().toISOString() }, null, 2) + "\n",
  );
  console.log(`[OK] Baseline saved: ${count} deep-relative imports.`);
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
    "Replace with path aliases: @/ for src/, @test/ for test/.",
    "",
  ];
  for (const v of violations.slice(0, 20)) {
    lines.push(`  ${v.file}:${v.line}  "${v.importPath}"  →  "${v.suggestion}"`);
  }
  if (count > 20) lines.push(`  ... and ${count - 20} more`);
  return { ok: false, message: lines.join("\n") };
}

function main(): void {
  const args = process.argv.slice(2);

  const violations = scanForDeepRelatives(ROOT);

  if (args.includes("--update-baseline")) {
    saveBaseline(violations.length);
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
