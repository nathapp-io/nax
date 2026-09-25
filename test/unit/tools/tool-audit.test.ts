import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeTempDir, withWarnSpy } from "@test/helpers";
import { compileToolPolicy } from "@/tools/policy";
import type { CodingTool } from "@/tools/registry";
import { createCodingToolRuntime } from "@/tools/runtime";
import {
  createToolAuditSink,
  flushOpenToolAuditSinks,
  type RegisteredSink,
  registerToolAuditSink,
  TOOL_AUDIT_SCHEMA_VERSION,
  type ToolCallRecord,
  unregisterToolAuditSink,
} from "@/tools/tool-audit";

describe("createToolAuditSink", () => {
  test("writes one file holding every recorded call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
    const sink = createToolAuditSink({ dir, sessionName: "s1" });
    sink.record({
      tool: "Read",
      outcome: "ok",
      input: { path: "a.ts" },
      resultBytes: 10,
      at: "2026-09-03T00:00:00.000Z",
    });
    sink.record({
      tool: "RequestCapability",
      outcome: "error",
      input: { capability: "bun install" },
      resultBytes: 0,
      at: "2026-09-03T00:00:01.000Z",
    });
    await sink.flush();

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
    expect(parsed.sessionName).toBe("s1");
    expect(parsed.calls).toHaveLength(2);
    expect(parsed.calls[1].tool).toBe("RequestCapability");
    expect(parsed.calls[1].input.capability).toBe("bun install");
  });

  test("a denial is persisted, not only logged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
    const sink = createToolAuditSink({ dir, sessionName: "s2" });
    sink.record({
      tool: "Write",
      outcome: "denied",
      breach: true,
      input: { path: "/etc/passwd" },
      resultBytes: 0,
      at: "2026-09-03T00:00:00.000Z",
    });
    await sink.flush();
    const files = await readdir(dir);
    const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
    expect(parsed.calls[0].outcome).toBe("denied");
    expect(parsed.calls[0].breach).toBe(true);
  });

  test("flushing with no calls writes nothing -- an empty file is not evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
    await createToolAuditSink({ dir, sessionName: "s3" }).flush();
    expect(await readdir(dir)).toHaveLength(0);
  });

  test("a denied row carries the reason", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
    const sink = createToolAuditSink({ dir, sessionName: "US-001-implementer" });
    sink.record({
      tool: "Exec",
      outcome: "denied",
      input: { argv: ["curl", "http://x"] },
      reason: "curl is not in this project's allowlist",
      resultBytes: 0,
      at: new Date().toISOString(),
    });
    await sink.flush();
    const files = await readdir(dir);
    const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
    expect(parsed.calls[0].reason).toContain("allowlist");
  });

  test("an executed row carries both the requested and the executed argv", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
    const sink = createToolAuditSink({ dir, sessionName: "US-001-implementer" });
    sink.record({
      tool: "Exec",
      outcome: "ok",
      input: { argv: ["bun", "add", "-d", "bun-types"], target: "repoRoot" },
      executed: ["bun", "add", "-d", "bun-types", "--ignore-scripts"],
      target: "repoRoot",
      resultBytes: 12,
      at: new Date().toISOString(),
    });
    await sink.flush();
    const files = await readdir(dir);
    const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
    // Both halves non-empty: either alone cannot tell an auditor whether the
    // normalization was faithful.
    expect(parsed.calls[0].input.argv).toEqual(["bun", "add", "-d", "bun-types"]);
    expect(parsed.calls[0].executed).toContain("--ignore-scripts");
    expect(parsed.calls[0].tool).toBe("Exec");
  });

  test("review #9: a secret in the ledger row is redacted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
    const sink = createToolAuditSink({ dir, sessionName: "US-001-implementer" });
    sink.record({
      tool: "Exec",
      outcome: "ok",
      input: { command: "gh auth ghp_abcdefghijklmnop1234" },
      executed: ["gh", "auth", "ghp_abcdefghijklmnop1234"],
      target: "repoRoot",
      resultBytes: 12,
      at: new Date().toISOString(),
    });
    await sink.flush();

    const body = await readFile(join(dir, (await readdir(dir))[0] ?? ""), "utf8");
    expect(body).not.toContain("ghp_abcdefghijklmnop1234");
    expect(JSON.parse(body).calls[0].input.command).toContain("[REDACTED:github]");
  });

  test("records the correlation ids supplied to the runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
    const sink = createToolAuditSink({ dir, sessionName: "s1" });
    sink.record({
      tool: "Read",
      outcome: "ok",
      input: {},
      resultBytes: 1,
      at: "2026-09-20T00:00:00.000Z",
      callId: "call-1",
      scopeId: "scope-1",
    });
    await sink.flush();

    const files = await readdir(dir);
    const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
    expect(parsed.calls[0].callId).toBe("call-1");
    expect(parsed.calls[0].scopeId).toBe("scope-1");
  });

  test("records turn context alongside the tool call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
    const sink = createToolAuditSink({ dir, sessionName: "s1" });
    sink.record({
      tool: "Read",
      outcome: "ok",
      input: {},
      resultBytes: 1,
      at: "2026-09-20T00:00:00.000Z",
      turnId: "turn-1",
      roundTrips: 3,
      toolCallId: "toolu_abc",
    });
    await sink.flush();

    const files = await readdir(dir);
    const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
    expect(parsed.calls[0].turnId).toBe("turn-1");
    expect(parsed.calls[0].roundTrips).toBe(3);
    expect(parsed.calls[0].toolCallId).toBe("toolu_abc");
  });

  test("a Bash row's exitCode round-trips through the ledger file (nax#2227)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
    const sink = createToolAuditSink({ dir, sessionName: "US-001-implementer" });
    sink.record({
      tool: "Bash",
      outcome: "error",
      input: { command: "rg nomatch src" },
      resultBytes: 7,
      at: new Date().toISOString(),
      exitCode: 1,
    });
    await sink.flush();
    const files = await readdir(dir);
    const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
    expect(parsed.calls[0].exitCode).toBe(1);
    expect(parsed.calls[0].outcome).toBe("error");
  });

  test('the runtime writes tool "Exec" for an argv call all the way into the ledger file', async () => {
    const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
    const sink = createToolAuditSink({ dir, sessionName: "US-001-implementer" });
    const execTool: CodingTool = {
      name: "RunCommand",
      description: "stub",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: [], argvField: "argv" },
      run: async () => ({
        content: "exit 0\n",
        audit: { executed: ["bun", "install", "--ignore-scripts"], target: "repoRoot" as const },
      }),
    };
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Exec", patterns: ["bun *"] }], process.cwd()),
      sink,
      extraTools: [execTool],
    });
    await runtime.callTool("RunCommand", { argv: ["bun", "install"], target: "repoRoot" });
    await sink.flush();
    const files = await readdir(dir);
    const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
    expect(parsed.calls[0].tool).toBe("Exec");
    expect(parsed.calls[0].executed).toEqual(["bun", "install", "--ignore-scripts"]);
    expect(parsed.calls[0].target).toBe("repoRoot");
  });
});

