import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeSpawn } from "@test/helpers";
import { _qualityRunnerDeps, runQualityCommand } from "@/quality/runner";

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
    const { spawn, lastEnv } = makeSpawn();
    _qualityRunnerDeps.spawn = spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "true",
      workdir: "/tmp",
      stripEnvVars: ["AWS_SECRET_ACCESS_KEY"],
    });

    expect(lastEnv().AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  test("passes env unchanged when no stripEnvVars provided", async () => {
    process.env.MY_VAR = "keep-me";
    const { spawn, lastEnv } = makeSpawn();
    _qualityRunnerDeps.spawn = spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "true",
      workdir: "/tmp",
    });

    expect(lastEnv().MY_VAR).toBe("keep-me");
  });

  test("strips multiple vars when multiple are configured", async () => {
    process.env.AWS_SECRET_ACCESS_KEY = "secret1";
    process.env.MY_VAR = "secret2";
    const { spawn, lastEnv } = makeSpawn();
    _qualityRunnerDeps.spawn = spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "true",
      workdir: "/tmp",
      stripEnvVars: ["AWS_SECRET_ACCESS_KEY", "MY_VAR"],
    });

    expect(lastEnv().AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(lastEnv().MY_VAR).toBeUndefined();
  });

  test("env override still applies after stripping", async () => {
    process.env.AWS_SECRET_ACCESS_KEY = "leak-me";
    const { spawn, lastEnv } = makeSpawn();
    _qualityRunnerDeps.spawn = spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "true",
      workdir: "/tmp",
      stripEnvVars: ["AWS_SECRET_ACCESS_KEY"],
      env: { OVERRIDE_VAR: "override-value" },
    });

    expect(lastEnv().AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(lastEnv().OVERRIDE_VAR).toBe("override-value");
  });
});
