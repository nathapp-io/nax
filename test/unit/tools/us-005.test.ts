/**
 * US-005 — Remove superseded tool truncators.
 *
 * The model-facing truncation policy is now applied at the runtime chokepoint
 * (`applyModelTruncationPolicy`), so the per-tool `truncate()` helpers are
 * dead code. This file pins the three behaviours the deletions must preserve:
 *
 *  - AC1: a Grep result > MODEL_MAX_BYTES is still bounded at the runtime
 *    layer (the model never sees more bytes than MODEL_MAX_BYTES).
 *  - AC2: a Git result > MODEL_MAX_BYTES carries a marker naming the
 *    ORIGINAL byte count, so the model can tell how much it lost.
 *  - AC3: with `ctx.readCeiling` set, both Grep and Git still return at most
 *    that many bytes from the tool itself — the ioCeiling bound is preserved
 *    even after the local truncate() helper goes away.
 *
 * All tests use the REAL grep/git tools (mocking their subprocess deps) so
 * the assertions prove the end-to-end behaviour the chokepoint guarantees,
 * not the behaviour of a stub that already does what the chokepoint does.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDir, makeSpawn, makeTempDir, withDepsRestore } from "@test/helpers";
import { compileToolPolicy, createCodingToolRuntime, gitTool, grepTool, MODEL_MAX_BYTES } from "@/tools";
import { _grepDeps } from "@/tools/grep";
import { _gitDeps } from "@/utils/git";

let root: string;
const realGrepWhich = _grepDeps.which;
const realGrepSpawn = _grepDeps.spawn;

beforeEach(() => {
  root = makeTempDir("nax-us005-");
});

afterEach(() => {
  _grepDeps.which = realGrepWhich;
  _grepDeps.spawn = realGrepSpawn;
  cleanupTempDir(root);
});

// ---------------------------------------------------------------------------
// AC1 — A Grep result larger than MODEL_MAX_BYTES still enters the message
//       array shaped to at most MODEL_MAX_BYTES after the deletions.
// ---------------------------------------------------------------------------

describe("AC1: Grep result > MODEL_MAX_BYTES -> runtime output byte length <= MODEL_MAX_BYTES", () => {
  withDepsRestore(_grepDeps, ["spawn", "which"]);

  test("real grepTool output of ~220_000 bytes -> runtime shapes it to <= MODEL_MAX_BYTES", async () => {
    // Drive grepTool through the runtime with a spawn stub that produces a
    // body much larger than MODEL_MAX_BYTES. The deletions remove the
    // local truncate() helper from grep.ts, so the tool itself no longer
    // bounds at ctx.maxBytes. The runtime's applyModelTruncationPolicy is
    // what the model-facing cap comes from.
    const bigBody = "match-line\n".repeat(20_000); // ~220_000 bytes
    expect(Buffer.byteLength(bigBody, "utf8")).toBeGreaterThan(MODEL_MAX_BYTES);
    _grepDeps.which = (name: string) => (name === "rg" ? "/usr/bin/rg" : null);
    _grepDeps.spawn = makeSpawn(() => ({ stdout: bigBody, exitCode: 0 })).spawn;

    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
    });
    rt.advertised(["Grep"]);
    const outcome = await rt.callTool("Grep", { pattern: "match-line" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    // The runtime's after_tool policy bounded the body at MODEL_MAX_BYTES.
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
  });

  test("boundary: a real grepTool output well below MODEL_MAX_BYTES is returned whole by the runtime", async () => {
    // grepTool trimEnd()s the stdout (see src/tools/grep.ts:166), so the
    // body the runtime sees has no trailing newline. We mirror that here.
    const smallBody = "a.ts:1:needle\nb.ts:7:needle";
    expect(Buffer.byteLength(smallBody, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    _grepDeps.which = (name: string) => (name === "rg" ? "/usr/bin/rg" : null);
    _grepDeps.spawn = makeSpawn(() => ({ stdout: `${smallBody}\n`, exitCode: 0 })).spawn;

    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
    });
    rt.advertised(["Grep"]);
    const outcome = await rt.callTool("Grep", { pattern: "needle" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.content).toBe(smallBody);
  });
});

// ---------------------------------------------------------------------------
// AC2 — A Git result larger than MODEL_MAX_BYTES enters the message array
//       with a marker naming the ORIGINAL byte count.
// ---------------------------------------------------------------------------

describe("AC2: Git result > MODEL_MAX_BYTES -> marker names the original byte count", () => {
  // Each test builds its own repo because git is real and stateful. We
  // commit one file with a body larger than MODEL_MAX_BYTES so `git show`
  // returns a result past the cap.
  const repos: string[] = [];

  afterEach(() => {
    for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function makeRepoWithBigBody(): Promise<string> {
    const repo = mkdtempSync(join(tmpdir(), "nax-us005-git-"));
    repos.push(repo);
    const fullPath = join(repo, "src", "big.txt");
    mkdirSync(join(repo, "src"), { recursive: true });
    // One large line plus a trailing newline so the file is well over
    // MODEL_MAX_BYTES — exactly the shape that needs the runtime cap.
    writeFileSync(fullPath, `${"x".repeat(MODEL_MAX_BYTES + 5_000)}\n`);
    const run = (args: string[]) => _gitDeps.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    await run(["init", "-q"]).exited;
    await run(["config", "user.email", "t@e.com"]).exited;
    await run(["config", "user.name", "T"]).exited;
    await run(["add", "-A"]).exited;
    await run(["commit", "-q", "-m", "big"]).exited;
    return repo;
  }

  test("a real gitTool output > MODEL_MAX_BYTES -> runtime marker names the original byte count", async () => {
    const repo = await makeRepoWithBigBody();
    // Drive gitTool directly first to capture the exact body the tool
    // returns. The runtime's applyModelTruncationPolicy computes the
    // marker's "of N bytes" from `Buffer.byteLength(result.content)`, so
    // the marker's N must equal the byte length of THIS body — a fixed
    // or fabricated count would not match.
    const toolCtx = {
      root: repo,
      resolvedPaths: [],
      maxBytes: MODEL_MAX_BYTES,
      maxFileBytes: 2_000_000,
      // Default readCeiling = READ_CEILING (2_000_000). The body the
      // tool returns is bounded by that, well above MODEL_MAX_BYTES.
    };
    const toolResult = await gitTool.run({ subcommand: "show", refs: ["HEAD"] }, toolCtx);
    expect(toolResult.isError).toBeFalsy();
    const toolBody = toolResult.content;
    const expectedOriginalBytes = Buffer.byteLength(toolBody, "utf8");
    expect(expectedOriginalBytes).toBeGreaterThan(MODEL_MAX_BYTES);

    // Now run the same call through the runtime. The marker's N must equal
    // the byte length of the body the tool returned above — NOT a larger
    // or fabricated number, NOT just "greater than MODEL_MAX_BYTES".
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Git", patterns: ["*"] }], repo),
      maxBytes: MODEL_MAX_BYTES,
    });
    rt.advertised(["Git"]);
    const outcome = await rt.callTool("Git", { subcommand: "show", refs: ["HEAD"] });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    // Runtime caps the body.
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    // The marker's "of N bytes" reports the original body size — exactly
    // the byte length of the body the tool returned.
    expect(outcome.content).toContain(`of ${expectedOriginalBytes} bytes`);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Grep and Git invoked with `ctx.readCeiling` set return at most that
//       many bytes from the tool itself, before any session policy runs.
// ---------------------------------------------------------------------------

describe("AC3: ctx.readCeiling bounds Grep's and Git's tool-level output", () => {
  withDepsRestore(_grepDeps, ["spawn", "which"]);

  const repos: string[] = [];

  afterEach(() => {
    for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("real grepTool with ctx.readCeiling=200 returns <= 200 bytes from the tool", async () => {
    // Drive grepTool directly (no runtime) so the assertion is on the tool
    // layer. The ioCeiling bound must survive the deletion of the local
    // truncate() helper: replacing the call with cutToByteCap is what
    // preserves it. The body length must be <= readCeiling — the local
    // truncate() helper used to add a marker that pushed it slightly over.
    const bigBody = "x".repeat(2_000);
    _grepDeps.which = (name: string) => (name === "rg" ? "/usr/bin/rg" : null);
    _grepDeps.spawn = makeSpawn(() => ({ stdout: bigBody, exitCode: 0 })).spawn;

    const ctx = { root, resolvedPaths: [], maxBytes: 100_000, maxFileBytes: 2_000_000, readCeiling: 200 };
    const result = await grepTool.run({ pattern: "x" }, ctx);
    expect(result.isError).toBeFalsy();
    // The tool layer bounded at readCeiling before any session policy ran.
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(200);
  });

  test("real gitTool with ctx.readCeiling=200 returns <= 200 bytes from the tool", async () => {
    // Same shape as the grep test, but for git. Build a repo whose diff
    // exceeds the ceiling; the tool's own bound must clamp it.
    const repo = mkdtempSync(join(tmpdir(), "nax-us005-git-ceil-"));
    repos.push(repo);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "f.txt"), `${"y".repeat(2_000)}\n`);
    const run = (args: string[]) => _gitDeps.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    await run(["init", "-q"]).exited;
    await run(["config", "user.email", "t@e.com"]).exited;
    await run(["config", "user.name", "T"]).exited;
    await run(["add", "-A"]).exited;
    await run(["commit", "-q", "-m", "seed"]).exited;

    const ctx = { root: repo, resolvedPaths: [], maxBytes: 100_000, maxFileBytes: 2_000_000, readCeiling: 200 };
    const result = await gitTool.run({ subcommand: "show", refs: ["HEAD"] }, ctx);
    expect(result.isError).toBeFalsy();
    // The tool layer bounded at readCeiling before any session policy ran.
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(200);
  });
});
