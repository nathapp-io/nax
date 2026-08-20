import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runQualityCommand, _qualityRunnerDeps } from "@/quality/runner";

function makeEnvCapturingSpawn(exitCode: number): {
  spawnMock: ReturnType<typeof mock>;
  getLastEnv: () => Record<string, string | undefined>;
} {
  let lastEnv: Record<string, string | undefined> = {};
  const spawnMock = mock((_args: unknown) => {
    const args = _args as { env?: Record<string, string | undefined> };
    lastEnv = args.env ?? {};
    return {
      exited: Promise.resolve(exitCode),
      stdout: new ReadableStream({ start(c) { c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      kill: mock(() => {}),
    } as unknown as ReturnType<typeof Bun.spawn>;
  });
  return { spawnMock, getLastEnv: () => lastEnv };
}

describe("runQualityCommand env stripping", () => {
  let originalSpawn: typeof _qualityRunnerDeps.spawn;

  beforeEach(() => {
    originalSpawn = _qualityRunnerDeps.spawn;
  });

  afterEach(() => {
    _qualityRunnerDeps.spawn = originalSpawn;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.MY_VAR;
  });

  test("removes configured secret vars from the spawned env", async () => {
    process.env.AWS_SECRET_ACCESS_KEY = "leak-me";
    const { spawnMock, getLastEnv } = makeEnvCapturingSpawn(0);
    _qualityRunnerDeps.spawn = spawnMock as unknown as typeof Bun.spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "true",
      workdir: "/tmp",
      stripEnvVars: ["AWS_SECRET_ACCESS_KEY"],
    });

    expect(getLastEnv()["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
  });

  test("passes env unchanged when no stripEnvVars provided", async () => {
    process.env.MY_VAR = "keep-me";
    const { spawnMock, getLastEnv } = makeEnvCapturingSpawn(0);
    _qualityRunnerDeps.spawn = spawnMock as unknown as typeof Bun.spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "true",
      workdir: "/tmp",
    });

    expect(getLastEnv()["MY_VAR"]).toBe("keep-me");
  });

  test("strips multiple vars when multiple are configured", async () => {
    process.env.AWS_SECRET_ACCESS_KEY = "secret1";
    process.env.MY_VAR = "secret2";
    const { spawnMock, getLastEnv } = makeEnvCapturingSpawn(0);
    _qualityRunnerDeps.spawn = spawnMock as unknown as typeof Bun.spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "true",
      workdir: "/tmp",
      stripEnvVars: ["AWS_SECRET_ACCESS_KEY", "MY_VAR"],
    });

    expect(getLastEnv()["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(getLastEnv()["MY_VAR"]).toBeUndefined();
  });

  test("env override still applies after stripping", async () => {
    process.env.AWS_SECRET_ACCESS_KEY = "leak-me";
    const { spawnMock, getLastEnv } = makeEnvCapturingSpawn(0);
    _qualityRunnerDeps.spawn = spawnMock as unknown as typeof Bun.spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "true",
      workdir: "/tmp",
      stripEnvVars: ["AWS_SECRET_ACCESS_KEY"],
      env: { OVERRIDE_VAR: "override-value" },
    });

    expect(getLastEnv()["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(getLastEnv()["OVERRIDE_VAR"]).toBe("override-value");
  });
});
