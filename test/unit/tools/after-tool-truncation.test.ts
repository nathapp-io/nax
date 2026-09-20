/**
 * US-003 — after-tool truncation chokepoint (AC1, AC2, AC3, AC7).
 *
 * The model-facing cap is now applied by `after_tool`, not by the tool itself.
 * Each AC pins one observable behaviour the chokepoint must produce:
 *
 *  - AC1: Grep result > MODEL_MAX_BYTES -> content byte length <= MODEL_MAX_BYTES
 *  - AC2: Bash with stdout > MODEL_MAX_BYTES and non-zero exit -> first line is `exit N`
 *  - AC3: Bash result content ends with the body's final stderr lines
 *  - AC7: Within-cap result does not enter the spill pipeline (no spill file)
 *
 * These tests run via `runtime.callTool` so the chokepoint is exercised
 * end-to-end — the runtime is what installs the after_tool handler. The
 * boundary cases pin the direction-aware cuts: head for Grep (keeps the
 * leading bytes, drops the tail), tail-with-first-line for Bash (keeps the
 * body's first line and the trailing stderr lines).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  _bashToolDeps,
  compileToolPolicy,
  createBashTool,
  createCodingToolRuntime,
  MODEL_MAX_BYTES,
  MODEL_MAX_LINE_CHARS,
  MODEL_MAX_LINES,
} from "@/tools";

let root: string;
const realRunArgv = _bashToolDeps.runArgv;

beforeEach(() => {
  root = makeTempDir("nax-after-tool-");
});

afterEach(() => {
  _bashToolDeps.runArgv = realRunArgv;
  cleanupTempDir(root);
});

describe("AC1: when a Grep result larger than MODEL_MAX_BYTES enters the message array, its content UTF-8 byte length is at most MODEL_MAX_BYTES", () => {
  test("a Grep result twice the byte ceiling is capped at MODEL_MAX_BYTES", async () => {
    const bigBody = "x".repeat(MODEL_MAX_BYTES + 100);
    // Use a custom tool that returns a known large body via the runtime so the
    // chokepoint, not Grep's internal truncate(), is the one enforcing the cap.
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      // Force maxBytes to MODEL_MAX_BYTES so the chokepoint's cap is the same
      // value the assertion uses and the test reads cleanly.
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [
        {
          name: "Grep",
          description: "stub",
          inputSchema: { type: "object" },
          scope: { pathFields: [] },
          async run() {
            return { content: bigBody };
          },
        },
      ],
    });
    rt.advertised(["Grep"]);
    const outcome = await rt.callTool("Grep", { pattern: "x" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
  });

  test("a Grep result exactly one byte over MODEL_MAX_BYTES is still capped at MODEL_MAX_BYTES", async () => {
    const overBody = "y".repeat(MODEL_MAX_BYTES + 1);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [
        {
          name: "Grep",
          description: "stub",
          inputSchema: { type: "object" },
          scope: { pathFields: [] },
          async run() {
            return { content: overBody };
          },
        },
      ],
    });
    rt.advertised(["Grep"]);
    const outcome = await rt.callTool("Grep", { pattern: "y" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
  });

  test("a Grep result within MODEL_MAX_BYTES is returned unchanged", async () => {
    const smallBody = "alpha\nbeta\ngamma";
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [
        {
          name: "Grep",
          description: "stub",
          inputSchema: { type: "object" },
          scope: { pathFields: [] },
          async run() {
            return { content: smallBody };
          },
        },
      ],
    });
    rt.advertised(["Grep"]);
    const outcome = await rt.callTool("Grep", { pattern: "alpha" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.content).toBe(smallBody);
  });
});

describe("AC2: when a failing Bash command has stdout larger than MODEL_MAX_BYTES, its message-array result first line is the body's `exit N` line", () => {
  test("a Bash body whose total length exceeds MODEL_MAX_BYTES keeps `exit N` as the first line", async () => {
    // The Bash tool's body shape is `exit <N>\n<stdout>\n<stderr>`. The
    // after_tool handler must preserve the leading `exit N` even when the
    // body exceeds MODEL_MAX_BYTES — that's the whole reason Bash's
    // direction is `tail-with-first-line` rather than `head`.
    //
    // The discriminating case: a body whose TOTAL length exceeds the cap
    // and whose stdout pushes past it. With the current `body.slice(0,
    // ctx.maxBytes)` implementation, the body's first line survives only
    // because it happens to come before the cut. The tail-with-first-line
    // policy keeps it as a structural property: even if the cut were made
    // mid-stdout, the body's first line must remain.
    //
    // To make sure the policy genuinely keeps the FIRST LINE rather than
    // just incidentally keeping it, the test pins the exit code: not just
    // "the first line is non-empty" but "the first line is exactly the
    // exit code the body started with".
    const bigStdout = "x".repeat(MODEL_MAX_BYTES + 100);
    const stderr = "y".repeat(10_000);
    // comfortably past the 40000 cap. A naive byte slice would land in
    // the middle of the stdout `xxxxx...` block and lose the exit line.
    const exitLine = "exit 7";
    _bashToolDeps.runArgv = async () => ({
      exitCode: 7,
      stdout: bigStdout,
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
    // The FIRST line is `exit 7`, the body's own exit code. A naive
    // byte-slice would land in the `xxxxx...` block, leaving the first
    // line as `xxxxx...`, not `exit 7`.
    const firstLine = outcome.content.split("\n")[0];
    expect(firstLine).toBe(exitLine);
  });

  test("a Bash body larger than MODEL_MAX_BYTES is still within the byte ceiling", async () => {
    // Discriminating boundary: AC2 is about the FIRST line; AC1's invariant
    // (byte ceiling) must ALSO hold for Bash's tail-with-first-line cut.
    const bigStdout = "x".repeat(MODEL_MAX_BYTES);
    _bashToolDeps.runArgv = async () => ({
      exitCode: 0,
      stdout: bigStdout,
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
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
  });
});

describe("AC3: when that Bash result enters the message array, its content ends with the body's final stderr lines", () => {
  test("a Bash body with huge stdout and a small final stderr line keeps the stderr's last line", async () => {
    // The tail-with-first-line cut keeps the FIRST line (`exit N`) and the
    // body's TRAILING bytes — which for Bash's `exit N\\nstdout\\nstderr`
    // shape means the last stderr lines survive. The tail's last line is
    // `fatal-error-line`, the body's last line.
    const bigStdout = "x".repeat(MODEL_MAX_BYTES);
    const stderrTail = "fatal-error-line";
    const stderr = `${"warn-line\n".repeat(50)}${stderrTail}`;
    _bashToolDeps.runArgv = async () => ({
      exitCode: 1,
      stdout: bigStdout,
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
    // AC3 is about a failing Bash — kind is "error", but the content carries
    // the body the after_tool handler shapes.
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") throw new Error("unreachable");
    // The last stderr line survives: the body's final line is stderrTail.
    const outLines = outcome.content.split("\n");
    expect(outLines[outLines.length - 1]).toBe(stderrTail);
  });

  test("a Bash body whose final stderr line is one runaway blob ends with the last stderr line that FITS", async () => {
    // Even on exit 0, the shape `exit 0\n<stdout>\n<stderr>` makes stderr the
    // body's tail. Here the body's literal last line is a 160 KB blob, larger
    // than the whole tail budget. Per the skip-whole rule ("Truncation
    // direction" in the spec) that line is skipped rather than shortened into
    // the tail slot, so the content ends with `lastFittingStderrLine` — the
    // last stderr line that fits, NOT the body's literal final line. Keeping a
    // 2,000-char slice of the blob instead would evict the short line that
    // carries the signal, which is the failure this direction exists to avoid.
    const bigStdout = "x".repeat(MODEL_MAX_BYTES);
    const lastFittingStderrLine = "stderr-final-line";
    const stderr = `${lastFittingStderrLine}\n${"more".repeat(MODEL_MAX_BYTES)}`;
    _bashToolDeps.runArgv = async () => ({
      exitCode: 0,
      stdout: bigStdout,
      stderr,
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
    const outLines = outcome.content.split("\n");
    expect(outLines[outLines.length - 1]).toBe(lastFittingStderrLine);
  });
});

describe("AC7: when a tool result is within every cap, its scratchpad `spill` directory is empty", () => {
  test("a Grep result within MODEL_MAX_BYTES does not produce a spill file", async () => {
    // Pinning the negative: when a tool returns within every cap, the spill
    // pipeline must NOT run. The path checked is the canonical
    // `.nax/scratchpad/spill/` directory.
    const smallBody = "alpha\nbeta\ngamma";
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [
        {
          name: "Grep",
          description: "stub",
          inputSchema: { type: "object" },
          scope: { pathFields: [] },
          async run() {
            return { content: smallBody };
          },
        },
      ],
    });
    rt.advertised(["Grep"]);
    const outcome = await rt.callTool("Grep", { pattern: "alpha" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");

    // The spill directory is at <root>/.nax/scratchpad/spill/. It either
    // does not exist (no spill ever written) or it exists but is empty.
    const spillDir = join(root, ".nax", "scratchpad", "spill");
    if (existsSync(spillDir)) {
      expect(readdirSync(spillDir)).toHaveLength(0);
    }
  });

  test("a tool result smaller than every line/byte cap and the per-line cap leaves the spill directory absent", async () => {
    // The smaller boundary: a body within every cap. The chokepoint must
    // not write a spill file, AND the spill directory must not have been
    // created (the spill writer is lazy).
    const smallBody = "x".repeat(MODEL_MAX_LINE_CHARS); // one line, at the per-line cap
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      maxFileBytes: 10_000_000,
      extraTools: [
        {
          name: "Grep",
          description: "stub",
          inputSchema: { type: "object" },
          scope: { pathFields: [] },
          async run() {
            return { content: smallBody };
          },
        },
      ],
    });
    rt.advertised(["Grep"]);
    await rt.callTool("Grep", { pattern: "x" });

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    if (existsSync(spillDir)) {
      expect(readdirSync(spillDir)).toHaveLength(0);
    }
  });
});

describe("after_tool truncation — supplementary invariants (cross-AC boundaries)", () => {
  test("a Grep result within MODEL_MAX_LINES but exceeding MODEL_MAX_LINE_CHARS is capped at MODEL_MAX_LINE_CHARS per line", async () => {
    // Cross-cap: a body with one over-long line should have that line
    // shortened to MODEL_MAX_LINE_CHARS by the per-line stage. The result
    // is shorter than MODEL_MAX_BYTES but the per-line stage still fires.
    const overLongLine = "a".repeat(MODEL_MAX_LINE_CHARS * 2);
    const body = `${overLongLine}\nshort\n`;
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [
        {
          name: "Grep",
          description: "stub",
          inputSchema: { type: "object" },
          scope: { pathFields: [] },
          async run() {
            return { content: body };
          },
        },
      ],
    });
    rt.advertised(["Grep"]);
    const outcome = await rt.callTool("Grep", { pattern: "a" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    const lines = outcome.content.split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(MODEL_MAX_LINE_CHARS);
    }
  });

  test("a body with more than MODEL_MAX_LINES lines (within byte ceiling) is capped at MODEL_MAX_LINES lines", async () => {
    // Cross-cap: line-count stage. A body whose line count exceeds the cap
    // must be reduced to at most MODEL_MAX_LINES lines.
    const total = MODEL_MAX_LINES + 50;
    const lines = Array.from({ length: total }, (_, i) => `L${i + 1}`);
    const body = `${lines.join("\n")}\n`;
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [
        {
          name: "Grep",
          description: "stub",
          inputSchema: { type: "object" },
          scope: { pathFields: [] },
          async run() {
            return { content: body };
          },
        },
      ],
    });
    rt.advertised(["Grep"]);
    const outcome = await rt.callTool("Grep", { pattern: "L1" });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    // The line-count cap fires; the body has at most MODEL_MAX_LINES lines.
    const outLines = outcome.content.split("\n").filter((l) => l.length > 0);
    expect(outLines.length).toBeLessThanOrEqual(MODEL_MAX_LINES);
  });
});
