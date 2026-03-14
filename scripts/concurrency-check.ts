#!/usr/bin/env bun
/**
 * concurrency-check.ts
 * Compares sequential vs concurrent bun test JUnit XML output.
 * Reports tests that regressed (pass→fail) under concurrency — race condition candidates.
 *
 * Usage:
 *   bun scripts/concurrency-check.ts --baseline=/tmp/nax-baseline.xml --concurrent=/tmp/nax-concurrent.xml
 */

import { readFileSync } from "fs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v];
  })
);

const baselinePath = args.baseline ?? "/tmp/nax-baseline.xml";
const concurrentPath = args.concurrent ?? "/tmp/nax-concurrent.xml";
const topN = parseInt(args.top ?? "50", 10);

// ── Parse JUnit XML ──────────────────────────────────────────────────────────

type TestCase = {
  name: string;
  classname: string;
  time: number;
  failed: boolean;
  failureMsg?: string;
};

function parseJUnit(xml: string): Map<string, TestCase> {
  const map = new Map<string, TestCase>();

  // Match self-closing testcase (no failure)
  const selfClosing = /<testcase\s([^>]*?)\/>/gs;
  // Match open testcase with content
  const openTag = /<testcase\s([^>]*?)>([\s\S]*?)<\/testcase>/gs;

  function parseAttrs(attrStr: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const re = /(\w+)="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(attrStr)) !== null) {
      attrs[m[1]] = m[2];
    }
    return attrs;
  }

  function addCase(attrStr: string, inner: string) {
    const attrs = parseAttrs(attrStr);
    const name = attrs.name ?? "";
    const classname = attrs.classname ?? "";
    const time = parseFloat(attrs.time ?? "0");
    const failed = inner.includes("<failure") || inner.includes("<error");
    const failureMatch = inner.match(/<(?:failure|error)[^>]*>([\s\S]*?)<\/(?:failure|error)>/);
    const failureMsg = failureMatch ? failureMatch[1].trim().slice(0, 300) : undefined;
    const key = `${classname}::${name}`;
    map.set(key, { name, classname, time, failed, failureMsg });
  }

  // Self-closing first (no inner content)
  let m: RegExpExecArray | null;
  const selfMatches = new Set<number>();
  while ((m = selfClosing.exec(xml)) !== null) {
    selfMatches.add(m.index);
    addCase(m[1], "");
  }

  while ((m = openTag.exec(xml)) !== null) {
    addCase(m[1], m[2]);
  }

  return map;
}

// ── Load both XMLs ───────────────────────────────────────────────────────────

let baselineXml: string;
let concurrentXml: string;

try {
  baselineXml = readFileSync(baselinePath, "utf-8");
} catch {
  console.error(`❌ Cannot read baseline: ${baselinePath}`);
  process.exit(1);
}

try {
  concurrentXml = readFileSync(concurrentPath, "utf-8");
} catch {
  console.error(`❌ Cannot read concurrent: ${concurrentPath}`);
  process.exit(1);
}

const baseline = parseJUnit(baselineXml);
const concurrent = parseJUnit(concurrentXml);

// ── Diff ─────────────────────────────────────────────────────────────────────

type Diff = {
  key: string;
  classname: string;
  name: string;
  kind: "regression" | "new-failure" | "fixed" | "new-pass";
  failureMsg?: string;
};

const diffs: Diff[] = [];

for (const [key, conc] of concurrent) {
  const base = baseline.get(key);
  if (!base) {
    // New test in concurrent run
    if (conc.failed) diffs.push({ key, classname: conc.classname, name: conc.name, kind: "new-failure", failureMsg: conc.failureMsg });
    else diffs.push({ key, classname: conc.classname, name: conc.name, kind: "new-pass" });
  } else if (!base.failed && conc.failed) {
    diffs.push({ key, classname: conc.classname, name: conc.name, kind: "regression", failureMsg: conc.failureMsg });
  } else if (base.failed && !conc.failed) {
    diffs.push({ key, classname: conc.classname, name: conc.name, kind: "fixed" });
  }
}

