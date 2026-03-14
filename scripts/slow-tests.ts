#!/usr/bin/env bun
/**
 * slow-tests.ts — identify slow tests from bun JUnit XML output
 *
 * Usage:
 *   bun test --reporter=junit 2>/dev/null | bun run scripts/slow-tests.ts
 *   bun test --reporter=junit 2>/dev/null | bun run scripts/slow-tests.ts --top=30
 *   bun test --reporter=junit 2>/dev/null | bun run scripts/slow-tests.ts --min=500
 *   bun run scripts/slow-tests.ts test-results.xml --top=20 --min=100
 *
 * Flags:
 *   --top=N     Show top N slowest tests (default: 20)
 *   --min=MS    Only show tests >= MS milliseconds (default: 0)
 *   --tsv       Output TSV instead of table (for further processing)
 */

import { readFileSync } from "fs";

// ── Parse flags ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let topN = 20;
let minMs = 0;
let tsv = false;
let inputFile: string | null = null;

for (const arg of args) {
  if (arg.startsWith("--top=")) topN = parseInt(arg.slice(6), 10);
  else if (arg.startsWith("--min=")) minMs = parseInt(arg.slice(6), 10);
  else if (arg === "--tsv") tsv = true;
  else if (!arg.startsWith("--")) inputFile = arg;
}

// ── Read input ─────────────────────────────────────────────────────────────────

async function readInput(): Promise<string> {
  if (inputFile) {
    return readFileSync(inputFile, "utf8");
  }
  // Read from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ── Parse JUnit XML ────────────────────────────────────────────────────────────

interface TestCase {
  name: string;
  classname: string;
  file: string;
  durationMs: number;
  status: "pass" | "fail" | "skip";
}

function parseJUnit(xml: string): TestCase[] {
  const results: TestCase[] = [];

  // Match all <testcase ...> blocks.
  // IMPORTANT: self-closing alternative must come FIRST — otherwise the open-tag
  // pattern matches `/>` as attrs-char + `>`, consuming multiple testcases in one hit.
  const testcaseRegex = /<testcase([^>]*?)\/>\s*|<testcase([^>]*?)>([\s\S]*?)<\/testcase>/g;
  let match: RegExpExecArray | null;

  while ((match = testcaseRegex.exec(xml)) !== null) {
    const isSelfClosing = match[1] !== undefined;
    const attrs = isSelfClosing ? match[1] : match[2] ?? "";
    const inner = isSelfClosing ? "" : match[3] ?? "";

    const name = extractAttr(attrs, "name");
    const classname = extractAttr(attrs, "classname");
    const timeStr = extractAttr(attrs, "time");

    if (!name || !timeStr) continue;

    const durationMs = Math.round(parseFloat(timeStr) * 1000);

    // Derive file from classname (bun uses file path as classname)
    // e.g. "test/unit/agents/acp/adapter.test.ts" or "test > unit > ..."
    const file = classnameToFile(classname);

    // Determine status
    let status: TestCase["status"] = "pass";
    if (/<failure/i.test(inner) || /<error/i.test(inner)) status = "fail";
    else if (/<skipped/i.test(inner)) status = "skip";

    results.push({ name, classname, file, durationMs, status });
  }

  return results;
}

function extractAttr(attrs: string, key: string): string {
  const m = attrs.match(new RegExp(`${key}="([^"]*)"`));
  return m ? decodeXmlEntities(m[1]) : "";
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function classnameToFile(classname: string): string {
  // Bun JUnit classname is usually the file path
  // Strip any leading path prefix noise
  if (classname.includes(".test.ts") || classname.includes(".spec.ts")) {
    // Extract just the path portion
    const m = classname.match(/((?:test|src)\/[\w/.-]+\.(?:test|spec)\.ts)/);
    if (m) return m[1];
  }
  // Fallback: truncate to last 60 chars if too long
  return classname.length > 60 ? "…" + classname.slice(-59) : classname;
}

// ── Format output ─────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(3)}s`;
  return `${ms}ms`;
}

function statusIcon(s: TestCase["status"]): string {
  if (s === "fail") return "✗";
  if (s === "skip") return "~";
  return "✓";
}

function printTable(tests: TestCase[]): void {
  if (tests.length === 0) {
    console.log("No tests found matching criteria.");
    return;
  }

  // Column widths
  const rankW = 4;
  const durW = 9;
  const statusW = 2;
  const fileW = Math.min(50, Math.max(20, ...tests.map((t) => t.file.length)));
  const nameW = Math.min(60, Math.max(20, ...tests.map((t) => t.name.length)));

  const header = [
    "Rank".padEnd(rankW),
    "Duration".padEnd(durW),
    "S",
    "File".padEnd(fileW),
    "Test Name",
  ].join("  ");

  const sep = [
    "─".repeat(rankW),
    "─".repeat(durW),
    "─",
    "─".repeat(fileW),
    "─".repeat(nameW),
  ].join("  ");

  console.log(`\n🐢 Slowest Tests (top ${tests.length}, min ${minMs}ms)\n`);
  console.log(header);
  console.log(sep);

  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    const rank = `#${i + 1}`.padEnd(rankW);
    const dur = formatDuration(t.durationMs).padEnd(durW);
    const st = statusIcon(t.status);
    const file = t.file.length > fileW ? "…" + t.file.slice(-(fileW - 1)) : t.file.padEnd(fileW);
    const name = t.name.length > nameW ? t.name.slice(0, nameW - 1) + "…" : t.name;
    console.log(`${rank}  ${dur}  ${st}  ${file}  ${name}`);
  }

  const total = tests.reduce((s, t) => s + t.durationMs, 0);
  console.log(sep);
  console.log(`\nTotal time in top ${tests.length}: ${formatDuration(total)}`);
}

function printTsv(tests: TestCase[]): void {
  console.log("rank\tduration_ms\tstatus\tfile\tname");
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    console.log(`${i + 1}\t${t.durationMs}\t${t.status}\t${t.file}\t${t.name}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const xml = await readInput();

if (!xml.trim()) {
  console.error("Error: no input received. Pipe JUnit XML or pass a file path.");
  process.exit(1);
}

if (!xml.includes("<testcase")) {
  console.error("Error: input does not appear to be JUnit XML (no <testcase> elements found).");
  console.error("Make sure to run: bun test --reporter=junit 2>/dev/null | bun run scripts/slow-tests.ts");
  process.exit(1);
}

const all = parseJUnit(xml);
const filtered = all
  .filter((t) => t.durationMs >= minMs)
  .sort((a, b) => b.durationMs - a.durationMs)
  .slice(0, topN);

if (tsv) {
  printTsv(filtered);
} else {
  printTable(filtered);
  console.log(`\n(${all.length} total test cases parsed)`);
}
