/**
 * US-001: the environment a complete() call on an ACP agent is launched with.
 * The provider family is selected at the launch boundary, so a codex session
 * never receives another provider's key or nax's own secrets.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AcpBackendOptions } from "@nathapp/nax-agent-acp/client";
import { replyTurn, scriptedOpened } from "@test/helpers/acp-fake-agent";
import { _acpDeps, AcpAgentAdapter } from "@/agents/acp";
import { FALLBACK_RATES } from "@/agents/cost";

const REAL = { ..._acpDeps };
const touchedEnv = new Map<string, string | undefined>();
function setEnv(key: string, value: string): void {
  if (!touchedEnv.has(key)) touchedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

beforeEach(() => {
  _acpDeps.resolveRateCard = async () => ({ rates: FALLBACK_RATES, source: "fallback-rates" });
  _acpDeps.cwdExists = async () => true;
});
afterEach(() => {
  Object.assign(_acpDeps, REAL);
  for (const [key, value] of touchedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  touchedEnv.clear();
});

/** Captures the backend options the adapter hands the ACP backend, and answers with a scripted turn. */
function captureBackendOptions(): AcpBackendOptions[] {
  const captured: AcpBackendOptions[] = [];
  const script = scriptedOpened([replyTurn("done")]);
  _acpDeps.acpBackend = (options) => {
    captured.push(options);
    return { kind: `acp:${options.agent}`, open: async () => script.opened };
  };
  return captured;
}

describe("ACP run env (US-001)", () => {
  test("AC-14: complete() on codex launches with an env that carries no NAX_TELEGRAM_TOKEN", async () => {
    setEnv("NAX_TELEGRAM_TOKEN", "nax-secret");
    const captured = captureBackendOptions();
    await new AcpAgentAdapter("codex").complete("q", {
      modelDef: { provider: "openai", model: "gpt-5" },
      workdir: "/tmp/test",
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    });
    expect(captured).toHaveLength(1);
    const env = captured[0]?.env;
    expect(env).not.toHaveProperty("NAX_TELEGRAM_TOKEN");
    // The env is still populated: the essentials a spawned process needs are there.
    expect(env?.PATH).toBe(process.env.PATH);
  });
});
