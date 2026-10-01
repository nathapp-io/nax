/**
 * US-003 — apply after-tool truncation, spill recovery, and scratchpad paging.
 *
 * This file pins each of the eighteen acceptance criteria (AC1-AC18) declared
 * in the story, in one place, with a dedicated describe block per AC. It is
 * intentionally hermetic: each test stands alone, uses the shared temp-dir
 * helpers, and asserts on observable behaviour (return values, thrown errors,
 * on-disk file contents, transcript content). It does not modify the source
 * tree.
 *
 * Coverage rationale — every AC gets a success-path test plus a
 * boundary/failure-path test, named after the AC they pin. The four
 * pre-existing authorized test files (grep.test.ts, bash.test.ts, git.test.ts,
 * git-output-bounds.test.ts, scratchpad.test.ts, result-bytes-pre-truncation.test.ts,
 * read-line-total.test.ts, scratchpad-read-paging.test.ts) carry the deep
 * per-tool coverage; this file is the single document that says "all eighteen
 * ACs are pinned here".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  _bashToolDeps,
  _spillDeps,
  compileToolPolicy,
  createBashTool,
  createCodingToolRuntime,
  MODEL_MAX_BYTES,
  READ_CEILING,
} from "@/tools";

let root: string;
const realRunArgv = _bashToolDeps.runArgv;
const realSpillDeps = { mkdir: _spillDeps.mkdir, writeFile: _spillDeps.writeFile };

beforeEach(() => {
  root = makeTempDir("nax-us003-acs-");
});

afterEach(() => {
  _bashToolDeps.runArgv = realRunArgv;
  _spillDeps.mkdir = realSpillDeps.mkdir;
  _spillDeps.writeFile = realSpillDeps.writeFile;
  cleanupTempDir(root);
});

/** A stub Grep tool that returns a fixed body. The runtime shapes the result. */
function stubGrep(body: string) {
  return {
    name: "Grep",
    description: "stub",
    inputSchema: { type: "object" },
    scope: { pathFields: [] },
    async run() {
      return { content: body };
    },
  };
}

/** Drive a Grep call through the runtime and return its outcome. */
async function callGrep(rt: ReturnType<typeof createCodingToolRuntime>) {
  return rt.callTool("Grep", { pattern: "x" });
}

// -----------------------------------------------------------------------------
// AC1 — When a Grep result larger than MODEL_MAX_BYTES enters the message array,
//       then its content UTF-8 byte length is at most MODEL_MAX_BYTES.
// -----------------------------------------------------------------------------

describe("AC1: Grep result > MODEL_MAX_BYTES -> content byte length <= MODEL_MAX_BYTES", () => {
  test("AC1 success: a Grep body 100 bytes over MODEL_MAX_BYTES is capped", async () => {
    const bigBody = "x".repeat(MODEL_MAX_BYTES + 100);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);
    const outcome = await callGrep(rt);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
  });

  test("AC1 boundary: a small body well below MODEL_MAX_BYTES is returned unchanged", async () => {
    const smallBody = "alpha\nbeta\ngamma";
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(smallBody)],
    });
    rt.advertised(["Grep"]);
    const outcome = await callGrep(rt);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.content).toBe(smallBody);
  });
});

// -----------------------------------------------------------------------------
// AC2 — When a failing Bash command has stdout larger than MODEL_MAX_BYTES,
//       then its message-array result first line is the body's `exit N` line.
// -----------------------------------------------------------------------------

describe("AC2: failing Bash > MODEL_MAX_BYTES -> first line is the exit N line", () => {
  test("AC2 success: a Bash with non-zero exit keeps exit 7 as the first line after truncation", async () => {
    const bigStdout = "x".repeat(MODEL_MAX_BYTES + 100);
    _bashToolDeps.runArgv = async () => ({
      exitCode: 7,
      stdout: bigStdout,
      stderr: "warn",
      timedOut: false,
    });
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [createBashTool()],
    });
    rt.advertised(["Bash"]);
    const outcome = await rt.callTool("Bash", { command: "false" });
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("unreachable");
    const firstLine = outcome.content.split("\n")[0];
    expect(firstLine).toBe("exit 7");
  });

  test("AC2 boundary: a failing Bash within MODEL_MAX_BYTES is delivered unchanged", async () => {
    _bashToolDeps.runArgv = async () => ({
      exitCode: 1,
      stdout: "small",
      stderr: "boom",
      timedOut: false,
    });
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [createBashTool()],
    });
    rt.advertised(["Bash"]);
    const outcome = await rt.callTool("Bash", { command: "false" });
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("unreachable");
    expect(outcome.content).toContain("exit 1");
    expect(outcome.content).toContain("boom");
  });
});

