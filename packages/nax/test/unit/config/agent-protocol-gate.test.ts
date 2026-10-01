/**
 * The `agent.protocol` capability gate.
 *
 * protocol does not route — the agent name does. It decides what is permitted,
 * because native calls hit a different billing path and must be opted into.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { deepMergeConfig } from "@/config/merger";
import { NaxConfigSchema } from "@/config/schemas";

function config(overrides: Record<string, unknown>) {
  return { version: 1, ...overrides };
}

describe("agent.protocol gate", () => {
  test("defaults to hybrid with native as the default agent", () => {
    const parsed = NaxConfigSchema.parse(config({}));
    expect(parsed.agent.protocol).toBe("hybrid");
    expect(parsed.agent.default).toBe("native");
  });

  test("rejects protocol acp when agent.default is native", () => {
    const result = NaxConfigSchema.safeParse(config({ agent: { protocol: "acp", default: "native" } }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("agent.default");
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

/**
 * nax#1851. The native path takes the provider from the model STRING and
 * deliberately ignores `ModelDef.provider` (`adapter.ts` — resolveModel INFERS
 * that field, and a billed call must not route on a guess). Nothing said so at
 * config load, so a bare model id parsed clean and died 74ms into a paid run.
 */
describe("models.native model ids must be provider-qualified", () => {
  test("rejects a bare model id in the string form", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "native", default: "native" },
        models: { native: { fast: "claude-sonnet-5" } },
      }),
    );
    expect(result.success).toBe(false);
    const issues = JSON.stringify(result.error?.issues);
    expect(issues).toContain("provider/model");
    expect(issues).toContain("claude-sonnet-5");
  });

  test("rejects a bare model id in the object form, and names the ignored provider field", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "native", default: "native" },
        models: { native: { fast: { provider: "anthropic", model: "claude-sonnet-5" } } },
      }),
    );
    expect(result.success).toBe(false);
    const issues = JSON.stringify(result.error?.issues);
    // The whole trap: a sibling `provider` field sits right there and is unused.
    expect(issues).toContain("provider");
    expect(issues).toContain("anthropic/claude-sonnet-5");
  });

  test("accepts a provider-qualified id, including one whose model half has slashes", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "native", default: "native" },
        models: { native: { fast: "openai/gpt-5.4-mini", slow: "huggingface/MiniMaxAI/MiniMax-M2.7" } },
      }),
    );
    expect(result.success).toBe(true);
  });

  test("accepts a provider-qualified id carrying an effort suffix", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "native", default: "native" },
        models: { native: { fast: "anthropic/claude-opus-5[high]" } },
      }),
    );
    expect(result.success).toBe(true);
  });

  test("rejects a bare model id carrying an effort suffix", () => {
    // The suffix is trailing, so it must be stripped before the slash test —
    // otherwise "claude-opus-5[high]" is checked as-is and still has no slash,
    // while a suffix containing one would wrongly pass.
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "native", default: "native" },
        models: { native: { fast: "claude-opus-5[high]" } },
      }),
    );
    expect(result.success).toBe(false);
  });

  test("leaves acpx agents' model ids alone", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "hybrid", default: "claude" },
        models: { claude: { fast: "haiku" }, native: { cheap: "openai/gpt-5.4-mini" } },
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("agent.protocol gate — fallback ladder rungs", () => {
  test("rejects a native rung under protocol acp", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "acp", default: "claude", fallback: { enabled: true, map: { claude: ["native"] } } },
        models: { claude: { fast: "haiku" } },
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("fallback");
  });

  test("rejects an acpx rung under protocol native", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: {
          protocol: "native",
          default: "native",
          fallback: { enabled: true, map: { native: [{ agent: "claude" }] } },
        },
        models: { native: { fast: "openai/gpt-5.4-mini" } },
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("fallback");
  });

  test("accepts a mixed ladder under protocol hybrid", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: {
          protocol: "hybrid",
          default: "native",
          fallback: { enabled: true, map: { native: [{ agent: "native", model: "powerful" }, "claude"] } },
        },
        models: { native: { fast: "openai/gpt-5.4-mini", powerful: "openai/gpt-5.4" }, claude: { fast: "haiku" } },
      }),
    );
    expect(result.success).toBe(true);
  });

  test("a ladder key is checked as well as its rungs", () => {
    const result = NaxConfigSchema.safeParse(
      config({
        agent: { protocol: "acp", default: "claude", fallback: { enabled: true, map: { native: ["claude"] } } },
        models: { claude: { fast: "haiku" } },
      }),
    );
    expect(result.success).toBe(false);
  });
});

/**
 * The loader deep-merges every user config over DEFAULT_CONFIG, so the built-in
 * `models.claude` and `models.native` maps are present in every config the gate
 * sees. An untouched built-in map is not a declaration: judging it made
 * protocol "native" unloadable (the injected models.claude) and would make
 * protocol "acp" unloadable (the injected models.native).
 */
describe("agent.protocol gate — built-in model maps are not declarations", () => {
  function loaded(user: Record<string, unknown>) {
    const base: Record<string, unknown> = { ...structuredClone(DEFAULT_CONFIG) };
    return NaxConfigSchema.safeParse(deepMergeConfig<Record<string, unknown>>(base, user));
  }

  test("protocol native loads with the built-in models.claude present", () => {
    const result = loaded({
      agent: { protocol: "native", default: "native" },
      models: { native: { fast: "openai/gpt-5.4-mini", balanced: "openai/gpt-5.4", powerful: "openai/gpt-5.4" } },
    });
    expect(result.success).toBe(true);
  });

  test("protocol acp loads with the built-in models.native present", () => {
    const result = loaded({ agent: { protocol: "acp", default: "claude" } });
    expect(result.success).toBe(true);
  });

  test("protocol acp still rejects a user-edited models.native", () => {
    const result = loaded({
      agent: { protocol: "acp", default: "claude" },
      models: { native: { fast: "openai/gpt-5.4-mini" } },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("models.native requires");
  });

  test("protocol native still rejects a user-edited models.claude", () => {
    const result = loaded({ agent: { protocol: "native", default: "native" }, models: { claude: { fast: "sonnet" } } });
    expect(result.success).toBe(false);
  });

  test("protocol acp with the built-in agent.default names the fix", () => {
    const result = loaded({ agent: { protocol: "acp" } });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("agent.default");
  });
});
