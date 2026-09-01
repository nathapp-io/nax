/**
 * The `agent.protocol` capability gate.
 *
 * protocol does not route — the agent name does. It decides what is permitted,
 * because native calls hit a different billing path and must be opted into.
 */

import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config/schemas";

function config(overrides: Record<string, unknown>) {
  return { version: 1, ...overrides };
}

describe("agent.protocol gate", () => {
  test("defaults to acp so existing config is unchanged", () => {
    const parsed = NaxConfigSchema.parse(config({}));
    expect(parsed.agent.protocol).toBe("acp");
  });

  test("rejects a native model entry under protocol acp", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "acp", default: "claude" },
        models: { claude: { fast: "haiku" }, native: { cheap: "openai/gpt-5.4-mini" } },
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("protocol");
  });

  test("accepts a native model entry under protocol hybrid", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "hybrid", default: "claude" },
        models: { claude: { fast: "haiku" }, native: { cheap: "openai/gpt-5.4-mini" } },
      }),
    );
    expect(result.success).toBe(true);
  });

  test("rejects an acpx model entry under protocol native", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "native", default: "native" },
        models: { claude: { fast: "haiku" }, native: { cheap: "openai/gpt-5.4-mini" } },
      }),
    );
    expect(result.success).toBe(false);
  });

  test("rejects protocol native when agent.default is not native", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "native", default: "claude" },
        models: { native: { cheap: "openai/gpt-5.4-mini" } },
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("agent.default");
  });
});
