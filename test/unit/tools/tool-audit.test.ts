import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileToolPolicy } from "@/tools/policy";
import { createCodingToolRuntime } from "@/tools/runtime";
import { createToolAuditSink } from "@/tools/tool-audit";

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
