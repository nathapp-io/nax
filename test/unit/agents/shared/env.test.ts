/**
 * Tests for shared buildAllowedEnv() utility (src/agents/shared/env.ts)
 *
 * Covers issue #52 — single canonical env allowlist implementation
 * replacing duplicate logic in execution.ts and spawn-client.ts.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { buildAllowedEnv } from "../../../../src/agents/shared/env";

describe("buildAllowedEnv (shared)", () => {
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore process.env
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    Object.assign(process.env, origEnv);
  });

  test("includes PATH and HOME", () => {
    const env = buildAllowedEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBeDefined();
  });

  test("includes ANTHROPIC_API_KEY when set", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const env = buildAllowedEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("test-key");
  });

  test("includes GEMINI_API_KEY when set", () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    const env = buildAllowedEnv();
    expect(env.GEMINI_API_KEY).toBe("gemini-key");
  });

  test("includes OPENAI_API_KEY when set", () => {
    process.env.OPENAI_API_KEY = "openai-key";
    const env = buildAllowedEnv();
    expect(env.OPENAI_API_KEY).toBe("openai-key");
  });

  test("includes NAX_* prefix vars", () => {
    process.env.NAX_SKIP_PRECHECK = "1";
    const env = buildAllowedEnv();
    expect(env.NAX_SKIP_PRECHECK).toBe("1");
  });

  test("includes ACPX_* prefix vars", () => {
    process.env.ACPX_TIMEOUT = "30000";
    const env = buildAllowedEnv();
    expect(env.ACPX_TIMEOUT).toBe("30000");
  });

  test("includes ANTHROPIC_* prefix vars (beyond API key)", () => {
    process.env.ANTHROPIC_BASE_URL = "https://example.com";
    const env = buildAllowedEnv();
    expect(env.ANTHROPIC_BASE_URL).toBe("https://example.com");
  });

  test("does NOT include arbitrary env vars", () => {
    process.env.MY_SECRET_TOKEN = "should-not-pass";
    const env = buildAllowedEnv();
    expect(env.MY_SECRET_TOKEN).toBeUndefined();
  });

  test("extra env overrides process.env vars", () => {
    process.env.NAX_FOO = "original";
    const env = buildAllowedEnv({ env: { NAX_FOO: "override" } });
    expect(env.NAX_FOO).toBe("override");
  });

  test("modelEnv is merged before extra env", () => {
    const env = buildAllowedEnv({
      modelEnv: { CLAUDE_MODEL: "model-from-def" },
      env: { CLAUDE_MODEL: "model-from-call" },
    });
    // call-site env wins over modelEnv
    expect(env.CLAUDE_MODEL).toBe("model-from-call");
  });

  test("modelEnv vars are included when no override", () => {
    const env = buildAllowedEnv({ modelEnv: { CLAUDE_EXTRA: "from-model" } });
    expect(env.CLAUDE_EXTRA).toBe("from-model");
  });

  test("works with no arguments", () => {
    expect(() => buildAllowedEnv()).not.toThrow();
    const env = buildAllowedEnv();
    expect(typeof env).toBe("object");
  });
});
