import { describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { compileToolPolicy, createBashTool, createCodingToolRuntime } from "@/tools";
import { redirectForArgv, redirectForCommand, redirectForVerb } from "@/tools/denial-redirect";

const available = (...names: string[]) => new Set(names);
const declared = (...names: string[]) => new Set(names);

describe("redirectForCommand", () => {
  test("names Grep for a denied grep command", () => {
    expect(redirectForCommand("grep -n foo src", available("Grep"), declared())).toContain("`Grep`");
  });

  test("reads the FIRST segment of a chain", () => {
    expect(redirectForCommand("git log --oneline | head -5", available("Git"), declared())).toContain("`Git`");
  });

  test("names the project's declared commands for a task runner", () => {
    expect(redirectForCommand("bun run lint", available("RunCommand"), declared("lint"))).toContain("lint");
  });

  test("never names a tool the session does not have", () => {
    expect(redirectForCommand("grep -n foo src", available(), declared())).toBeUndefined();
  });

  test("a command with an unanalysable construct still gets a redirect", () => {
    expect(redirectForCommand("grep $(cat pattern.txt) src", available("Grep"), declared())).toContain("`Grep`");
  });

  test("nax's own run state is explained rather than redirected", () => {
    const hint = redirectForCommand("git checkout .nax/state.json", available("Git"), declared());
    expect(hint).toContain(".nax/");
  });
});

describe("Bash as a redirect target (spec US-008)", () => {
  test("a denied `bash -c ...` argv names Bash when the session has it", () => {
    expect(redirectForArgv(["bash", "-c", "bun test"], available("Bash"), declared())).toContain("`Bash`");
  });

  test("and does NOT name it when the session does not", () => {
    expect(redirectForArgv(["bash", "-c", "bun test"], available("Read"), declared())).toBeUndefined();
  });

  test("a denied `sh` verb slot names Bash when advertised", () => {
    expect(redirectForVerb("RunCommand", "sh -c 'bun test'", available("Bash"), declared())).toContain("`Bash`");
  });

  test("telling Bash it already has Bash is suppressed", () => {
    expect(redirectForVerb("Bash", "bash -c 'bun test'", available("Bash"), declared())).toBeUndefined();
  });
});

describe("the denied:ask message (spec US-007/US-008)", () => {
  test("names the rule and the headless limitation, not a prohibition", async () => {
    const root = makeTempDir("ask-message-");
    try {
      const runtime = createCodingToolRuntime({
        policy: compileToolPolicy([{ tool: "Bash", patterns: ["rm *"] }], root, {
          askRules: [{ tool: "Bash", patterns: ["rm *"] }],
        }),
        extraTools: [createBashTool()],
      });
      runtime.advertised(["Bash"]);
      const outcome = await runtime.callTool("Bash", { command: "rm src/a.ts" });
      expect(outcome.kind).toBe("denied");
      if (outcome.kind === "denied") {
        expect(outcome.reason).toContain("Bash(rm *)");
        expect(outcome.reason).toContain("headless");
      }
    } finally {
      cleanupTempDir(root);
    }
  });
});
