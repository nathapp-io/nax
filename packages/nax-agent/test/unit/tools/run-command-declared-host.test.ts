import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CommandLauncher, SandboxState } from "#src/sandbox/index";
import { createRunCommandTool } from "#src/tools/index";
import type { RunCommandExecOptions } from "#src/tools/run-command";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

// #2935: declared commands run through nax's quality runner on the host, never
// through the session launcher. The description says so whenever a sandbox is
// running, so a model that sees NAX_SANDBOXED=1 in Bash does not conclude that
// every command tool is sandboxed.
const DECLARED_HOST_SENTENCE =
  "A declared command runs on the host, outside the sandbox, the same way nax runs its own quality gates.";

let root: string;
beforeEach(() => {
  root = makeTempDir("declared-host-");
});
afterEach(() => cleanupTempDir(root));

const DECLARED = new Map([["testScoped", "bun test {{files}}"]]);

function launcherIn(state: SandboxState): CommandLauncher {
  return {
    state,
    run: async () => {
      throw new Error("the description test never runs a command");
    },
  };
}

const exec = (launcher?: CommandLauncher): RunCommandExecOptions => ({
  repoRoot: root,
  packageWorkdir: root,
  allowScripts: false,
  patterns: ["bun *"],
  ...(launcher !== undefined ? { launcher } : {}),
});

const available = (): CommandLauncher => launcherIn({ kind: "available", backend: "srt", network: "open" });

describe("#2935 RunCommand says where a declared command runs", () => {
  test("exec variant with a running sandbox names the host", () => {
    const description = createRunCommandTool(DECLARED, { exec: exec(available()) }).description;
    expect(description).toContain(DECLARED_HOST_SENTENCE);
    expect(description).toContain('An "argv" call runs inside an OS sandbox');
  });

  test("declared-only variant with a running sandbox names the host", () => {
    const description = createRunCommandTool(DECLARED, { launcher: available() }).description;
    expect(description).toContain(DECLARED_HOST_SENTENCE);
  });

  test("no sandbox running: the description is unchanged", () => {
    const states: SandboxState[] = [{ kind: "disabled" }, { kind: "unavailable", backend: "srt", reason: "no backend" }];
    for (const state of states) {
      expect(createRunCommandTool(DECLARED, { launcher: launcherIn(state) }).description).not.toContain(
        DECLARED_HOST_SENTENCE,
      );
      expect(createRunCommandTool(DECLARED, { exec: exec(launcherIn(state)) }).description).not.toContain(
        DECLARED_HOST_SENTENCE,
      );
    }
    expect(createRunCommandTool(DECLARED, {}).description).toBe(
      "Run one of this project's declared commands: testScoped ({{files}}). Supply values for its placeholders; you cannot write a command of your own.",
    );
  });
});
