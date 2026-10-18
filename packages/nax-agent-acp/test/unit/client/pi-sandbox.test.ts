import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { piSandboxGateSource } from "#src/client/pi-sandbox";
import { NO_RULES, piToolArgs } from "#src/client/rule-policy";
import { PI_SHELL_GATE_REJECTED, PI_SHELL_GATE_TITLE } from "#src/client/shell-rules";
import { wrapForSandbox } from "#src/client/shell-sandbox";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});
const prefix = "'/runtime' '/runner' '/policy' ";

describe("piToolArgs", () => {
  test("AC-16: review without sandbox or rules keeps read tools only", () => {
    expect(piToolArgs("review", NO_RULES, "/g.ts")).toEqual(["--tools", "read,grep,find,ls"]);
  });
  test("AC-17: review without sandbox keeps the Bash-rule gate", () => {
    expect(piToolArgs("review", { ...NO_RULES, allow: [{ tool: "Bash", patterns: ["ls"] }] }, "/g.ts")).toEqual([
      "-e",
      "/g.ts",
      "--tools",
      "read,grep,find,ls,bash",
    ]);
  });
  test.each(["user", "none"] as const)("AC-6/7: sandbox extensions %s enables gated bash", (extensions) => {
    expect(piToolArgs("review", NO_RULES, "/g.ts", { extensions })).toEqual([
      ...(extensions === "none" ? ["--no-extensions"] : []),
      "-e",
      "/g.ts",
      "--tools",
      "read,grep,find,ls,bash",
    ]);
  });
});

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Tool = { name: string; execute: (...args: unknown[]) => unknown };
async function load() {
  const dir = makeTempDir("pi-sandbox-source-");
  dirs.push(dir);
  const fixture = fileURLToPath(new URL("../../fixtures/pi-module.mjs", import.meta.url));
  const path = join(dir, "gate.mjs");
  await writeFile(path, piSandboxGateSource(prefix, fixture));
  const fixtureModule = await import(fixture);
  fixtureModule.calls.length = 0;
  const handlers: Handler[] = [];
  const tools: Tool[] = [];
  (await import(path)).default({
    on: (name: string, handler: Handler) => {
      expect(name).toBe("tool_call");
      handlers.push(handler);
    },
    registerTool: (tool: Tool) => tools.push(tool),
  });
  const handler = handlers[0];
  if (!handler) throw new Error("missing tool_call handler");
  return { tools, handler, calls: fixtureModule.calls };
}

describe("piSandboxGateSource", () => {
  test("AC-8/9/10: registers bash, wraps each spawn and forwards execution arguments", async () => {
    const { tools, calls } = await load();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("bash");
    expect(calls[0].cwd).toBe(process.cwd());
    const env = { A: "1" };
    expect(calls[0].options.spawnHook({ command: "ls", cwd: "/w", env })).toEqual({
      command: wrapForSandbox(prefix, "ls"),
      cwd: "/w",
      env,
    });
    const args = ["id", { command: "ls" }, new AbortController().signal, () => undefined];
    expect(tools[0]?.execute(...args)).toBe("executed");
    expect(calls[1]).toEqual(args);
    args.forEach((arg, i) => {
      expect(calls[1][i]).toBe(arg);
    });
  });
  test.each([
    [11, "bash", true, true, undefined],
    [12, "bash", true, false, { block: true, reason: "nax: shell command rejected" }],
    [13, "bash", false, true, { block: true, reason: "nax: shell command rejected" }],
    [14, "read", true, true, undefined],
  ] as const)("AC-%d: gate %s with UI %s and answer %s", async (_, toolName, hasUI, answer, expected) => {
    const { handler } = await load();
    const confirms: unknown[] = [];
    expect(PI_SHELL_GATE_REJECTED).toBe("nax: shell command rejected");
    expect(
      await Promise.resolve(
        handler(
          { toolName, input: toolName === "bash" ? { command: "ls" } : {} },
          {
            hasUI,
            ui: {
              confirm: async (...args: unknown[]) => {
                confirms.push(args);
                return answer;
              },
            },
          },
        ),
      ),
    ).toEqual(expected);
    expect(confirms).toEqual(toolName === "bash" && hasUI ? [[PI_SHELL_GATE_TITLE, "ls"]] : []);
  });
});
