/**
 * S4-0: nativeBackend's option validation (the native half carried out of
 * createAgentSession's options, spec 4.1, 7). zod checks the shape; the result
 * keeps the caller's own objects. Profile rules are the native backend's own.
 */
import { describe, expect, test } from "bun:test";
import type { NativeBackendOptions } from "#src/session/native-backend-options";
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

describe("parseNativeBackendOptions: allowedTools", () => {
  test("accepts a string array (including empty) and keeps the caller's object", () => {
    const input = { model: "openai/x", allowedTools: ["Read", "acme__*"] };
    expect(parseNativeBackendOptions(input).raw).toBe<unknown>(input);
    expect(parseNativeBackendOptions({ model: "openai/x", allowedTools: [] }).provider).toBe("openai");
  });

  test("rejects an empty entry, a non-string entry and a non-array, naming backend.allowedTools", () => {
    for (const allowedTools of [[""], [1], "Read", null]) {
      let caught: unknown;
      try {
        parseNativeBackendOptions({ model: "openai/x", allowedTools });
      } catch (err) {
        caught = err;
      }
      assertNaxError(caught);
      expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
      expect(caught.message).toContain("backend.allowedTools");
    }
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
    expect(nativeProfileRules("full", raw)).toEqual({
      bashApproval: "gated",
      allowUnsandboxed: false,
      allowUnsandboxedCommands: false,
    });
  });

  test("ask forces gated: raw and escalate are refused, the default is gated", () => {
    expect(nativeProfileRules("ask", { model: "openai/x" })).toEqual({
      bashApproval: "gated",
      allowUnsandboxed: false,
      allowUnsandboxedCommands: false,
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
    expect(nativeProfileRules("read", raw)).toEqual({
      bashApproval: "gated",
      allowUnsandboxed: false,
      allowUnsandboxedCommands: false,
    });
    expect(nativeProfileRules("none", raw)).toEqual({
      bashApproval: "gated",
      allowUnsandboxed: false,
      allowUnsandboxedCommands: false,
    });
  });

  test("bashApproval, allowUnsandboxed and allowUnsandboxedCommands are refused for none and read", () => {
    for (const profile of ["none", "read"] as const) {
      expect(code(() => nativeProfileRules(profile, { ...raw, bashApproval: "gated" }))).toBe(
        "AGENT_SESSION_INVALID_OPTIONS",
      );
      expect(code(() => nativeProfileRules(profile, { ...raw, allowUnsandboxed: true }))).toBe(
        "AGENT_SESSION_INVALID_OPTIONS",
      );
      // AC-7: set to either value, the field itself is what a tool-less profile refuses.
      for (const allowUnsandboxedCommands of [true, false]) {
        const err = rulesFailure(profile, { ...raw, allowUnsandboxedCommands });
        expect(err.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
        expect(err.message).toContain('allowUnsandboxedCommands applies to profiles "ask", "full" and "review" only');
        expect(err.context).toMatchObject({ path: "backend.allowUnsandboxedCommands" });
      }
    }
  });

  test("full accepts bashApproval and allowUnsandboxed", () => {
    expect(nativeProfileRules("full", { ...raw, bashApproval: "raw" })).toEqual({
      bashApproval: "raw",
      allowUnsandboxed: false,
      allowUnsandboxedCommands: false,
    });
    expect(nativeProfileRules("full", { ...raw, allowUnsandboxed: true })).toEqual({
      bashApproval: "gated",
      allowUnsandboxed: true,
      allowUnsandboxedCommands: false,
    });
  });

  test('allowUnsandboxed is refused only under "escalate"', () => {
    const err = rulesFailure("full", { ...raw, bashApproval: "escalate", allowUnsandboxed: true });
    expect(err.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(err.message).toContain('allowUnsandboxed requires bashApproval "gated" or "raw"');
    expect(err.context).toMatchObject({ path: "backend.allowUnsandboxed" });
  });
});

test("review accepts bashApproval and allowUnsandboxed like full (nax#2500)", () => {
  expect(nativeProfileRules("review", { model: "openai/x", bashApproval: "gated", allowUnsandboxed: true })).toEqual({
    bashApproval: "gated",
    allowUnsandboxed: true,
    allowUnsandboxedCommands: false,
  });
  // AC-2: review is full's peer for the raw-plus-fallback pairing.
  expect(
    nativeProfileRules("review", { model: "openai/x", bashApproval: "raw", allowUnsandboxed: true }).allowUnsandboxed,
  ).toBe(true);
});

/** The error `nativeProfileRules` throws, asserted to be an AgentSessionError. */
function rulesFailure(
  profile: "none" | "read" | "ask" | "full" | "review",
  raw: NativeBackendOptions,
): { readonly code: string; readonly message: string; readonly context: unknown } {
  try {
    nativeProfileRules(profile, raw);
  } catch (err) {
    assertNaxError(err);
    return { code: err.code, message: err.message, context: err.context };
  }
  throw new Error(`nativeProfileRules("${profile}", ${JSON.stringify(raw)}) did not throw`);
}

describe("nativeProfileRules: raw with the unsandboxed fallback", () => {
  // AC-1: the interactive host's "full" mode is raw + allowUnsandboxed, and it must be legal.
  test('full with bashApproval "raw" and allowUnsandboxed accepts both knobs', () => {
    expect(nativeProfileRules("full", { model: "openai/x", bashApproval: "raw", allowUnsandboxed: true })).toEqual({
      bashApproval: "raw",
      allowUnsandboxed: true,
      allowUnsandboxedCommands: false,
    });
  });

  // AC-3: escalate never asks, so there is nothing that could fall back to a human.
  test("escalate with allowUnsandboxed is refused and names both legal modes", () => {
    const err = rulesFailure("full", { model: "openai/x", bashApproval: "escalate", allowUnsandboxed: true });
    expect(err.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(err.message).toContain('allowUnsandboxed requires bashApproval "gated" or "raw"');
  });

  // AC-4: the ask profile's gate comes first, so its own message is what the caller sees.
  test("ask refuses raw before the allowUnsandboxed check runs", () => {
    const err = rulesFailure("ask", { model: "openai/x", bashApproval: "raw", allowUnsandboxed: true });
    expect(err.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(err.message).toContain('profile "ask" requires bashApproval "gated"');
  });
});

describe("nativeProfileRules: allowUnsandboxedCommands", () => {
  // AC-5
  test("full resolves the field from the caller's options", () => {
    expect(nativeProfileRules("full", { model: "openai/x", allowUnsandboxedCommands: true })).toEqual({
      bashApproval: "gated",
      allowUnsandboxed: false,
      allowUnsandboxedCommands: true,
    });
  });

  // AC-6
  test("read refuses it with the profiles that do have tools", () => {
    const err = rulesFailure("read", { model: "openai/x", allowUnsandboxedCommands: true });
    expect(err.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(err.message).toContain('allowUnsandboxedCommands applies to profiles "ask", "full" and "review" only');
    expect(err.context).toMatchObject({ path: "backend.allowUnsandboxedCommands" });
  });

  // AC-8
  test("a non-boolean value is an INVALID_OPTIONS naming backend.allowUnsandboxedCommands", () => {
    let caught: unknown;
    try {
      parseNativeBackendOptions({ model: "p/m", allowUnsandboxedCommands: "yes" });
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(caught.context).toMatchObject({ path: "backend.allowUnsandboxedCommands" });
    expect(caught.message).toContain("backend.allowUnsandboxedCommands");
  });
});

describe("parseNativeBackendOptions: posture", () => {
  test.each(["askRules", "denyRules"] as const)("AC-7/8/20: rejects malformed %s with its backend path", (option) => {
    for (const value of [[""], [1], ["Write", null], "Write", null, {}, 1, true]) {
      let caught: unknown;
      try {
        parseNativeBackendOptions({ model: "openai/x", [option]: value });
      } catch (err) {
        caught = err;
      }
      assertNaxError(caught);
      expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
      expect(caught.message).toContain(`backend.${option}`);
    }
  });

  test("accepts rule lists and partial sandbox, preserving raw identity", () => {
    const raw = { model: "openai/x", askRules: ["Write(notes/**)"], denyRules: [], sandbox: { enabled: false } };
    expect(parseNativeBackendOptions(raw).raw).toBe(raw);
  });

  test("AC-18/22: invalid sandbox reports a backend.sandbox path", () => {
    for (const sandbox of [{ enabled: "yes" }, { network: { allowedDomains: [1] } }, null, "off"]) {
      let caught: unknown;
      try {
        parseNativeBackendOptions({ model: "openai/x", sandbox });
      } catch (err) {
        caught = err;
      }
      assertNaxError(caught);
      expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
      expect(caught.message).toContain("backend.sandbox");
      expect(caught.context).toMatchObject({ path: expect.stringMatching(/^backend\.sandbox/) });
    }
  });
});

describe("parseNativeBackendOptions ask overlays and shadow", () => {
  test.each(
    [
      null,
      1,
      [],
      {},
      { observe() {}, settle() {} },
      { observe: true, settle() {}, drain() {} },
      { observe() {}, settle: 1, drain() {} },
      { observe() {}, settle() {}, drain: false },
    ].map((commandShadow) => ({ commandShadow })),
  )("AC-22/24: rejects malformed shadow %j with exact path", ({ commandShadow }) => {
    let caught: unknown;
    try {
      parseNativeBackendOptions({ model: "openai/x", hostPorts: { commandShadow } });
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(caught.message).toContain("backend.hostPorts.commandShadow");
  });
  test("accepts booleans and preserves shadow identity", () => {
    const commandShadow = { observe() {}, settle() {}, async drain() {} };
    const input = {
      model: "openai/x",
      askOnUnsandboxed: true,
      askWhenSandboxDown: true,
      askDiscoveredTools: true,
      hostPorts: { commandShadow },
    };
    expect(parseNativeBackendOptions(input).raw).toBe(input);
  });
  test.each(["askOnUnsandboxed", "askWhenSandboxDown", "askDiscoveredTools"])("rejects nonboolean %s", (name) => {
    expect(code(() => parseNativeBackendOptions({ model: "openai/x", [name]: "yes" }))).toBe(
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  });
});
