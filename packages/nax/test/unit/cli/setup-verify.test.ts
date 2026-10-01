import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { runSetupGate } from "@/cli/setup-verify";
import { initLogger, resetLogger } from "@/logger";

describe("runSetupGate", () => {
  beforeEach(() => {
    resetLogger();
    initLogger({ level: "silent" });
  });

  afterEach(() => {
    resetLogger();
  });

  test("returns 0 when no test command is configured", async () => {
    const config = makeNaxConfig({ quality: { commands: {} } });

    const exitCode = await runSetupGate(process.cwd(), config);

    expect(exitCode).toBe(0);
  });

  test("returns the exit code of a passing configured test command", async () => {
    const config = makeNaxConfig({ quality: { commands: { test: "exit 0" } } });

    const exitCode = await runSetupGate(process.cwd(), config);

    expect(exitCode).toBe(0);
  });

  test("returns the exit code of a failing configured test command", async () => {
    const config = makeNaxConfig({ quality: { commands: { test: "exit 7" } } });

    const exitCode = await runSetupGate(process.cwd(), config);

    expect(exitCode).toBe(7);
  });
});
