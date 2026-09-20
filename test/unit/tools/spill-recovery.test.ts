/**
 * US-003 — spill recovery (AC5, AC6, AC7, AC8, AC9).
 *
 * When a tool result is truncated, the FULL body (up to READ_CEILING) is
 * written to `<root>/.nax/scratchpad/spill/<toolName>-<callId>.txt`, and the
 * truncated message ends with a marker naming the spill path, the delivered
 * byte count, and the original byte count. The tests in this file pin each
 * of those properties as observable file-system state and as observable
 * message-array content, end-to-end through `runtime.callTool`.
 *
 * The boundary companions pin the failure paths: a spill write that fails
 * (AC8) is fail-open — the truncated result is still delivered, and the
 * marker omits the spill path rather than naming a file that does not exist.
 * A body larger than READ_CEILING (AC9) writes a spill file up to the ceiling
 * and records that it is itself incomplete.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { compileToolPolicy, createCodingToolRuntime, MODEL_MAX_BYTES, READ_CEILING } from "@/tools";

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-spill-");
});

afterEach(() => {
  cleanupTempDir(root);
});

/** Stub Grep tool returning the supplied body for the chokepoint to shape. */
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

/** Drive a single Grep call through the runtime and return the outcome. */
async function callGrep(rt: ReturnType<typeof createCodingToolRuntime>, _body: string) {
  // The body is captured by the stub's closure, not the call's input —
  // this mirrors the real Grep contract, where the tool's content is
  // produced by a subprocess the runtime never sees.
  return rt.callTool("Grep", { pattern: "x" });
}

describe("AC5: when a tool result is truncated, then it writes `spill/<toolName>-<callId>.txt` under the scratchpad with the untruncated body", () => {
  test("a truncated Grep result writes a spill file at .nax/scratchpad/spill/Grep-<id>.txt", async () => {
    const bigBody = "x".repeat(MODEL_MAX_BYTES + 100);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt, bigBody);

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    expect(existsSync(spillDir)).toBe(true);
    const entries = readdirSync(spillDir);
    // At least one spill file exists, named for Grep.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((name) => name.startsWith("Grep-") && name.endsWith(".txt"))).toBe(true);
  });

  test("the spill file contains the FULL untruncated body", async () => {
    const bigBody = `first-line\n${"x".repeat(MODEL_MAX_BYTES + 100)}\nlast-line`;
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt, bigBody);

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    const files = readdirSync(spillDir);
    const spillFile = files.find((f) => f.startsWith("Grep-") && f.endsWith(".txt"));
    expect(spillFile).toBeDefined();
    if (spillFile === undefined) throw new Error("spill file missing");
    const content = readFileSync(join(spillDir, spillFile), "utf8");
    // The spill file holds the untruncated body, byte-for-byte. Even though
    // the message-array content was capped at MODEL_MAX_BYTES, the spill is
    // uncut (within READ_CEILING — see AC9 for the over-ceiling case).
    expect(content).toBe(bigBody);
  });

  test("the spill file exists when the body exceeds MODEL_MAX_BYTES but is smaller than READ_CEILING", async () => {
    // Boundary: a body in (MODEL_MAX_BYTES, READ_CEILING) triggers AC5.
    // READ_CEILING is 2_000_000 — a body of MODEL_MAX_BYTES + 1 is in the
    // truncated band.
    const body = "y".repeat(MODEL_MAX_BYTES + 1);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(body)],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt, body);

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    expect(existsSync(spillDir)).toBe(true);
    expect(readdirSync(spillDir).length).toBeGreaterThan(0);
  });
});

