#!/usr/bin/env bun
/**
 * Ratchet check: every logger.{info,warn,error,debug} call inside the scoped
 * dirs must pass a data object whose FIRST key is `storyId`.
 *
 * Rule: .claude/rules/project-conventions.md — "Structured Log Fields — Mandatory".
 *
 * On first run, use --update-baseline to record current count. Subsequent runs
 * fail only if the count INCREASES. Baseline shrinks as files are migrated;
 * delete it once it reaches 0.
 *
 * Usage:
 *   bun scripts/check-logger-storyid.ts                   # check (CI)
 *   bun scripts/check-logger-storyid.ts --update-baseline # save new baseline
 *   bun scripts/check-logger-storyid.ts --list            # print all
 *
 * Allow-list a single call by appending `// nax-lint-allow: no-storyid`
 * on the line of the call (or its closing paren line).
 *
 * Exit 0 if count <= baseline, exit 1 if ratchet breached or baseline missing.
 */
import { Glob } from "bun";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { byCodePoint } from "../src/utils/sort";

const ROOT = join(import.meta.dir, "..");
const BASELINE_FILE = join(import.meta.dir, "baselines", "logger-storyid-baseline.json");
// Scope per .claude/rules/project-conventions.md → "Structured Log Fields — Mandatory":
// pipeline stages + review. We extend to src/debate/ because the gap-analysis
// violation lived there and debate runs inside the pipeline.
const SCOPED_DIRS = ["src/pipeline/stages", "src/debate", "src/review"];
const LOGGER_RE = /\blogger\??\.(info|warn|error|debug)\s*\(/g;
const ALLOW = "nax-lint-allow: no-storyid";

interface Violation {
  file: string;
  line: number;
  reason: "missing-data" | "storyid-not-first";
  snippet: string;
}

function findCallEnd(src: string, openParenIdx: number): number {
  let depth = 1;
  let inStr: '"' | "'" | "`" | null = null;
  let inLine = false;
  let inBlock = false;
  for (let i = openParenIdx + 1; i < src.length; i++) {
    const c = src[i];
    const prev = src[i - 1];
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "/" && prev === "*") inBlock = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inStr) {
        inStr = null;
        continue;
      }
      if (inStr === "`" && c === "$" && src[i + 1] === "{") {
        let braceDepth = 1;
        i += 2;
        while (i < src.length && braceDepth > 0) {
          if (src[i] === "{") braceDepth++;
          else if (src[i] === "}") braceDepth--;
          i++;
        }
        i--;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      inLine = true;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      inBlock = true;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c as '"' | "'" | "`";
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: '"' | "'" | "`" | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c as '"' | "'" | "`";
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

function lineNumberAt(src: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src[i] === "\n") n++;
  return n;
}

function regionHasAllow(src: string, openIdx: number, closeIdx: number): boolean {
  const start = src.lastIndexOf("\n", openIdx) + 1;
  const endNl = src.indexOf("\n", closeIdx);
  const region = src.slice(start, endNl === -1 ? src.length : endNl);
  return region.includes(ALLOW);
}

async function scanFile(relPath: string): Promise<Violation[]> {
  const src = await Bun.file(join(ROOT, relPath)).text();
  const violations: Violation[] = [];
  const matches = src.matchAll(LOGGER_RE);
  for (const m of matches) {
    const idx = m.index ?? 0;
    const openIdx = idx + m[0].length - 1;
    const closeIdx = findCallEnd(src, openIdx);
    if (closeIdx === -1) continue;
    if (regionHasAllow(src, idx, closeIdx)) continue;
    const args = splitTopLevelArgs(src.slice(openIdx + 1, closeIdx));
    const line = lineNumberAt(src, idx);
    const lineStart = src.lastIndexOf("\n", idx) + 1;
    const lineEnd = src.indexOf("\n", idx);
    const snippet = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd).trim();
    if (args.length < 3) {
      violations.push({ file: relPath, line, reason: "missing-data", snippet });
      continue;
    }
    const data = args[2];
    if (!data.startsWith("{")) continue; // opaque variable / spread — skip
    const body = data.slice(1).trimStart();
    if (!/^storyId\b/.test(body)) {
      violations.push({ file: relPath, line, reason: "storyid-not-first", snippet });
    }
  }
  return violations;
}

interface Baseline {
  count: number;
  updatedAt: string;
  byFile?: Record<string, number>;
}

function tally(violations: Violation[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of violations) out[v.file] = (out[v.file] ?? 0) + 1;
  return out;
}

function loadBaseline(): Baseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
  } catch {
    return null;
  }
}

function saveBaseline(count: number, byFile: Record<string, number>) {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify({ count, updatedAt: new Date().toISOString(), byFile }, null, 2)}\n`,
  );
}

function diffByFile(
  current: Record<string, number>,
  baseline: Record<string, number>,
): string[] {
  const out: string[] = [];
  for (const f of Object.keys(current)) {
    if ((current[f] ?? 0) > (baseline[f] ?? 0)) out.push(f);
  }
  return out.sort(byCodePoint);
}

function printViolation(v: Violation) {
  const why =
    v.reason === "missing-data"
      ? "no data object passed (third arg missing)"
      : "data object's first key is not `storyId`";
  console.error(`  ${v.file}:${v.line}  — ${why}`);
  console.error(`    ${v.snippet}`);
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes("--update-baseline");
  const list = args.includes("--list");

  const all: Violation[] = [];
  for (const dir of SCOPED_DIRS) {
    const glob = new Glob("**/*.ts");
    for await (const f of glob.scan({ cwd: join(ROOT, dir), absolute: false })) {
      if (f.endsWith(".d.ts")) continue;
      all.push(...(await scanFile(join(dir, f))));
    }
  }
  const byFile = tally(all);
  const count = all.length;

  if (list) {
    for (const v of all) printViolation(v);
    console.log(`\nTotal: ${count}`);
    return;
  }

  if (update) {
    saveBaseline(count, byFile);
    console.log(`OK: baseline updated to ${count} violations.`);
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.error("ERROR: logger-storyid-baseline.json missing.");
    console.error(`Current violations: ${count}.`);
    console.error("Run 'bun scripts/check-logger-storyid.ts --update-baseline' to initialize.");
    process.exit(1);
  }

  if (count <= baseline.count) {
    console.log(`OK: ${count} violations (baseline ${baseline.count}).`);
    if (count < baseline.count) console.log("Baseline can be lowered with --update-baseline.");
    return;
  }

  const offenders = diffByFile(byFile, baseline.byFile ?? {});
  console.error(
    `ERROR: ${count} logger calls violate the storyId-first rule (baseline ${baseline.count}).`,
  );
  console.error("New or increased violations in these files:");
  for (const f of offenders) {
    console.error(`  ${f}  (was ${baseline.byFile?.[f] ?? 0}, now ${byFile[f]})`);
    for (const v of all.filter((x) => x.file === f)) printViolation(v);
  }
  console.error("");
  console.error("See .claude/rules/project-conventions.md → 'Structured Log Fields — Mandatory'.");
  console.error("Pass { storyId: <id>, ... } as the third argument, storyId first.");
  console.error("Allow a single line with '// nax-lint-allow: no-storyid' when unavoidable.");
  process.exit(1);
}

await main();
