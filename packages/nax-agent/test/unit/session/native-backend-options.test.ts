/**
 * S4-0: nativeBackend's option validation (the native half carried out of
 * createAgentSession's options, spec 4.1, 7). zod checks the shape; the result
 * keeps the caller's own objects. Profile rules are the native backend's own.
 */
import { describe, expect, test } from "bun:test";
import { nativeProfileRules, parseNativeBackendOptions } from "#src/session/native-backend-options";
import { assertNaxError } from "#test/helpers/index";

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    assertNaxError(err);
    return err.code;
  }
  return undefined;
}

describe("parseNativeBackendOptions", () => {
  test("accepts a provider/model and derives the provider", () => {
    expect(parseNativeBackendOptions({ model: "openai/gpt-5.4-mini" }).provider).toBe("openai");
  });

  test("keeps the caller's object as raw", () => {
    const input = { model: "openai/x" };
    expect(parseNativeBackendOptions(input).raw).toBe<unknown>(input);
  });

  test("rejects a model without a provider", () => {
    expect(code(() => parseNativeBackendOptions({ model: "gpt" }))).toBe("AGENT_SESSION_INVALID_OPTIONS");
  });

  test("rejects unknown keys (strict)", () => {
    expect(code(() => parseNativeBackendOptions({ model: "openai/x", profile: "full" }))).toBe(
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  });

  test("rejects hostPorts.runDeclaredCommand as deferred", () => {
    expect(
      code(() => parseNativeBackendOptions({ model: "openai/x", hostPorts: { runDeclaredCommand: () => 0 } })),
    ).toBe("AGENT_SESSION_INVALID_OPTIONS");
  });

  test("accepts credentials, catalogOverrides and loopHandlers", () => {
    const input = {
      model: "openai/x",
      credentials: { kind: "memory", credentials: {} },
      catalogOverrides: [{ provider: "openai" }],
      loopHandlers: [{ handler: () => {} }],
    };
    expect(parseNativeBackendOptions(input).provider).toBe("openai");
  });

  test("a protectedPaths policy without its arrays is rejected", () => {
    expect(
      code(() =>
        parseNativeBackendOptions({ model: "openai/x", hostPorts: { protectedPaths: { credentialDir: "/x" } } }),
      ),
    ).toBe("AGENT_SESSION_INVALID_OPTIONS");
  });

  test("a non-object input is invalid", () => {
    expect(code(() => parseNativeBackendOptions(undefined))).toBe("AGENT_SESSION_INVALID_OPTIONS");
  });

  test("carryHistoryAcrossModels must be a boolean (S5-3)", () => {
    expect(code(() => parseNativeBackendOptions({ model: "openai/x", carryHistoryAcrossModels: "yes" }))).toBe(
      "AGENT_SESSION_INVALID_OPTIONS",
    );
    expect(parseNativeBackendOptions({ model: "openai/x", carryHistoryAcrossModels: true }).raw).toMatchObject({
      carryHistoryAcrossModels: true,
    });
  });
});

describe("parseNativeBackendOptions: compaction", () => {
  function failure(compaction: unknown): { code: string | undefined; message: string; context: unknown } {
    try {
      parseNativeBackendOptions({ model: "openai/x", compaction });
    } catch (err) {
      assertNaxError(err);
      return { code: err.code, message: err.message, context: err.context };
    }
    return { code: undefined, message: "", context: undefined };
  }

  test("accepts a partial or empty compaction object and keeps the caller's object", () => {
    const compaction = { compactAtPercent: 80 };
    expect(parseNativeBackendOptions({ model: "openai/x", compaction }).raw.compaction).toBe<unknown>(compaction);
    expect(parseNativeBackendOptions({ model: "openai/x", compaction: {} }).provider).toBe("openai");
    expect(parseNativeBackendOptions({ model: "openai/x", compaction: { enabled: false } }).provider).toBe("openai");
  });

  test("out-of-range, non-integer and mistyped values are INVALID_OPTIONS on backend.compaction", () => {
    for (const compaction of [
      { compactAtPercent: 49 },
      { compactAtPercent: 100 },
      { compactAtPercent: 75.5 },
      { keepRecentPercent: 4, compactAtPercent: 90 },
      { keepRecentPercent: 80 },
      { enabled: "yes" },
      null,
      "on",
    ]) {
      const got = failure(compaction);
      expect(got.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
      expect(got.message).toContain("backend.compaction");
    }
  });

  test("a keepRecentPercent too close to compactAtPercent reports the 20-point rule", () => {
    const got = failure({ compactAtPercent: 50, keepRecentPercent: 60 });
    expect(got.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(got.message).toContain("keepRecentPercent must be at least 20 points below compactAtPercent");
    expect(got.context).toMatchObject({ path: "backend.compaction" });
  });

  test("an unknown key inside compaction is ignored, as in execution.compaction", () => {
    expect(failure({ enabled: true, extra: 1 }).code).toBeUndefined();
  });
});

describe("nativeProfileRules", () => {
  const raw = { model: "openai/x" };

  test("full defaults to gated and sandboxed", () => {
    expect(nativeProfileRules("full", raw)).toEqual({ bashApproval: "gated", allowUnsandboxed: false });
  });

  test("ask forces gated: raw and escalate are refused, the default is gated", () => {
    expect(nativeProfileRules("ask", { model: "openai/x" })).toEqual({
      bashApproval: "gated",
      allowUnsandboxed: false,
    });
    for (const mode of ["raw", "escalate"] as const) {
      let caught: unknown;
      try {
        nativeProfileRules("ask", { model: "openai/x", bashApproval: mode });
      } catch (err) {
        caught = err;
      }
      assertNaxError(caught);
      expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
      expect(caught.context).toMatchObject({ path: "backend.bashApproval" });
    }
  });

  test("read and none accept neither knob", () => {
    expect(nativeProfileRules("read", raw)).toEqual({ bashApproval: "gated", allowUnsandboxed: false });
    expect(nativeProfileRules("none", raw)).toEqual({ bashApproval: "gated", allowUnsandboxed: false });
  });

  test("bashApproval and allowUnsandboxed are refused for none and read", () => {
    for (const profile of ["none", "read"] as const) {
      expect(code(() => nativeProfileRules(profile, { ...raw, bashApproval: "gated" }))).toBe(
        "AGENT_SESSION_INVALID_OPTIONS",
      );
      expect(code(() => nativeProfileRules(profile, { ...raw, allowUnsandboxed: true }))).toBe(
        "AGENT_SESSION_INVALID_OPTIONS",
      );
    }
  });

  test("full accepts bashApproval and allowUnsandboxed", () => {
    expect(nativeProfileRules("full", { ...raw, bashApproval: "raw" })).toEqual({
      bashApproval: "raw",
      allowUnsandboxed: false,
    });
    expect(nativeProfileRules("full", { ...raw, allowUnsandboxed: true })).toEqual({
      bashApproval: "gated",
      allowUnsandboxed: true,
    });
  });

  test("allowUnsandboxed requires gated", () => {
    expect(code(() => nativeProfileRules("full", { ...raw, bashApproval: "raw", allowUnsandboxed: true }))).toBe(
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  });
});