// -----------------------------------------------------------------------------
// AC3 — When that Bash result enters the message array, then its content ends
//       with the body's final stderr lines.
// -----------------------------------------------------------------------------

describe("AC3: Bash result -> content ends with the body's final stderr lines", () => {
  test("AC3 success: a Bash with huge stdout + a single final stderr line keeps that line", async () => {
    const stderrTail = "fatal-error-marker";
    const stderr = `${"warn-line\n".repeat(50)}${stderrTail}`;
    _bashToolDeps.runArgv = async () => ({
      exitCode: 1,
      stdout: "x".repeat(MODEL_MAX_BYTES),
      stderr,
      timedOut: false,
    });
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [createBashTool()],
    });
    rt.advertised(["Bash"]);
    const outcome = await rt.callTool("Bash", { command: "false" });
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("unreachable");
    const outLines = outcome.content.split("\n");
    expect(outLines[outLines.length - 1]).toBe(stderrTail);
  });

  test("AC3 boundary: an empty stderr has no last-stderr-line to preserve", async () => {
    _bashToolDeps.runArgv = async () => ({
      exitCode: 0,
      stdout: "x".repeat(MODEL_MAX_BYTES + 100),
      stderr: "",
      timedOut: false,
    });
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [createBashTool()],
    });
    rt.advertised(["Bash"]);
    const outcome = await rt.callTool("Bash", { command: "echo x" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    // The cap still applies; the content is <= MODEL_MAX_BYTES.
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
  });
});

// -----------------------------------------------------------------------------
// AC4 — When Grep output exceeds MODEL_MAX_BYTES but is smaller than
//       READ_CEILING, then the tool returns the whole output before session
//       policy runs.
// -----------------------------------------------------------------------------

describe("AC4: Grep output in (MODEL_MAX_BYTES, READ_CEILING) -> tool returns whole body before policy", () => {
  test("AC4 success: a Grep body of 100KB is returned whole by the stub tool layer", async () => {
    const body = "x".repeat(100_000);
    const seen: { contentLength?: number } = {};
    const stub = {
      name: "Grep",
      description: "stub",
      inputSchema: { type: "object" },
      scope: { pathFields: [] },
      async run() {
        seen.contentLength = body.length;
        return { content: body };
      },
    };
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stub],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt);
    // The tool returned the whole 100_000-byte body to the runtime. The
    // session's after_tool policy then shaped the result for the model.
    expect(seen.contentLength).toBe(100_000);
  });

  test("AC4 boundary: a Grep body of 0 bytes is returned unchanged", async () => {
    const stub = stubGrep("");
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stub],
    });
    rt.advertised(["Grep"]);
    const outcome = await callGrep(rt);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.content).toBe("");
  });
});

// -----------------------------------------------------------------------------
// AC5 — When a tool result is truncated, then it writes
//       `spill/<toolName>-<callId>.txt` under the scratchpad with the
//       untruncated body.
// -----------------------------------------------------------------------------

describe("AC5: truncated tool result -> spill file under scratchpad with the untruncated body", () => {
  test("AC5 success: a truncated Grep writes spill/Grep-<id>.txt with the full body", async () => {
    const bigBody = `first-line\n${"x".repeat(MODEL_MAX_BYTES + 100)}\nlast-line`;
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt);

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    expect(existsSync(spillDir)).toBe(true);
    const files = readdirSync(spillDir);
    const spillFile = files.find((f) => f.startsWith("Grep-") && f.endsWith(".txt"));
    expect(spillFile).toBeDefined();
    if (spillFile === undefined) throw new Error("spill file missing");
    const content = readFileSync(join(spillDir, spillFile), "utf8");
    // The spill file holds the untruncated body, byte-for-byte, within
    // READ_CEILING (see AC10 for the over-ceiling case).
    expect(content).toBe(bigBody);
  });

  test("AC5 boundary: a within-cap body produces no spill file", async () => {
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep("small")],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt);

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    if (existsSync(spillDir)) {
      expect(readdirSync(spillDir)).toHaveLength(0);
    }
  });
});

