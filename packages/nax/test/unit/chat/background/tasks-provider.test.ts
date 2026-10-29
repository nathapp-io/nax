import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BackgroundCommandEnd, ToolProvider } from "@nathapp/nax-agent";
import { makeLogger } from "@test/helpers";
import * as background from "@/chat/background";
import * as prompts from "@/prompts";

const original = { ...background._backgroundTaskDeps };
beforeEach(() =>
  Object.assign(background._backgroundTaskDeps, {
    randomHex: () => "1a2b3c4d",
    mkdir: () => {},
    appendLog: async () => {},
    readLog: async () => "first\nsecond\nthird\n",
  }),
);
afterEach(() => Object.assign(background._backgroundTaskDeps, original));
function fixture() {
  const host = background.createHostTasks({ outputDir: "/o", now: () => new Date(0), logger: makeLogger() });
  const end = Promise.withResolvers<BackgroundCommandEnd>();
  const stop = mock(() => end.resolve({ exitCode: 0, timedOut: false, aborted: true }));
  const id = host.tasks.adopt({ command: "bun test", origin: "agent", ended: end.promise, stop }).id;
  const finish = async () => {
    end.resolve({ exitCode: 1, timedOut: false, aborted: false });
    await end.promise;
  };
  return { ...host, id, stop, finish };
}
async function run(provider: ToolProvider, name: string, input: Record<string, unknown> = {}) {
  const tool = (await provider.tools("/o")).find((tool) => tool.localName === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.run(input, { root: "/o", resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 });
}
describe("createTasksProvider", () => {
  test.each([
    ["AC-1", { task: "../x" }, "[chat] invalid task id ../x"],
    ["AC-2", { task: "bash-00000000" }, "[chat] unknown task bash-00000000"],
    ["AC-3", { task: "bash-1a2b3c4d", lines: 501 }, "[chat] lines must be an integer from 1 to 500"],
  ])("%s output validation", async (_ac, input, content) => {
    expect(await run(fixture().provider, "output", input)).toEqual({ isError: true, content });
  });
  test.each([0, -1, 1.5, "2", null, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid lines %s",
    async (lines) => {
      expect(await run(fixture().provider, "output", { task: "bash-1a2b3c4d", lines })).toEqual({
        isError: true,
        content: "[chat] lines must be an integer from 1 to 500",
      });
    },
  );
  test("AC-4 output uses registry tail and includes task", async () => {
    const f = fixture();
    const result = await run(f.provider, "output", { task: f.id, lines: 2 });
    expect(JSON.parse(result.content)).toEqual({ ...f.tasks.get(f.id), output: await f.tasks.output(f.id, 2) });
    expect(JSON.parse(result.content).output).toBe("second\nthird");
    expect(JSON.parse((await run(f.provider, "output", { task: f.id })).content).output).toBe("first\nsecond\nthird");
  });
  test("AC-5 finished tasks cannot be stopped", async () => {
    const f = fixture();
    await f.finish();
    expect(await run(f.provider, "stop", { task: f.id })).toEqual({
      isError: true,
      content: `[chat] task ${f.id} is not running`,
    });
    expect(f.stop).not.toHaveBeenCalled();
  });
  test("AC-6 running task stop succeeds without approval", async () => {
    const f = fixture();
    expect(await run(f.provider, "stop", { task: f.id })).toEqual({ content: `stopped task ${f.id}` });
    expect(f.stop).toHaveBeenCalledTimes(1);
  });
  test("AC-7 list exposes summary fields only", async () => {
    const f = fixture();
    expect(JSON.parse((await run(f.provider, "list")).content)).toEqual({
      tasks: [{ id: f.id, command: "bun test", state: "running", startedAt: new Date(0).toISOString() }],
    });
    await f.finish();
    expect(JSON.parse((await run(f.provider, "list")).content).tasks[0]).toMatchObject({
      endedAt: new Date(0).toISOString(),
      exitCode: 1,
    });
  });
  test("AC-8 static provider supplies canonical instructions", async () => {
    const f = fixture();
    expect(f.provider.kind).toBe("static");
    expect(f.provider.stages).toEqual(["*"]);
    expect(await f.provider.instructions?.("/o")).toBe(prompts.buildBackgroundTasksInstructions());
    expect((await f.provider.tools("/o")).map((tool) => tool.localName)).toEqual(["list", "output", "stop"]);
  });
  test.each(["output", "stop"])("%s validates missing, malformed and unknown ids", async (name) => {
    const f = fixture();
    for (const task of [undefined, 1, "../x", "bash-00000000"]) {
      expect(await run(f.provider, name, { task })).toEqual({
        isError: true,
        content: task === "bash-00000000" ? `[chat] unknown task ${task}` : `[chat] invalid task id ${String(task)}`,
      });
    }
  });
});
describe("createHostTasks", () => {
  test("AC-12 provider stops the returned registry's task", async () => {
    const f = fixture();
    expect(f.provider.id).toBe("nax-tasks");
    await run(f.provider, "stop", { task: f.id });
    expect(f.tasks.get(f.id)?.state).toBe("stopped");
    expect(f.stop).toHaveBeenCalledTimes(1);
    await f.tasks.stopAll();
  });
  test("registry delivers canonical notice text", async () => {
    const f = fixture();
    await f.finish();
    expect(f.tasks.peekNotice()).toBe(prompts.buildBackgroundTaskNotice(f.tasks.list()));
    expect(f.tasks.takeNotice()).toBe(prompts.buildBackgroundTaskNotice(f.tasks.list()));
    expect(f.tasks.peekNotice()).toBeUndefined();
  });
});
