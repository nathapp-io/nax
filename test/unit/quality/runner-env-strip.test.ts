import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeSpawn } from "@test/helpers";
import { _qualityRunnerDeps, runQualityCommand } from "@/quality/runner";

describe("runQualityCommand env stripping", () => {
  let originalSpawn: typeof _qualityRunnerDeps.spawn;
  // A developer (or agent) running the suite from an agent shell already has
  // CLAUDECODE/AGENT exported, which would satisfy the marker check and make
  // these assertions pass or fail for reasons unrelated to the code. Control
  // them explicitly.
  const markers = ["CLAUDECODE", "REPL_ID", "AGENT"] as const;
  let savedMarkers: Record<string, string | undefined>;

  beforeEach(() => {
    originalSpawn = _qualityRunnerDeps.spawn;
    savedMarkers = Object.fromEntries(markers.map((m) => [m, process.env[m]]));
    for (const m of markers) delete process.env[m];
  });

  afterEach(() => {
    _qualityRunnerDeps.spawn = originalSpawn;
    for (const [m, v] of Object.entries(savedMarkers)) {
      if (v === undefined) delete process.env[m];
      else process.env[m] = v;
    }
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

  // nax#agent-output: bun test (and other agent-aware runners) emit
  // failures-only output when they see this marker. The verification executor
  // applies the same rule — the two spawn sites must not drift.
  test("opts the child into agent-friendly output with AGENT=1", async () => {
    const { spawn, lastEnv } = makeSpawn();
    _qualityRunnerDeps.spawn = spawn;

    await runQualityCommand({ commandName: "lint", command: "true", workdir: "/tmp" });

    expect(lastEnv().AGENT).toBe("1");
  });

  test("an explicit strip of AGENT is not silently undone", async () => {
    const { spawn, lastEnv } = makeSpawn();
    _qualityRunnerDeps.spawn = spawn;

    await runQualityCommand({
      commandName: "lint",
      command: "true",
      workdir: "/tmp",
      stripEnvVars: ["AGENT"],
    });

    expect(lastEnv().AGENT).toBeUndefined();
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
