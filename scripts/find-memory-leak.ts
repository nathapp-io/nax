#!/usr/bin/env bun
/**
 * Per-file test isolation runner for memory-leak investigation.
 *
 * Runs every *.test.ts under --dir in its own short-lived `bun test` child,
 * caps each with --timeout seconds, samples peak RSS from /proc/<pid>/status,
 * and writes a ranked CSV of suspects to --out.
 *
 * Verdicts:
 *   HANG     — child exited 124 (timeout)
 *   CRASH    — child exited 134 (SIGABRT), 132 (SIGILL), 139 (SIGSEGV)
 *   MEM_HIGH — peak RSS exceeded --mem-threshold (default 500 MB)
 *   FAIL     — any other non-zero exit
 *   OK       — clean exit, peak RSS under threshold
 *
 * Usage:
 *   bun run scripts/find-memory-leak.ts
 *   bun run scripts/find-memory-leak.ts --dir test/unit/runtime --parallel 2 --timeout 60
 *   bun run scripts/find-memory-leak.ts --out /tmp/leak.csv --mem-threshold 250
 */

import { readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { byCodePoint } from "../src/utils/sort";

interface Options {
  dir: string;
  timeoutSec: number;
  parallel: number;
  memThresholdMb: number;
  outPath: string;
}

interface Result {
  file: string;
  exitCode: number;
  durationMs: number;
  peakRssMb: number;
  verdict: "OK" | "HANG" | "CRASH" | "MEM_HIGH" | "FAIL";
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string, fallback: string): string => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? (argv[idx + 1] ?? fallback) : fallback;
  };
  return {
    dir: get("--dir", "test/unit"),
    timeoutSec: Number.parseInt(get("--timeout", "30"), 10),
    parallel: Number.parseInt(get("--parallel", "4"), 10),
    memThresholdMb: Number.parseInt(get("--mem-threshold", "500"), 10),
    outPath: get("--out", "/tmp/find-memory-leak.csv"),
  };
}

async function findTestFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && p.endsWith(".test.ts")) out.push(p);
    }
  }
  const exists = await stat(root).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!exists) throw new Error(`Directory not found: ${root}`);
  await walk(root);
  return out.sort(byCodePoint);
}

async function readRssKb(pid: number): Promise<number | null> {
  try {
    const text = await Bun.file(`/proc/${pid}/status`).text();
    const m = text.match(/^VmRSS:\s+(\d+)\s*kB/m);
    const digits = m?.[1];
    return digits === undefined ? null : Number.parseInt(digits, 10);
  } catch {
    return null;
  }
}

async function pollPeakRss(pid: number, signal: AbortSignal): Promise<number> {
  let peakKb = 0;
  while (!signal.aborted) {
    const rss = await readRssKb(pid);
    if (rss === null) break;
    if (rss > peakKb) peakKb = rss;
    await new Promise<void>((r) => {
      const t = setTimeout(r, 500);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        r();
      });
    });
  }
  return Math.round(peakKb / 1024);
}

async function runOne(file: string, opts: Options): Promise<Result> {
  const start = performance.now();
  const proc = Bun.spawn(["timeout", "-k", "5s", `${opts.timeoutSec}s`, "bun", "test", file, "--timeout=5000"], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  const abort = new AbortController();
  const peakPromise = pollPeakRss(proc.pid, abort.signal);
  const exitCode = await proc.exited;
  abort.abort();
  const peakRssMb = await peakPromise;
  const durationMs = Math.round(performance.now() - start);

  let verdict: Result["verdict"] = "OK";
  if (exitCode === 124) verdict = "HANG";
  else if (exitCode === 134 || exitCode === 132 || exitCode === 139) verdict = "CRASH";
  else if (exitCode !== 0) verdict = "FAIL";
  else if (peakRssMb >= opts.memThresholdMb) verdict = "MEM_HIGH";

  return { file, exitCode, durationMs, peakRssMb, verdict };
}

async function runBatched(files: string[], opts: Options): Promise<Result[]> {
  const results: Result[] = [];
  let cursor = 0;
  let done = 0;
  const total = files.length;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      const file = files[idx];
      if (file === undefined) return;
      const result = await runOne(file, opts);
      results.push(result);
      done++;
      const tag =
        result.verdict === "OK"
          ? "  "
          : result.verdict === "HANG"
            ? "!!"
            : result.verdict === "CRASH"
              ? "XX"
              : result.verdict === "MEM_HIGH"
                ? "**"
                : "  ";
      const rel = file.replace(`${process.cwd()}/`, "");
      console.log(
        `[${String(done).padStart(3)}/${total}] ${tag} ${result.verdict.padEnd(8)} ${result.peakRssMb.toString().padStart(5)}MB ${result.durationMs.toString().padStart(6)}ms  ${rel}`,
      );
    }
  }

  await Promise.all(Array.from({ length: Math.min(opts.parallel, files.length) }, () => worker()));
  return results;
}