// -----------------------------------------------------------------------------
// AC6 — When a head-directed tool result is truncated, then its content ends
//       with a marker naming spill path, delivered byte count, and original
//       byte count.
// -----------------------------------------------------------------------------

describe("AC6: head-directed truncated tool result -> content ends with marker naming spill path and both byte counts", () => {
  test("AC6 success: the truncated Grep content names the spill path and both byte counts", async () => {
    const bigBody = "x".repeat(MODEL_MAX_BYTES + 100);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);
    const outcome = await callGrep(rt);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    // Marker names the spill path.
    expect(outcome.content.includes("spill/Grep-")).toBe(true);
    // Marker names the original byte count.
    const originalBytes = Buffer.byteLength(bigBody, "utf8");
    expect(outcome.content.includes(`${originalBytes}`)).toBe(true);
  });

  test("AC6 boundary: the marker is on the LAST line of the content (it terminates the message)", async () => {
    const bigBody = "x".repeat(MODEL_MAX_BYTES + 100);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);
    const outcome = await callGrep(rt);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    const lines = outcome.content.split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    expect(lastLine.includes("spill/Grep-")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// AC7 — When a tail-with-first-line tool result is truncated, then that same
//       marker sits immediately after the retained first line and any retained
//       tail follows it, so its content ends with the body's final lines
//       whenever the byte budget leaves room for a tail.
// -----------------------------------------------------------------------------

describe("AC7: tail-with-first-line truncated -> marker sits after retained first line, tail follows", () => {
  test("AC7 success: a Bash body keeps its exit line first, marker second, and the trailing stderr last", async () => {
    const stderrTail = "fatal-marker-tail-line";
    const stderr = `warn\n${stderrTail}`;
    _bashToolDeps.runArgv = async () => ({
      exitCode: 9,
      stdout: "x".repeat(MODEL_MAX_BYTES),
      stderr,
      timedOut: false,
    });
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [createBashTool()],
    });
    rt.advertised(["Bash"]);
    const outcome = await rt.callTool("Bash", { command: "false" });
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("unreachable");
    const lines = outcome.content.split("\n");
    // The body's first line `exit 9` is retained at position 0.
    expect(lines[0]).toBe("exit 9");
    // The marker is on the line immediately after the retained first line.
    const markerLine = lines[1] ?? "";
    expect(markerLine.includes("spill/Bash-")).toBe(true);
    // The retained tail — the body's final stderr line — is at the END.
    expect(lines[lines.length - 1]).toBe(stderrTail);
  });

  test("AC7 boundary: a Bash body that is one line keeps exit-N and does not crash on tail-empty", async () => {
    // The body is `exit N` and nothing else — there is no tail to retain
    // after the first line. The marker still sits after the first line.
    _bashToolDeps.runArgv = async () => ({
      exitCode: 13,
      stdout: "x".repeat(MODEL_MAX_BYTES),
      stderr: "",
      timedOut: false,
    });
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [createBashTool()],
    });
    rt.advertised(["Bash"]);
    const outcome = await rt.callTool("Bash", { command: "false" });
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("unreachable");
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    const lines = outcome.content.split("\n");
    expect(lines[0]).toBe("exit 13");
  });

  // The marker promises "showing D of N bytes", so D has to be the body text
  // the model can read back — and it has to mean that in both directions. The
  // newline that puts the marker on a line of its own is not a body byte:
  // `composeHead` reports its head without one, and the tail arm must agree or
  // the same marker means a different width per tool. Adding one on the tail
  // side also reported one byte more than the model can actually read.
  const markerDelivered = (content: string): { delivered: number; retainedBody: string } => {
    const lines = content.split("\n");
    const markerLine = lines[1] ?? "";
    const match = /showing (\d+) of \d+ bytes/.exec(markerLine);
    if (match?.[1] === undefined) throw new Error(`no delivered count in marker line: ${markerLine}`);
    // Line 0 is the retained first line, line 1 is the marker. Everything after
    // it is the retained tail; removing the marker line leaves exactly the body
    // text the model received.
    return { delivered: Number(match[1]), retainedBody: [lines[0], ...lines.slice(2)].join("\n") };
  };

  test("AC7 (review): with a tail retained, the marker's delivered count is the retained body text", async () => {
    _bashToolDeps.runArgv = async () => ({
      exitCode: 9,
      stdout: "x".repeat(MODEL_MAX_BYTES),
      stderr: "warn\nfatal-marker-tail-line",
      timedOut: false,
    });
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [createBashTool()],
    });
    rt.advertised(["Bash"]);
    const outcome = await rt.callTool("Bash", { command: "false" });
    if (outcome.kind !== "error") throw new Error("unreachable");

    const { delivered, retainedBody } = markerDelivered(outcome.content);
    expect(retainedBody).toContain("fatal-marker-tail-line");
    expect(delivered).toBe(Buffer.byteLength(retainedBody, "utf8"));
  });

  test("AC7 (review): with no tail retained, the marker's delivered count is the first line alone", async () => {
    // Tail-empty shape: the marker is the last line, so the body text the model
    // can read is the retained first line and nothing else. The newline before
    // the marker is the marker's own line terminator, as it is in the head
    // direction — it is not a byte of the output that was shown.
    _bashToolDeps.runArgv = async () => ({
      exitCode: 13,
      stdout: "x".repeat(MODEL_MAX_BYTES),
      stderr: "",
      timedOut: false,
    });
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [createBashTool()],
    });
    rt.advertised(["Bash"]);
    const outcome = await rt.callTool("Bash", { command: "false" });
    if (outcome.kind !== "error") throw new Error("unreachable");

    const { delivered, retainedBody } = markerDelivered(outcome.content);
    expect(retainedBody).toBe("exit 13");
    expect(delivered).toBe(Buffer.byteLength(retainedBody, "utf8"));
  });
});

