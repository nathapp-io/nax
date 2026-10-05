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
});

describe("nativeProfileRules", () => {
  const raw = { model: "openai/x" };

  test("full defaults to gated and sandboxed", () => {
    expect(nativeProfileRules("full", raw)).toEqual({ bashApproval: "gated", allowUnsandboxed: false });
  });

  test("ask defaults to gated and sandboxed, like full", () => {
    expect(nativeProfileRules("ask", raw)).toEqual({ bashApproval: "gated", allowUnsandboxed: false });
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

  test("ask and full accept bashApproval and allowUnsandboxed", () => {
    expect(nativeProfileRules("ask", { ...raw, bashApproval: "raw" })).toEqual({
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