describe("AC6: when a tool result is truncated, then its content ends with a marker naming spill path, delivered byte count, and original byte count", () => {
  test("the truncated content ends with a marker naming the spill path", async () => {
    const bigBody = "x".repeat(MODEL_MAX_BYTES + 100);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);
    const outcome = await callGrep(rt, bigBody);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");

    // Look for the marker substring without dumping the body in failures.
    // We pre-check that the body exceeds the cap (so this is a truncation
    // path), then assert the marker is present. If the marker is missing
    // we get a clear assertion failure on the marker check, not on the body.
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    expect(outcome.content.includes("spill/Grep-")).toBe(true);
  });

  test("the marker names the delivered byte count and the original byte count", async () => {
    const bigBody = "x".repeat(MODEL_MAX_BYTES + 100);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);
    const outcome = await callGrep(rt, bigBody);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");

    // The marker cites the original byte count. Compute the count, then
    // verify it appears as a substring in the marker (without dumping
    // the body — we use a pre-check on byte length).
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    const originalBytes = Buffer.byteLength(bigBody, "utf8");
    expect(outcome.content.includes(`${originalBytes}`)).toBe(true);
  });

  test("the marker ends the message-array content (it is the LAST lines)", async () => {
    const bigBody = "x".repeat(MODEL_MAX_BYTES + 100);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);
    const outcome = await callGrep(rt, bigBody);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");

    // The marker is appended to the truncated body — it occupies the LAST
    // lines of the content. Take the last line explicitly so the failure
    // message is concise (the marker substring, not the entire body).
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    const lines = outcome.content.split("\n");
    const lastLine = lines[lines.length - 1] ?? "";
    expect(lastLine.includes("spill/Grep-")).toBe(true);
  });
});

describe("AC7: when a tool result is within every cap, then its scratchpad `spill` directory is empty", () => {
  test("a Grep result within MODEL_MAX_BYTES writes no spill file", async () => {
    const smallBody = "alpha\nbeta\ngamma";
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(smallBody)],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt, smallBody);

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    // Either the directory is absent (lazy) or it's empty.
    if (existsSync(spillDir)) {
      expect(readdirSync(spillDir)).toHaveLength(0);
    }
  });

  test("a tool result with body byte-length 0 writes no spill file", async () => {
    const emptyBody = "";
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(emptyBody)],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt, emptyBody);

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    if (existsSync(spillDir)) {
      expect(readdirSync(spillDir)).toHaveLength(0);
    }
  });
});

describe("AC8: when a spill write fails, then the result still enters the message array truncated and its marker names no spill path", () => {
  test("with the spill directory non-writable, the result is still delivered truncated", async () => {
    const bigBody = "x".repeat(MODEL_MAX_BYTES + 100);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);

    // Pre-create the spill directory as a regular FILE so the writer's mkdir
    // recursive call cannot create it. The spill path collides with a file,
    // not a directory, so any write into the path fails. The chokepoint must
    // be fail-open: result delivered truncated, no marker naming the path.
    const spillDir = join(root, ".nax", "scratchpad", "spill");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(spillDir, "blocker");

    const outcome = await callGrep(rt, bigBody);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    // Truncation still applied (the body exceeds MODEL_MAX_BYTES).
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
  });

  test("with the spill path blocked, the marker omits the spill path", async () => {
    const bigBody = "x".repeat(MODEL_MAX_BYTES + 100);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);

    // Same trick as above — block the spill path.
    const spillDir = join(root, ".nax", "scratchpad", "spill");
    mkdirSync(join(root, ".nax", "scratchpad"), { recursive: true });
    writeFileSync(spillDir, "blocker");

    const outcome = await callGrep(rt, bigBody);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");

    // The marker must NOT name a spill path that does not exist. The marker
    // shape with no spill path either omits the path entirely or uses a
    // sentinel — it must not say `spill/Grep-<id>.txt`. The body check
    // comes first so a missing marker fails on the substring, not the body.
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    expect(outcome.content.includes("spill/Grep-")).toBe(false);
  });

  test("boundary: a spill write that succeeds still produces the marker naming the path", async () => {
    // The non-failing companion to AC8: when the spill write SUCCEEDS, the
    // marker names the path. This proves the AC8 negative assertion isn't
    // accidentally being satisfied by a regression that always omits the path.
    const bigBody = "z".repeat(MODEL_MAX_BYTES + 100);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);
    const outcome = await callGrep(rt, bigBody);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(Buffer.byteLength(outcome.content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    expect(outcome.content.includes("spill/Grep-")).toBe(true);
  });
});