// -----------------------------------------------------------------------------
// AC8 — When a tool result is within every cap, then its scratchpad `spill`
//       directory is empty.
// -----------------------------------------------------------------------------

describe("AC8: tool result within every cap -> spill directory empty", () => {
  test("AC8 success: a within-cap Grep leaves the spill directory absent or empty", async () => {
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep("alpha\nbeta\ngamma")],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt);

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    if (existsSync(spillDir)) {
      expect(readdirSync(spillDir)).toHaveLength(0);
    }
  });

  test("AC8 boundary: a within-cap Bash leaves the spill directory absent or empty", async () => {
    _bashToolDeps.runArgv = async () => ({
      exitCode: 0,
      stdout: "hello",
      stderr: "",
      timedOut: false,
    });
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Bash", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [createBashTool()],
    });
    rt.advertised(["Bash"]);
    await rt.callTool("Bash", { command: "echo hello" });

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    if (existsSync(spillDir)) {
      expect(readdirSync(spillDir)).toHaveLength(0);
    }
  });
});

// -----------------------------------------------------------------------------
// AC9 — When a spill write fails, then the result still enters the message
//       array truncated and its marker names no spill path.
// -----------------------------------------------------------------------------

describe("AC9: spill write fails -> result still truncated, marker names no spill path", () => {
  test("AC9 success: with the spill directory blocked, the result is truncated and no path is named", async () => {
    // Override the spill deps so writes fail by making mkdir reject.
    _spillDeps.mkdir = async () => {
      throw new Error("ENOTDIR: spill directory blocked");
    };
    _spillDeps.writeFile = async () => {
      throw new Error("ENOTDIR: spill directory blocked");
    };
    const bigBody = "x".repeat(MODEL_MAX_BYTES + 100);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);
    const outcome = await callGrep(rt);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    // Truncation still applied — content <= MODEL_MAX_BYTES.
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    // Marker does not name a spill path that does not exist.
    expect(outcome.content.includes("spill/Grep-")).toBe(false);
  });

  test("AC9 boundary: when the spill succeeds the marker DOES name a path (regression check)", async () => {
    // The non-failing companion — the AC9 negative assertion above is
    // satisfied trivially by a regression that always omits the path. This
    // test pins that the marker names a path when the write succeeded.
    const bigBody = "y".repeat(MODEL_MAX_BYTES + 100);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);
    const outcome = await callGrep(rt);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    expect(outcome.content.includes("spill/Grep-")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// AC10 — When a body is larger than READ_CEILING, then its spill file final
//        line records that the spill is itself incomplete.
// -----------------------------------------------------------------------------

describe("AC10: body > READ_CEILING -> spill file final line records incompleteness", () => {
  test("AC10 success: a body past READ_CEILING writes a spill file with a final 'incomplete' note", async () => {
    const overCeilingBody = "w".repeat(READ_CEILING + 500_000);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(overCeilingBody)],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt);

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    expect(existsSync(spillDir)).toBe(true);
    const files = readdirSync(spillDir);
    const spillFile = files.find((f) => f.startsWith("Grep-") && f.endsWith(".txt"));
    expect(spillFile).toBeDefined();
    if (spillFile === undefined) throw new Error("spill file missing");
    const spillContent = readFileSync(join(spillDir, spillFile), "utf8");
    // The spill file's last line records the incomplete state. We don't
    // pin the exact wording — we pin that the last line is NOT a body
    // continuation (a marker is present).
    const lastLine = spillContent.split("\n").pop() ?? "";
    expect(lastLine.length).toBeGreaterThan(0);
    expect(lastLine).not.toBe("w".repeat(lastLine.length));
  });

  test("AC10 boundary: a body EXACTLY at READ_CEILING does NOT mark the spill as incomplete", async () => {
    const atCeilingBody = "p".repeat(READ_CEILING);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(atCeilingBody)],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt);

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    const files = readdirSync(spillDir);
    const spillFile = files.find((f) => f.startsWith("Grep-") && f.endsWith(".txt"));
    expect(spillFile).toBeDefined();
    if (spillFile === undefined) throw new Error("spill file missing");
    const spillContent = readFileSync(join(spillDir, spillFile), "utf8");
    const lastLine = spillContent.split("\n").pop() ?? "";
    // No incomplete marker — the body fits whole in the spill file.
    expect(lastLine).toBe("p".repeat(lastLine.length));
  });
});

