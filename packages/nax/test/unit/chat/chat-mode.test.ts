import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { chatBackendPosture, chatSessionSettings } from "@/chat";
import { NaxError } from "@/errors";

describe("chatSessionSettings", () => {
  test.each([
    ["AC-1", "guarded", "raw", "ask"],
    ["AC-2", "guarded", "gated", "ask"],
    ["AC-3", "full", "gated", "full"],
  ] as const)("%s resolved %s posture %s", (_ac, mode, bashApproval, metaMode) => {
    expect(
      chatSessionSettings(mode, { bashApproval, askRules: mode === "full" ? ["Write"] : [], denyRules: [] }),
    ).toEqual({
      profile: "full",
      bashApproval: mode === "full" ? "raw" : bashApproval,
      metaMode,
    });
  });
  test("AC-4 guarded missing posture is a wiring error", () => {
    expect(() => chatSessionSettings("guarded", undefined)).toThrow(NaxError);
    expect(() => chatSessionSettings("guarded", undefined)).toThrow(
      expect.objectContaining({ code: "CHAT_POSTURE_REQUIRED" }),
    );
  });
});

describe("chatBackendPosture", () => {
  test("AC-5 full exports only the configured sandbox", () => {
    const config = makeNaxConfig();
    expect(chatBackendPosture("full", config, undefined)).toEqual({ sandbox: config.execution.sandbox });
    expect(chatSessionSettings("full", undefined)).toEqual({ profile: "full", bashApproval: "raw", metaMode: "full" });
  });
  test("AC-6 guarded forwards rules by identity and all ask overlays", () => {
    const config = makeNaxConfig();
    const posture = { bashApproval: "raw", askRules: ["Write"], denyRules: ["Delete(src/**)"] } as const;
    const options = chatBackendPosture("guarded", config, posture);
    expect(options).toEqual({
      sandbox: config.execution.sandbox,
      askRules: posture.askRules,
      denyRules: posture.denyRules,
      askOnUnsandboxed: true,
      askWhenSandboxDown: true,
      askDiscoveredTools: true,
    });
    expect(options.askRules).toBe(posture.askRules);
    expect(options.denyRules).toBe(posture.denyRules);
    expect(() => chatBackendPosture("guarded", config, undefined)).toThrow(NaxError);
  });
});

describe("nextChatMode", () => {
  test.each([
    ["AC-3", "guarded", "full"],
    ["AC-4", "full", "guarded"],
  ] as const)("%s: toggles %s to %s", async (_ac, mode, expected) => {
    const { nextChatMode } = await import("@/chat");
    expect(nextChatMode(mode)).toBe(expected);
  });
});

describe("chatModeOfMeta", () => {
  test.each([
    ["AC-5", "ask", "guarded"],
    ["AC-6", "full", "full"],
    ["AC-7", "read", null],
    ["AC-8", "none", null],
  ] as const)("%s: maps metadata mode %s to %s", async (_ac, mode, expected) => {
    const { chatModeOfMeta } = await import("@/chat");
    expect(chatModeOfMeta(mode)).toBe(expected);
  });
});