// Baseline tests missing from concurrent
for (const [key, base] of baseline) {
  if (!concurrent.has(key) && base.failed) {
    diffs.push({ key, classname: base.classname, name: base.name, kind: "fixed" });
  }
}

// ── Summary counts ───────────────────────────────────────────────────────────

const regressions = diffs.filter((d) => d.kind === "regression");
const newFailures = diffs.filter((d) => d.kind === "new-failure");
const fixed = diffs.filter((d) => d.kind === "fixed");

const baseTotal = baseline.size;
const basePass = [...baseline.values()].filter((t) => !t.failed).length;
const baseFail = [...baseline.values()].filter((t) => t.failed).length;

const concTotal = concurrent.size;
const concPass = [...concurrent.values()].filter((t) => !t.failed).length;
const concFail = [...concurrent.values()].filter((t) => t.failed).length;

console.log("\n=== Concurrency Test Comparison ===\n");
console.log(`Baseline:   ${baseTotal} tests — ${basePass} pass, ${baseFail} fail`);
console.log(`Concurrent: ${concTotal} tests — ${concPass} pass, ${concFail} fail`);
console.log();
console.log(`Regressions (pass→fail, race condition candidates): ${regressions.length}`);
console.log(`New failures (only in concurrent run):              ${newFailures.length}`);
console.log(`Fixed (fail→pass):                                  ${fixed.length}`);

// ── Regressions (most important) ─────────────────────────────────────────────

if (regressions.length > 0) {
  console.log("\n--- REGRESSIONS (sequential pass → concurrent fail) ---\n");

  // Group by file
  const byFile = new Map<string, Diff[]>();
  for (const d of regressions) {
    const file = d.classname;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(d);
  }

  for (const [file, tests] of byFile) {
    console.log(`  📁 ${file} (${tests.length} regression${tests.length > 1 ? "s" : ""})`);
    for (const t of tests.slice(0, topN)) {
      console.log(`    ✗ ${t.name}`);
      if (t.failureMsg) {
        const short = t.failureMsg.split("\n")[0].trim().slice(0, 120);
        console.log(`      → ${short}`);
      }
    }
  }
}

// ── New failures ─────────────────────────────────────────────────────────────

if (newFailures.length > 0) {
  console.log("\n--- NEW FAILURES (only in concurrent run) ---\n");
  for (const d of newFailures.slice(0, topN)) {
    console.log(`  ✗ ${d.classname} :: ${d.name}`);
    if (d.failureMsg) {
      const short = d.failureMsg.split("\n")[0].trim().slice(0, 120);
      console.log(`    → ${short}`);
    }
  }
}

// ── Category breakdown ───────────────────────────────────────────────────────

if (regressions.length > 0) {
  console.log("\n--- CATEGORY BREAKDOWN (regression counts by directory) ---\n");
  const catMap = new Map<string, number>();
  for (const d of regressions) {
    // Extract top-level dir from classname (e.g., test/unit/agents/...)
    const parts = d.classname.split("/");
    const cat = parts.length >= 3 ? `${parts[0]}/${parts[1]}/${parts[2]}` : d.classname;
    catMap.set(cat, (catMap.get(cat) ?? 0) + 1);
  }
  const sorted = [...catMap.entries()].sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sorted) {
    console.log(`  ${String(count).padStart(4)}  ${cat}`);
  }
}

if (regressions.length === 0 && newFailures.length === 0) {
  console.log("\n✅ No regressions! All tests pass under concurrency.");
  console.log("   The suite is safe to run with --concurrent.\n");
} else {
  console.log(`\n⚠️  ${regressions.length + newFailures.length} test(s) need --concurrent guard or sequential isolation.\n`);
}
