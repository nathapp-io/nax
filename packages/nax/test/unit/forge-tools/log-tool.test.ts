import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolveProviderTools, type ToolRunContext } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import type { ForgeCheck, ForgeDeps, JobLogRead, PrInfo, PrRef } from "@/forge";
import { _forgeToolsDeps, createForgeReadProvider } from "@/forge-tools";

const ref: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 7 };
const info: PrInfo = {
  number: 7,
  title: "PR",
  body: "",
  url: "u",
  state: "open",
  draft: false,
  author: { login: "bot" },
  baseRef: "main",
  headRef: "fix",
  headSha: "abc",
  crossRepo: false,
};
const check: ForgeCheck = { id: "7", name: "test", status: "completed", conclusion: "failure", hasJobLog: true };
const ctx: ToolRunContext = { root: "/other", resolvedPaths: [], maxBytes: 50_000, maxFileBytes: 50_000 };
const run = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
const deps: ForgeDeps = { run, readText: async () => null };
const resolveRef = mock(async () => ref);
const binding = { resolveRef, deps, cwd: "/bound" };
const original = { ..._forgeToolsDeps };
async function tool() {
  const tools = await createForgeReadProvider(binding).tools(ctx.root);
  const log = tools.find((entry) => entry.localName === "log");
  assertDefined(log);
  return log;
}
beforeEach(() => {
  run.mockClear();
  resolveRef.mockClear();
  _forgeToolsDeps.readPrInfo = mock(async () => info);
  _forgeToolsDeps.listHeadChecks = mock(async () => [check, { ...check, id: "8" }]);
  _forgeToolsDeps.readJobLog = mock(async (): Promise<JobLogRead> => ({ ok: true, text: "one\ntwo\nthree\n" }));
});
afterEach(() => Object.assign(_forgeToolsDeps, original));