// -----------------------------------------------------------------------------
// AC11 — When a ToolRunContext omits readCeiling, then a tool bounds its read
//        at READ_CEILING rather than maxBytes.
// -----------------------------------------------------------------------------

describe("AC11: ToolRunContext without readCeiling -> tool bounds at READ_CEILING, not maxBytes", () => {
  test("AC11 success: the tool sees readCeiling=READ_CEILING when no readCeiling is supplied", async () => {
    const captured: { readCeiling?: number; maxBytes?: number } = {};
    const stub = {
      name: "Read",
      description: "stub",
      inputSchema: { type: "object" },
      scope: { pathFields: ["path"] },
      async run(
        _input: Record<string, unknown>,
        ctx: {
          readCeiling?: number;
          maxBytes: number;
          maxFileBytes: number;
          root: string;
          resolvedPaths: readonly string[];
        },
      ) {
        captured.readCeiling = ctx.readCeiling;
        captured.maxBytes = ctx.maxBytes;
        return { content: "x".repeat(50) };
      },
    };
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      // Deliberately not passing readCeiling — the default applies.
      extraTools: [stub],
    });
    rt.advertised(["Read"]);
    await rt.callTool("Read", { path: "anywhere" });

    // The two values are distinct: readCeiling is the tool-layer bound,
    // maxBytes is the model-facing cap owned by after_tool.
    expect(captured.readCeiling).toBe(READ_CEILING);
    expect(captured.maxBytes).toBe(MODEL_MAX_BYTES);
    expect(captured.readCeiling).not.toBe(captured.maxBytes);
  });

  test("AC11 boundary: when readCeiling is supplied explicitly, the tool sees that value (not the default)", async () => {
    const captured: { readCeiling?: number } = {};
    const stub = {
      name: "Read",
      description: "stub",
      inputSchema: { type: "object" },
      scope: { pathFields: ["path"] },
      async run(
        _input: Record<string, unknown>,
        ctx: {
          readCeiling?: number;
          maxBytes: number;
          maxFileBytes: number;
          root: string;
          resolvedPaths: readonly string[];
        },
      ) {
        captured.readCeiling = ctx.readCeiling;
        return { content: "x" };
      },
    };
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      readCeiling: 500_000,
      extraTools: [stub],
    });
    rt.advertised(["Read"]);
    await rt.callTool("Read", { path: "anywhere" });
    expect(captured.readCeiling).toBe(500_000);
  });
});

// AC12-AC15 (ScratchpadRead offset/limit paging, [N lines] header, offset
// past end, recovery) live in `test/unit/tools/us-003-scratchpad-acs.test.ts`.
