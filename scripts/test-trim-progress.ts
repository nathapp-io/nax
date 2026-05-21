#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const baselinePath = "docs/plans/PLAN-test-suite-trim.baseline.md";
const baseline = readFileSync(baselinePath, "utf-8");

const baseMatch = baseline.match(/## Files\s+(\d+)\s+## Tests\s+(\d+)\s+## Lines\s+(\d+)/s);
if (!baseMatch || baseMatch.length < 4) {
  console.error("Could not parse baseline file");
  process.exit(1);
}

const baseFiles = parseInt(baseMatch[1]);
const baseTests = parseInt(baseMatch[2]);
const baseLines = parseInt(baseMatch[3]);

const currentFiles = parseInt(execSync('find test -name "*.test.ts" | wc -l', { encoding: "utf-8" }).trim());
const currentTests = parseInt(execSync('grep -rE "^\\s*(test|it)\\(" test --include="*.test.ts" | wc -l', { encoding: "utf-8" }).trim());
const currentLines = parseInt(execSync('find test -name "*.test.ts" -exec cat {} + | wc -l', { encoding: "utf-8" }).trim());

const fmt = (cur: number, base: number) => {
  const diff = cur - base;
  const sign = diff >= 0 ? "+" : "";
  return `${cur} (${sign}${diff})`;
};

console.log(`files:  ${fmt(currentFiles, baseFiles)}`);
console.log(`tests:  ${fmt(currentTests, baseTests)}`);
console.log(`lines:  ${fmt(currentLines, baseLines)}`);

const testPct = ((currentTests - baseTests) / baseTests * 100).toFixed(1);
console.log(`tests: ${currentTests} vs baseline ${baseTests} (${testPct}%)`);