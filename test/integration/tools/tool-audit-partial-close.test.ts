/**
 * US-004 — closing a runtime must persist tool calls still buffered by the
 * sinks whose hop `finally` never ran.
 *
 * These exercises go through the `@/tools` barrel (AC8) and through
 * `createRuntime().close()` (AC10), which the unit-level tests in
 * `test/unit/tools/tool-audit.test.ts` deliberately do not.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeMockRuntime, makeTempDir } from "@test/helpers";
import { createToolAuditSink, flushOpenToolAuditSinks } from "@/tools";

type ParsedAuditBody = {
  partial?: boolean;
  runId?: string;
  calls: ReadonlyArray<{ tool: string }>;
};

async function onlyAuditBody(dir: string): Promise<ParsedAuditBody> {
  const files = await readdir(dir);
  expect(files).toHaveLength(1);
  const name = files[0];
  assertDefined(name, "the single written audit file");
  const body: ParsedAuditBody = JSON.parse(await readFile(join(dir, name), "utf8"));
  return body;
}

describe("tool-audit partial flush at runtime close (US-004)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanupTempDir(dir);
    dirs.length = 0;
  });

  function makeAuditDir(): string {
    const dir = makeTempDir("tool-audit-close-");
    dirs.push(dir);
    return dir;
  }

  test("US-004 AC8: the partial flush reached through the @/tools barrel flushes a created sink", async () => {
    const dir = makeAuditDir();
    const runId = `run-${crypto.randomUUID()}`;
    const sink = createToolAuditSink({ dir, sessionName: "barrel", header: { runId } });
    sink.record({
      tool: "Read",
      outcome: "ok",
      input: { path: "a.ts" },
      resultBytes: 10,
      at: "2026-09-20T00:00:00.000Z",
    });

    await flushOpenToolAuditSinks(runId);

    const body = await onlyAuditBody(dir);
    expect(body.partial).toBe(true);
    expect(body.runId).toBe(runId);
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0].tool).toBe("Read");
  });

  test("US-004 AC10: runtime.close() writes a still-open sink as partial", async () => {
    const dir = makeAuditDir();
    const runtime = makeMockRuntime();
    const sink = createToolAuditSink({
      dir,
      sessionName: "US-004-implementer",
      header: { runId: runtime.runId },
    });
    sink.record({
      tool: "Exec",
      outcome: "ok",
      input: { argv: ["bun", "test"] },
      resultBytes: 3,
      at: "2026-09-20T00:00:00.000Z",
    });

    await runtime.close();

    const body = await onlyAuditBody(dir);
    expect(body.partial).toBe(true);
    expect(body.runId).toBe(runtime.runId);
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0].tool).toBe("Exec");
  });
});