function rank(results: Result[]): Result[] {
  const score = (r: Result): number => {
    if (r.verdict === "HANG") return 1000 + r.peakRssMb;
    if (r.verdict === "CRASH") return 800 + r.peakRssMb;
    if (r.verdict === "MEM_HIGH") return 500 + r.peakRssMb;
    if (r.verdict === "FAIL") return 200 + r.peakRssMb;
    return r.peakRssMb;
  };
  return [...results].sort((a, b) => score(b) - score(a));
}

async function writeCsv(results: Result[], outPath: string): Promise<void> {
  const header = "file,exit_code,duration_ms,peak_rss_mb,verdict\n";
  const rows = results.map((r) => `${r.file},${r.exitCode},${r.durationMs},${r.peakRssMb},${r.verdict}`).join("\n");
  await writeFile(outPath, header + rows + "\n", "utf8");
}

function printSummary(results: Result[], opts: Options): void {
  const by = (v: Result["verdict"]): number => results.filter((r) => r.verdict === v).length;
  console.log("\n=== Summary ===");
  console.log(`  Total files:  ${results.length}`);
  console.log(`  OK:           ${by("OK")}`);
  console.log(`  MEM_HIGH:     ${by("MEM_HIGH")}  (>= ${opts.memThresholdMb} MB)`);
  console.log(`  HANG:         ${by("HANG")}  (exit 124)`);
  console.log(`  CRASH:        ${by("CRASH")}  (SIGABRT/SIGILL/SIGSEGV)`);
  console.log(`  FAIL:         ${by("FAIL")}  (other non-zero)`);

  const suspects = rank(results).filter((r) => r.verdict !== "OK");
  if (suspects.length === 0) {
    console.log("\nNo suspects found.");
    return;
  }
  console.log(`\n=== Top suspects (top ${Math.min(20, suspects.length)}) ===`);
  for (const r of suspects.slice(0, 20)) {
    const rel = r.file.replace(`${process.cwd()}/`, "");
    console.log(
      `  ${r.verdict.padEnd(8)} ${r.peakRssMb.toString().padStart(5)}MB ${r.durationMs.toString().padStart(6)}ms  ${rel}`,
    );
  }
  console.log(`\nFull CSV written to: ${opts.outPath}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `[find-memory-leak] dir=${opts.dir} timeout=${opts.timeoutSec}s parallel=${opts.parallel} mem-threshold=${opts.memThresholdMb}MB`,
  );

  const files = await findTestFiles(resolve(opts.dir));
  console.log(`[find-memory-leak] Discovered ${files.length} test files`);
  if (files.length === 0) {
    console.error("No *.test.ts files found.");
    process.exit(1);
  }

  const started = performance.now();
  const results = await runBatched(files, opts);
  const elapsed = Math.round((performance.now() - started) / 1000);
  console.log(`\n[find-memory-leak] Completed in ${elapsed}s`);

  await writeCsv(rank(results), opts.outPath);
  printSummary(results, opts);

  const hasSuspect = results.some((r) => r.verdict !== "OK");
  process.exit(hasSuspect ? 2 : 0);
}

await main();