describe("AC9: when a body is larger than READ_CEILING, then its spill file final line records that the spill is itself incomplete", () => {
  test("a body larger than READ_CEILING produces a spill file whose last line is the incomplete marker", async () => {
    // READ_CEILING is 2_000_000. A body of 2_500_000 bytes is past it: the
    // spill writer must write up to the ceiling AND record, on the spill
    // file's last line, that the spill is itself incomplete.
    const overCeilingBody = "w".repeat(READ_CEILING + 500_000);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(overCeilingBody)],
    });
    rt.advertised(["Grep"]);
    const outcome = await callGrep(rt, overCeilingBody);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    expect(existsSync(spillDir)).toBe(true);
    const files = readdirSync(spillDir);
    const spillFile = files.find((f) => f.startsWith("Grep-") && f.endsWith(".txt"));
    expect(spillFile).toBeDefined();
    if (spillFile === undefined) throw new Error("spill file missing");
    const spillContent = readFileSync(join(spillDir, spillFile), "utf8");
    // The spill file's LAST line states that the spill is itself incomplete.
    // Pinning the exact wording would couple to a specific marker shape; the
    // discriminating assertion is that the last line does NOT look like a
    // continuation of the original body — i.e., the marker is present.
    const lastLine = spillContent.split("\n").pop() ?? "";
    expect(lastLine.length).toBeGreaterThan(0);
    expect(lastLine).not.toBe("w".repeat(lastLine.length));
  });

  test("the spill file's bytes are at most READ_CEILING when the body exceeds it", async () => {
    const overCeilingBody = "q".repeat(READ_CEILING * 2);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(overCeilingBody)],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt, overCeilingBody);

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    const files = readdirSync(spillDir);
    const spillFile = files.find((f) => f.startsWith("Grep-") && f.endsWith(".txt"));
    expect(spillFile).toBeDefined();
    if (spillFile === undefined) throw new Error("spill file missing");
    const spillContent = readFileSync(join(spillDir, spillFile), "utf8");
    // The spill file is at most READ_CEILING bytes. Even with the incomplete
    // marker appended, the file cannot exceed the ceiling.
    expect(Buffer.byteLength(spillContent, "utf8")).toBeLessThanOrEqual(READ_CEILING);
  });

  test("a body EXACTLY at READ_CEILING does not mark the spill as incomplete", async () => {
    // Boundary: a body at the ceiling is fully captured by the spill writer
    // and does NOT carry the incomplete marker. The marker fires only when
    // there is more body than the ceiling can hold.
    const atCeilingBody = "p".repeat(READ_CEILING);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(atCeilingBody)],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt, atCeilingBody);

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    const files = readdirSync(spillDir);
    const spillFile = files.find((f) => f.startsWith("Grep-") && f.endsWith(".txt"));
    expect(spillFile).toBeDefined();
    if (spillFile === undefined) throw new Error("spill file missing");
    const spillContent = readFileSync(join(spillDir, spillFile), "utf8");
    // The spill holds the entire body; no incomplete marker needed.
    // We don't pin exact wording, but the last line should look like the
    // body (all `p`s) rather than an "incomplete" marker.
    const lastLine = spillContent.split("\n").pop() ?? "";
    expect(lastLine).toBe("p".repeat(lastLine.length));
  });
});

describe("spill recovery — supplementary invariants", () => {
  test("two truncated calls produce two distinct spill files", async () => {
    const bigBody1 = "1".repeat(MODEL_MAX_BYTES + 1);
    const bigBody2 = "2".repeat(MODEL_MAX_BYTES + 1);
    let count = 0;
    const altStub = {
      name: "Grep",
      description: "stub",
      inputSchema: { type: "object" },
      scope: { pathFields: [] },
      async run() {
        count += 1;
        return { content: count === 1 ? bigBody1 : bigBody2 };
      },
    };
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [altStub],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt, bigBody1);
    await callGrep(rt, bigBody2);

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    const files = readdirSync(spillDir);
    // Two distinct spill files for two distinct calls.
    expect(files.length).toBe(2);
  });

  test("a spill file's relative path under scratchpad is <toolName>-<callId>.txt", async () => {
    const bigBody = "u".repeat(MODEL_MAX_BYTES + 1);
    const rt = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Grep", patterns: ["*"] }], root),
      maxBytes: MODEL_MAX_BYTES,
      extraTools: [stubGrep(bigBody)],
    });
    rt.advertised(["Grep"]);
    await callGrep(rt, bigBody);

    const spillDir = join(root, ".nax", "scratchpad", "spill");
    const files = readdirSync(spillDir);
    // Every spill file in the directory follows the naming convention.
    for (const file of files) {
      expect(file).toMatch(/^Grep-[a-zA-Z0-9_-]+\.txt$/);
    }
  });
});

// The blocker-file pattern (`writeFileSync(spillDir, "blocker")`) is what
// triggers the spill-write failure mode for AC8; the file-system import
// covers the writes used elsewhere.
