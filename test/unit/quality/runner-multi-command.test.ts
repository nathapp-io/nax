import { afterEach, describe, expect, test } from "bun:test";
import { makeSpawn } from "@test/helpers";
import { _qualityRunnerDeps, runQualityCommand } from "@/quality/runner";

const realSpawn = _qualityRunnerDeps.spawn;
afterEach(() => {
  _qualityRunnerDeps.spawn = realSpawn;
});

/** Script each shell command's exit code; returns the stub for call assertions. */
function stubSpawn(exitCodeFor: (command: string) => number) {
  const stub = makeSpawn(({ cmd }) => {
    const command = cmd[2] ?? "";
    return { exitCode: exitCodeFor(command), stdout: `output of ${command}` };
  });
  _qualityRunnerDeps.spawn = stub.spawn;
  return stub;
}

/** The shell command of each recorded spawn, in order. */
function commandsRun(stub: ReturnType<typeof stubSpawn>): string[] {
  return stub.calls.map((call) => call.cmd[2] ?? "");
}

describe("runQualityCommand with a list", () => {
  test("runs every entry even after one fails", async () => {
    const stub = stubSpawn((c) => (c === "step-a" ? 1 : 0));
    await runQualityCommand({
      commandName: "typecheck",
      command: ["step-a", "step-b", "step-c"],
      workdir: "/tmp",
    });
    expect(commandsRun(stub)).toEqual(["step-a", "step-b", "step-c"]);
  });

  test("aggregates failure across entries", async () => {
    stubSpawn((c) => (c === "step-b" ? 2 : 0));
    const result = await runQualityCommand({
      commandName: "typecheck",
      command: ["step-a", "step-b"],
      workdir: "/tmp",
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  test("carries output from every entry", async () => {
    stubSpawn(() => 0);
    const result = await runQualityCommand({
      commandName: "typecheck",
      command: ["step-a", "step-b"],
      workdir: "/tmp",
    });
    expect(result.output).toContain("output of step-a");
    expect(result.output).toContain("output of step-b");
  });

  test("succeeds when every entry succeeds", async () => {
    stubSpawn(() => 0);
    const result = await runQualityCommand({
      commandName: "lint",
      command: ["step-a", "step-b"],
      workdir: "/tmp",
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("a plain string still spawns exactly once", async () => {
    const stub = stubSpawn(() => 0);
    const result = await runQualityCommand({
      commandName: "lint",
      command: "only-one",
      workdir: "/tmp",
    });
    expect(commandsRun(stub)).toEqual(["only-one"]);
    expect(result.command).toBe("only-one");
  });

  test("preserves a plain string command byte-for-byte", async () => {
    const stub = stubSpawn(() => 0);
    const command = "  only-one  ";
    const result = await runQualityCommand({ commandName: "lint", command, workdir: "/tmp" });
    expect(commandsRun(stub)).toEqual([command]);
    expect(result.command).toBe(command);
  });

  test("an empty list is treated as an undeclared command", async () => {
    const stub = stubSpawn(() => 0);
    const result = await runQualityCommand({ commandName: "build", command: [], workdir: "/tmp" });
    expect(stub.calls).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.output).toContain("empty command");
  });
});