test("the runtime records a denial through the sink, not only the logger", async () => {
  const recorded: unknown[] = [];
  const sink = { record: (e: unknown) => recorded.push(e), flush: async () => {} };
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], process.cwd()),
    sink,
  });
  await runtime.callTool("GitCommit", { message: "m", paths: ["a.ts"] });
  expect(recorded).toHaveLength(1);
  expect((recorded[0] as { outcome: string }).outcome).toBe("denied");
  expect((recorded[0] as { tool: string }).tool).toBe("GitCommit");
});

test("writes schemaVersion and the header fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
  const sink = createToolAuditSink({
    dir,
    sessionName: "US-001-implementer",
    header: {
      runId: "run-abc",
      featureName: "telemetry-keys",
      storyId: "US-001",
      sessionRole: "implementer",
    },
  });
  sink.record({
    tool: "Read",
    outcome: "ok",
    input: { path: "a.ts" },
    resultBytes: 10,
    at: "2026-09-20T00:00:00.000Z",
  });
  await sink.flush();

  const files = await readdir(dir);
  const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
  expect(parsed.schemaVersion).toBe(TOOL_AUDIT_SCHEMA_VERSION);
  expect(parsed.runId).toBe("run-abc");
  expect(parsed.featureName).toBe("telemetry-keys");
  expect(parsed.storyId).toBe("US-001");
  expect(parsed.sessionRole).toBe("implementer");
  expect(parsed.sessionName).toBe("US-001-implementer");
});

