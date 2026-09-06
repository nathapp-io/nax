import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileToolPolicy } from "@/tools/policy";
import type { CodingTool } from "@/tools/registry";
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
