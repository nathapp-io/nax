/**
 * US-008 — what a coding-tool dispatch sees of `quality.commands` (#2530).
 *
 * `e2e` is declared so an agent can run it, and it runs the suite, so it takes
 * the full-suite timeout. `e2eSetup` is host-only — it bootstraps the host
 * (docker compose, a dev server); the agent's Bash sandbox must never run it.
 */
import { describe, expect, test } from "bun:test";
import {
  extractDispatchConfigFields,
  type TimedDeclaredCommandRunner,
  withSuiteCommandTimeout,
} from "@/agents/dispatch-config-fields";
import { DEFAULT_CONFIG } from "@/config/defaults";

test("US-008 AC-13 native Bash dispatch strips forge tokens", () => {
  expect(extractDispatchConfigFields(DEFAULT_CONFIG).stripEnvVars).toEqual(
    expect.arrayContaining(["GITLAB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]),
  );
});

const commands = {
  test: "bun test",
  e2e: "bunx playwright test",
  e2eSetup: "docker compose up -d",
} as const;

describe("extractDispatchConfigFields — e2e", () => {
  test("AC-13: e2eSetup is not among the declared commands", () => {
    const fields = extractDispatchConfigFields({ quality: { commands } });

    expect("e2eSetup" in fields.commands).toBe(false);
  });

  test("AC-14: e2e stays declared", () => {
    const fields = extractDispatchConfigFields({ quality: { commands } });

    expect(fields.commands.e2e).toBe("bunx playwright test");
  });
});

describe("withSuiteCommandTimeout — e2e", () => {
  test("AC-15: a request naming e2e gets the bound full-suite timeout", async () => {
    const seen: { commandName: string; timeoutMs?: number }[] = [];
    const runner: TimedDeclaredCommandRunner = async (request) => {
      seen.push({ commandName: request.commandName, timeoutMs: request.timeoutMs });
      return { success: true, exitCode: 0, output: "ok" };
    };
    const fields = extractDispatchConfigFields({
      quality: { commands },
      execution: { regressionGate: { timeoutSeconds: 777 } },
    });

    const bound = withSuiteCommandTimeout(runner, fields.suiteCommandTimeoutMs);
    await bound({
      commandName: "e2e",
      command: "bunx playwright test",
      workdir: "/repo",
      stripEnvVars: [],
      origin: "agent-tool",
    });

    expect(seen).toEqual([{ commandName: "e2e", timeoutMs: 777_000 }]);
  });
});