test("the filename carries the runId when one is known", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
  const sink = createToolAuditSink({ dir, sessionName: "s1", header: { runId: "run-fn" } });
  sink.record({ tool: "Read", outcome: "ok", input: {}, resultBytes: 1, at: "2026-09-20T00:00:00.000Z" });
  await sink.flush();

  const [name] = await readdir(dir);
  expect(name).toMatch(/^run-fn-\d+-s1\.json$/);
});

test("falls back to the unprefixed name when no runId is known", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
  const sink = createToolAuditSink({ dir, sessionName: "s2" });
  sink.record({ tool: "Read", outcome: "ok", input: {}, resultBytes: 1, at: "2026-09-20T00:00:00.000Z" });
  await sink.flush();

  const [name] = await readdir(dir);
  expect(name).toMatch(/^\d+-s2\.json$/);
});

test("omits header keys that were not supplied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-audit-"));
  const sink = createToolAuditSink({ dir, sessionName: "s1" });
  sink.record({ tool: "Read", outcome: "ok", input: {}, resultBytes: 1, at: "2026-09-20T00:00:00.000Z" });
  await sink.flush();

  const files = await readdir(dir);
  const parsed = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
  expect(parsed.schemaVersion).toBe(TOOL_AUDIT_SCHEMA_VERSION);
  expect("runId" in parsed).toBe(false);
  expect("featureName" in parsed).toBe(false);
});

// ─── US-004: flushing still-open sinks as partial at close ───────────────────

/** The parts of a written tool-audit file the partial-flush tests read back. */
type ParsedAuditBody = {
  partial?: boolean;
  runId?: string;
  sessionName?: string;
  calls: ReadonlyArray<{ tool: string }>;
};

function aCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    tool: "Read",
    outcome: "ok",
    input: { path: "a.ts" },
    resultBytes: 10,
    at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

async function readBody(dir: string, file: string): Promise<ParsedAuditBody> {
  const body: ParsedAuditBody = JSON.parse(await readFile(join(dir, file), "utf8"));
  return body;
}

/** The one file expected to be present, failing loudly when there is not exactly one. */
function onlyFile(files: readonly string[]): string {
  expect(files).toHaveLength(1);
  const name = files[0];
  assertDefined(name, "the single written audit file");
  return name;
}

function fileEndingWith(files: readonly string[], suffix: string): string {
  const found = files.find((f) => f.endsWith(suffix));
  assertDefined(found, `an audit file ending with ${suffix}`);
  return found;
}

/** A sink registered by hand, so a test can drive the registry without writing files. */
function fakeSink(onFlushPartial: () => Promise<void>): RegisteredSink & { partialFlushes: number } {
  const sink = {
    partialFlushes: 0,
    record() {},
    async flush() {},
    async flushPartial() {
      sink.partialFlushes += 1;
      await onFlushPartial();
    },
  };
  return sink;
}

