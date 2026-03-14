#!/usr/bin/env bun
/**
 * run-concurrency-test.ts
 * Runs sequential baseline + concurrent bun test runs, writes JUnit XMLs to /tmp.
 * Usage: bun scripts/run-concurrency-test.ts [--only=baseline|concurrent]
 */

import { spawnSync } from "bun";
import { existsSync, statSync } from "fs";

const nax = new URL("..", import.meta.url).pathname.replace(/\/$/, ""); // repo root
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.split("=")[1];

const env = { ...process.env, NAX_SKIP_PRECHECK: "1" };

function runTests(label: string, extraArgs: string[], outFile: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`  Output: ${outFile}`);
  console.log("=".repeat(60));

  const cmd = [
    "bun", "test", "test/",
    "--timeout=60000",
    "--reporter=junit",
    `--reporter-outfile=${outFile}`,
    ...extraArgs,
  ];

  console.log(`  CMD: ${cmd.join(" ")}\n`);

  const result = Bun.spawnSync(cmd, { cwd: nax, env, stdout: "inherit", stderr: "inherit" });

  const ok = existsSync(outFile);
  const size = ok ? statSync(outFile).size : 0;
  console.log(`\n  Exit: ${result.exitCode} | XML: ${ok ? `${(size / 1024).toFixed(1)} KB` : "NOT FOUND"}`);
  return result.exitCode;
}

let baselineExit = 0;
let concurrentExit = 0;

if (!only || only === "baseline") {
  baselineExit = runTests(
    "SEQUENTIAL BASELINE",
    [],
    "/tmp/nax-baseline.xml"
  );
}

if (!only || only === "concurrent") {
  concurrentExit = runTests(
    "CONCURRENT RUN (--concurrent)",
    ["--concurrent"],
    "/tmp/nax-concurrent.xml"
  );
}

console.log("\n=== Done ===");
if (!only || only === "baseline") console.log(`  Baseline exit:    ${baselineExit}`);
if (!only || only === "concurrent") console.log(`  Concurrent exit:  ${concurrentExit}`);

process.exit(baselineExit !== 0 || concurrentExit !== 0 ? 1 : 0);