describe("log tool", () => {
  test("AC-1 advertises nax-forge__log", async () => {
    const resolved = await resolveProviderTools([createForgeReadProvider(binding)], "run", ctx.root);
    expect(resolved.tools.map((entry) => entry.name)).toContain("nax-forge__log");
  });
  test("AC-2/3 rejects non-head ids without reading logs", async () => {
    const result = await (await tool()).run({ check: "99" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("99");
    expect(result.content).toContain("nax-forge__checks");
    expect(_forgeToolsDeps.readJobLog).not.toHaveBeenCalled();
  });
  test("AC-4 rejects checks with no job log", async () => {
    _forgeToolsDeps.listHeadChecks = mock(async () => [{ ...check, hasJobLog: false }]);
    const result = await (await tool()).run({ check: "7" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("7");
    expect(result.content).toContain("no job log");
    expect(_forgeToolsDeps.readJobLog).not.toHaveBeenCalled();
  });
  test("AC-6 normalizes integer check ids", async () => {
    expect((await (await tool()).run({ check: 7 }, ctx)).isError).not.toBe(true);
    expect(_forgeToolsDeps.readJobLog).toHaveBeenCalledWith(ref, "7", deps, "/bound");
  });
  test("AC-7/8 tails 200 numbered lines and keeps showing line outside the fence", async () => {
    _forgeToolsDeps.readJobLog = mock(
      async (): Promise<JobLogRead> => ({
        ok: true,
        text: Array.from({ length: 1_000 }, (_, i) => `line ${i + 1}`).join("\n"),
      }),
    );
    const result = await (await tool()).run({ check: "7" }, ctx);
    const lines = result.content.split("\n");
    const showing = lines.indexOf("showing lines 801-1000 of 1000");
    const fence = lines.findIndex((line) => /^`{3,}$/.test(line));
    expect(showing).toBeGreaterThanOrEqual(0);
    expect(showing).toBeLessThan(fence);
    expect(lines.slice(fence + 2, -1)).toEqual(Array.from({ length: 200 }, (_, i) => `${i + 801}: line ${i + 801}`));
    expect(lines[fence + 1]).toContain("test");
    expect(lines[fence + 1]).toContain("completed");
  });
  test("AC-9 excludes one trailing empty line", async () => {
    const result = await (await tool()).run({ check: "7" }, ctx);
    expect(result.content).toContain("showing lines 1-3 of 3");
    expect(result.content).toContain("3: three");
    expect(result.content).not.toContain("4:");
  });
  test("AC-10 fits tail by dropping start lines", async () => {
    _forgeToolsDeps.readJobLog = mock(
      async (): Promise<JobLogRead> => ({
        ok: true,
        text: Array.from({ length: 100 }, (_, i) => `entry-${i + 1}`).join("\n"),
      }),
    );
    const result = await (await tool()).run({ check: "7" }, { ...ctx, maxBytes: 250 });
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(250);
    expect(result.content).toContain("100: entry-100");
    expect(result.content).not.toContain("1: entry-1\n");
  });
  test.each<[string, Record<string, unknown>]>([
    ["lines", { check: "7", lines: 501 }],
    ["check", {}],
    ["check", { check: null }],
    ["check", { check: 1.5 }],
    ["check", { check: -1 }],
    ["check", { check: "7x" }],
    ["check", { check: "" }],
    ["check", { check: true }],
    ["lines", { check: "7", lines: "2" }],
    ["lines", { check: "7", lines: 0 }],
    ["lines", { check: "7", lines: 1.5 }],
    ["lines", { check: "7", lines: null }],
    ["search", { check: "7", search: "" }],
    ["search", { check: "7", search: 2 }],
    ["from", { check: "7", from: 0 }],
    ["from", { check: "7", from: "1" }],
    ["from", { check: "7", from: 2.5, search: "valid" }],
    ["repo", { check: "7", repo: "other" }],
  ])("AC-11/12/13/18 invalid %s makes no forge calls (%j)", async (field, input) => {
    const result = await (await tool()).run(input, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(field);
    expect(resolveRef).not.toHaveBeenCalled();
    expect(_forgeToolsDeps.readPrInfo).not.toHaveBeenCalled();
    expect(_forgeToolsDeps.listHeadChecks).not.toHaveBeenCalled();
    expect(_forgeToolsDeps.readJobLog).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-14 identifies running logs as partial", async () => {
    _forgeToolsDeps.listHeadChecks = mock(
      async (): Promise<readonly ForgeCheck[]> => [{ ...check, status: "in_progress" }],
    );
    expect((await (await tool()).run({ check: "7" }, ctx)).content).toContain("job still running: this log is partial");
  });
  test("AC-15 returns failed read reason", async () => {
    _forgeToolsDeps.readJobLog = mock(async (): Promise<JobLogRead> => ({ ok: false, reason: "gone" }));
    expect(await (await tool()).run({ check: "7" }, ctx)).toEqual({ isError: true, content: "gone" });
  });
  test.each([
    ["completed", 1],
    ["in_progress", 2],
    ["queued", 2],
  ] as const)("AC-16/17 %s reads %i times", async (status, count) => {
    _forgeToolsDeps.listHeadChecks = mock(async () => [{ ...check, status }]);
    const log = await tool();
    await log.run({ check: "7" }, ctx);
    await log.run({ check: "7" }, ctx);
    expect(_forgeToolsDeps.readJobLog).toHaveBeenCalledTimes(count);
    expect(_forgeToolsDeps.readPrInfo).toHaveBeenCalledTimes(2);
    expect(_forgeToolsDeps.listHeadChecks).toHaveBeenCalledTimes(2);
  });
  test("cached completed logs cannot bypass fresh head membership", async () => {
    const log = await tool();
    await log.run({ check: "7" }, ctx);
    _forgeToolsDeps.readPrInfo = mock(async () => ({ ...info, headSha: "new" }));
    _forgeToolsDeps.listHeadChecks = mock(async () => []);
    const result = await log.run({ check: "7" }, ctx);
    expect(result.isError).toBe(true);
    expect(_forgeToolsDeps.listHeadChecks).toHaveBeenCalledWith(ref, "new", deps, "/bound");
    expect(_forgeToolsDeps.readJobLog).toHaveBeenCalledTimes(1);
  });
  test("cache is provider-local", async () => {
    await (await tool()).run({ check: "7" }, ctx);
    await (await tool()).run({ check: "7" }, ctx);
    expect(_forgeToolsDeps.readJobLog).toHaveBeenCalledTimes(2);
  });
  test("cuts long numbered lines and fences hostile check text and log text", async () => {
    _forgeToolsDeps.listHeadChecks = mock(async () => [{ ...check, name: "hostile ```" }]);
    _forgeToolsDeps.readJobLog = mock(
      async (): Promise<JobLogRead> => ({ ok: true, text: `\`\`\`\n${"x".repeat(5_000)}` }),
    );
    const result = await (await tool()).run({ check: "7" }, ctx);
    const lines = result.content.split("\n");
    expect(lines[2]).toBe("````");
    expect(lines.at(-1)).toBe("````");
    expect(lines).toContain("1: ```");
    expect(lines.find((line) => line.startsWith("2: "))?.length).toBe(1_000);
  });
});