describe("flushOpenToolAuditSinks (US-004)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanupTempDir(dir);
    dirs.length = 0;
  });

  function makeAuditDir(): string {
    const dir = makeTempDir("tool-audit-partial-");
    dirs.push(dir);
    return dir;
  }

  // Unique per test: the registry is module-level state, so a shared literal
  // would let one test flush a sink another test left behind.
  function newRunId(): string {
    return `run-${crypto.randomUUID()}`;
  }

  test("US-004 AC1: an unflushed sink is written as partial and holds its recorded call", async () => {
    const dir = makeAuditDir();
    const runId = newRunId();
    const sink = createToolAuditSink({ dir, sessionName: "US-004-implementer", header: { runId } });
    sink.record(aCall({ tool: "Exec" }));

    await flushOpenToolAuditSinks(runId);

    const name = onlyFile(await readdir(dir));
    const body = await readBody(dir, name);
    expect(body.partial).toBe(true);
    expect(body.runId).toBe(runId);
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0].tool).toBe("Exec");
  });

  test("US-004 AC2: after the partial flush, the sink's own flush writes no second file", async () => {
    const dir = makeAuditDir();
    const runId = newRunId();
    const sink = createToolAuditSink({ dir, sessionName: "US-004-implementer", header: { runId } });
    sink.record(aCall({ tool: "Read" }));

    await flushOpenToolAuditSinks(runId);
    await sink.flush();

    const files = await readdir(dir);
    const name = onlyFile(files);
    // The surviving file must be the PARTIAL one: were it the sink's own
    // non-partial write, the partial flush would not have happened at all and
    // "no second file" would be vacuously true.
    const body = await readBody(dir, name);
    expect(body.partial).toBe(true);
    expect(body.calls).toHaveLength(1);
  });

  test("US-004 AC3: a sink whose own flush already ran is not written again", async () => {
    const dir = makeAuditDir();
    const runId = newRunId();
    const flushed = createToolAuditSink({ dir, sessionName: "already-flushed", header: { runId } });
    flushed.record(aCall({ tool: "Read" }));
    await flushed.flush();

    const alreadyFlushedName = onlyFile(await readdir(dir));
    const before = await readFile(join(dir, alreadyFlushedName), "utf8");

    const stillOpen = createToolAuditSink({ dir, sessionName: "still-open", header: { runId } });
    stillOpen.record(aCall({ tool: "Write" }));
    await flushOpenToolAuditSinks(runId);

    const files = await readdir(dir);
    // Two, not three: the open sink gained a file, the flushed one did not.
    expect(files).toHaveLength(2);
    expect(await readFile(join(dir, alreadyFlushedName), "utf8")).toBe(before);
    const openBody = await readBody(dir, fileEndingWith(files, "still-open.json"));
    expect(openBody.partial).toBe(true);
    expect(openBody.calls).toHaveLength(1);
  });

  test("US-004 AC4: a sink with no recorded calls is not written", async () => {
    const dir = makeAuditDir();
    const runId = newRunId();
    createToolAuditSink({ dir, sessionName: "empty", header: { runId } });
    const withCall = createToolAuditSink({ dir, sessionName: "has-call", header: { runId } });
    withCall.record(aCall({ tool: "Glob" }));

    await flushOpenToolAuditSinks(runId);

    const files = await readdir(dir);
    // Exactly one: the empty sink contributed nothing, the other contributed its
    // call. Asserting the count alone would pass even if nothing was written.
    expect(files).toHaveLength(1);
    const body = await readBody(dir, fileEndingWith(files, "has-call.json"));
    expect(body.partial).toBe(true);
    expect(body.calls[0].tool).toBe("Glob");
  });

  test("US-004 AC5: a sink registered under another runId is left alone", async () => {
    const dirA = makeAuditDir();
    const dirB = makeAuditDir();
    const runIdA = newRunId();
    const runIdB = newRunId();
    const sinkA = createToolAuditSink({ dir: dirA, sessionName: "a", header: { runId: runIdA } });
    sinkA.record(aCall({ tool: "Read" }));
    const sinkB = createToolAuditSink({ dir: dirB, sessionName: "b", header: { runId: runIdB } });
    sinkB.record(aCall({ tool: "Write" }));

    await flushOpenToolAuditSinks(runIdA);

    const bodyA = await readBody(dirA, onlyFile(await readdir(dirA)));
    expect(bodyA.partial).toBe(true);
    expect(await readdir(dirB)).toHaveLength(0);

    await flushOpenToolAuditSinks(runIdB);
  });

  test("US-004 AC6: a sink's own flush writes a body with no partial field", async () => {
    const dir = makeAuditDir();
    const runId = newRunId();
    const sink = createToolAuditSink({ dir, sessionName: "own-flush", header: { runId } });
    sink.record(aCall({ tool: "Read" }));
    await sink.flush();

    const files = await readdir(dir);
    const ownBody = await readBody(dir, onlyFile(files));
    expect(ownBody.calls).toHaveLength(1);
    expect("partial" in ownBody).toBe(false);

    // Control: the module DOES write `partial` for a sink it flushes at close,
    // so its absence above is a distinction the writer makes rather than a
    // field nothing ever emits.
    const open = createToolAuditSink({ dir, sessionName: "open", header: { runId } });
    open.record(aCall({ tool: "Read" }));
    await flushOpenToolAuditSinks(runId);

    const after = await readdir(dir);
    expect(after).toHaveLength(2);
    const partialBody = await readBody(dir, fileEndingWith(after, "open.json"));
    expect(partialBody.partial).toBe(true);
    expect("partial" in (await readBody(dir, fileEndingWith(after, "own-flush.json")))).toBe(false);
  });

  test("US-004 AC7: one failing sink does not stop the others, and the failure is logged", async () => {
    const dir = makeAuditDir();
    const runId = newRunId();
    // Registered first: a sequential flusher only reaches the healthy sink if it
    // carries on past this rejection.
    registerToolAuditSink(
      runId,
      fakeSink(async () => {
        throw new Error("disk full");
      }),
    );
    const healthy = createToolAuditSink({ dir, sessionName: "healthy", header: { runId } });
    healthy.record(aCall({ tool: "Read" }));

    await withWarnSpy(async (warnSpy) => {
      await expect(flushOpenToolAuditSinks(runId)).resolves.toBeUndefined();
      const warned = warnSpy.mock.calls.find((c) => c[1] === "tool-audit partial flush failed");
      expect(warned).toBeDefined();
      expect(warned?.[0]).toBe("tools");
    });

    const body = await readBody(dir, onlyFile(await readdir(dir)));
    expect(body.partial).toBe(true);
    expect(body.calls[0].tool).toBe("Read");
  });

  test("US-004 AC9: a sink with no header runId is never written by the partial flush", async () => {
    const dirNoRunId = makeAuditDir();
    const dirWithRunId = makeAuditDir();
    const runId = newRunId();
    const anonymous = createToolAuditSink({ dir: dirNoRunId, sessionName: "no-run-id" });
    anonymous.record(aCall({ tool: "Read" }));
    const known = createToolAuditSink({ dir: dirWithRunId, sessionName: "known", header: { runId } });
    known.record(aCall({ tool: "Read" }));

    await flushOpenToolAuditSinks(runId);

    const body = await readBody(dirWithRunId, onlyFile(await readdir(dirWithRunId)));
    expect(body.partial).toBe(true);
    expect(await readdir(dirNoRunId)).toHaveLength(0);
  });

  test("unregisterToolAuditSink keeps a sink out of the partial flush", async () => {
    const runId = newRunId();
    const skipped = fakeSink(async () => {});
    const kept = fakeSink(async () => {});
    registerToolAuditSink(runId, skipped);
    registerToolAuditSink(runId, kept);
    unregisterToolAuditSink(runId, skipped);

    await flushOpenToolAuditSinks(runId);

    expect(kept.partialFlushes).toBe(1);
    expect(skipped.partialFlushes).toBe(0);
  });
});
