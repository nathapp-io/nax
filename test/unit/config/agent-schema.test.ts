import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";

describe("AgentConfigSchema", () => {
  test("default values", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent).toBeDefined();
    expect(result.agent?.protocol).toBe("acp");
    expect(result.agent?.default).toBe("claude");
    expect(result.agent?.maxInteractionTurns).toBe(20);
    expect(result.agent?.fallback.enabled).toBe(false);
    expect(result.agent?.fallback.map).toEqual({});
    expect(result.agent?.fallback.maxHopsPerStory).toBe(2);
    expect(result.agent?.fallback.onQualityFailure).toBe(false);
    expect(result.agent?.fallback.rebuildContext).toBe(true);
    expect(result.agent?.idleWatchdog?.enabled).toBe(true);
    expect(result.agent?.idleWatchdog?.mode).toBe("warn-then-cancel");
  });

  test("accepts a fully populated agent block", () => {
    const raw = {
      agent: {
        protocol: "acp",
        default: "codex",
        maxInteractionTurns: 30,
        fallback: {
          enabled: true,
          map: { claude: ["codex"], codex: ["claude"] },
          maxHopsPerStory: 3,
          onQualityFailure: true,
          rebuildContext: false,
        },
      },
    };
    const result = NaxConfigSchema.parse(raw);
    expect(result.agent?.default).toBe("codex");
    expect(result.agent?.fallback.map).toEqual({ claude: ["codex"], codex: ["claude"] });
  });

  test("rejects empty default", () => {
    expect(() => NaxConfigSchema.parse({ agent: { default: "" } })).toThrow();
  });

  test("rejects maxHopsPerStory out of range", () => {
    expect(() => NaxConfigSchema.parse({ agent: { fallback: { maxHopsPerStory: 0 } } })).toThrow();
    expect(() => NaxConfigSchema.parse({ agent: { fallback: { maxHopsPerStory: 11 } } })).toThrow();
  });

  test("agent.acp.promptRetries defaults to 0", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent?.acp?.promptRetries).toBe(0);
  });

  test("agent.acp.promptRetries accepts values 0–5", () => {
    for (const n of [0, 1, 3, 5]) {
      const result = NaxConfigSchema.parse({ agent: { acp: { promptRetries: n } } });
      expect(result.agent?.acp?.promptRetries).toBe(n);
    }
  });

  test("agent.acp.promptRetries rejects values out of range", () => {
    expect(() => NaxConfigSchema.parse({ agent: { acp: { promptRetries: -1 } } })).toThrow();
    expect(() => NaxConfigSchema.parse({ agent: { acp: { promptRetries: 6 } } })).toThrow();
  });

  test("agent.idleWatchdog defaults to enabled", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent?.idleWatchdog?.enabled).toBe(true);
    expect(result.agent?.idleWatchdog?.mode).toBe("warn-then-cancel");
    expect(result.agent?.idleWatchdog?.idleTimeoutSeconds).toBe(900);
    expect(result.agent?.idleWatchdog?.toolCallOnlyIdleTimeoutSeconds).toBe(1800);
    expect(result.agent?.idleWatchdog?.cancelGraceSeconds).toBe(10);
    expect(result.agent?.idleWatchdog?.maxRetryAttempts).toBe(3);
    expect(result.agent?.idleWatchdog?.activityKinds).toEqual([
      "message_update",
      "thinking_update",
      "usage_update",
      "tool_call_update",
    ]);
  });

  test("agent.idleWatchdog internal defaults when provided", () => {
    const result = NaxConfigSchema.parse({
      agent: {
        idleWatchdog: {},
      },
    });
    // When provided as an empty object, FEAT-016 §7 spec defaults apply.
    expect(result.agent?.idleWatchdog?.enabled).toBe(true);
    expect(result.agent?.idleWatchdog?.mode).toBe("warn-then-cancel");
    expect(result.agent?.idleWatchdog?.idleTimeoutSeconds).toBe(900);
    expect(result.agent?.idleWatchdog?.toolCallOnlyIdleTimeoutSeconds).toBe(1800);
    expect(result.agent?.idleWatchdog?.cancelGraceSeconds).toBe(10);
    expect(result.agent?.idleWatchdog?.maxRetryAttempts).toBe(3);
    expect(result.agent?.idleWatchdog?.activityKinds).toEqual([
      "message_update",
      "thinking_update",
      "usage_update",
      "tool_call_update",
    ]);
  });

  test("agent.idleWatchdog accepts fully populated config", () => {
    const raw = {
      agent: {
        idleWatchdog: {
          enabled: true,
          mode: "warn-then-cancel",
          idleTimeoutSeconds: 60,
          toolCallOnlyIdleTimeoutSeconds: 120,
          cancelGraceSeconds: 10,
          maxRetryAttempts: 5,
          activityKinds: ["message_update"],
        },
      },
    };
    const result = NaxConfigSchema.parse(raw);
    expect(result.agent?.idleWatchdog?.mode).toBe("warn-then-cancel");
    expect(result.agent?.idleWatchdog?.idleTimeoutSeconds).toBe(60);
    expect(result.agent?.idleWatchdog?.toolCallOnlyIdleTimeoutSeconds).toBe(120);
    expect(result.agent?.idleWatchdog?.cancelGraceSeconds).toBe(10);
    expect(result.agent?.idleWatchdog?.maxRetryAttempts).toBe(5);
    expect(result.agent?.idleWatchdog?.activityKinds).toEqual(["message_update"]);
  });

  test("agent.idleWatchdog rejects idleTimeoutSeconds <= 0 when mode is not 'off'", () => {
    expect(() =>
      NaxConfigSchema.parse({
        agent: {
          idleWatchdog: {
            enabled: true,
            mode: "cancel",
            idleTimeoutSeconds: 0,
          },
        },
      }),
    ).toThrow();

    expect(() =>
      NaxConfigSchema.parse({
        agent: {
          idleWatchdog: {
            enabled: true,
            mode: "observe",
            idleTimeoutSeconds: -1,
          },
        },
      }),
    ).toThrow();
  });

  test("agent.idleWatchdog accepts idleTimeoutSeconds = 0 when mode is 'off'", () => {
    const result = NaxConfigSchema.parse({
      agent: {
        idleWatchdog: {
          mode: "off",
          idleTimeoutSeconds: 0,
        },
      },
    });
    expect(result.agent?.idleWatchdog?.idleTimeoutSeconds).toBe(0);
    expect(result.agent?.idleWatchdog?.mode).toBe("off");
  });

  test("agent.idleWatchdog accepts all valid modes", () => {
    const modes = ["off", "observe", "warn-then-cancel", "cancel"] as const;
    for (const mode of modes) {
      const result = NaxConfigSchema.parse({
        agent: {
          idleWatchdog: {
            mode,
            idleTimeoutSeconds: mode === "off" ? 0 : 30,
          },
        },
      });
      expect(result.agent?.idleWatchdog?.mode).toBe(mode);
    }
  });

  test("agent.idleWatchdog rejects negative cancelGraceSeconds", () => {
    expect(() =>
      NaxConfigSchema.parse({
        agent: {
          idleWatchdog: {
            enabled: true,
            mode: "warn-then-cancel",
            idleTimeoutSeconds: 30,
            cancelGraceSeconds: -1,
          },
        },
      }),
    ).toThrow();
  });

  test("agent.idleWatchdog accepts zero and positive cancelGraceSeconds", () => {
    for (const grace of [0, 1, 5, 10]) {
      const result = NaxConfigSchema.parse({
        agent: {
          idleWatchdog: {
            enabled: true,
            mode: "warn-then-cancel",
            idleTimeoutSeconds: 30,
            cancelGraceSeconds: grace,
          },
        },
      });
      expect(result.agent?.idleWatchdog?.cancelGraceSeconds).toBe(grace);
    }
  });

  test("agent.idleWatchdog rejects negative maxRetryAttempts", () => {
    expect(() =>
      NaxConfigSchema.parse({
        agent: {
          idleWatchdog: {
            enabled: true,
            mode: "cancel",
            idleTimeoutSeconds: 30,
            maxRetryAttempts: -1,
          },
        },
      }),
    ).toThrow();
  });

  test("agent.idleWatchdog accepts zero and positive maxRetryAttempts", () => {
    for (const retries of [0, 1, 3, 10]) {
      const result = NaxConfigSchema.parse({
        agent: {
          idleWatchdog: {
            enabled: true,
            mode: "cancel",
            idleTimeoutSeconds: 30,
            maxRetryAttempts: retries,
          },
        },
      });
      expect(result.agent?.idleWatchdog?.maxRetryAttempts).toBe(retries);
    }
  });

  test("agent.idleWatchdog accepts all valid activityKinds combinations", () => {
    const validCombinations: Array<Array<"message_update" | "thinking_update" | "usage_update" | "tool_call_update">> =
      [
        [],
        ["message_update"],
        ["thinking_update"],
        ["usage_update"],
        ["tool_call_update"],
        ["message_update", "thinking_update"],
        ["message_update", "usage_update"],
        ["thinking_update", "usage_update"],
        ["message_update", "tool_call_update"],
        ["thinking_update", "tool_call_update"],
        ["usage_update", "tool_call_update"],
        ["message_update", "thinking_update", "usage_update"],
        ["message_update", "thinking_update", "usage_update", "tool_call_update"],
      ];

    for (const kinds of validCombinations) {
      const result = NaxConfigSchema.parse({
        agent: {
          idleWatchdog: {
            enabled: true,
            mode: "observe",
            idleTimeoutSeconds: 30,
            activityKinds: kinds,
          },
        },
      });
      expect(result.agent?.idleWatchdog?.activityKinds).toEqual(kinds);
    }
  });

  // nax#1870: the native counterpart to acp.promptRetries — acpx's spawned
  // process absorbs a transient provider stall internally before nax ever
  // sees it; native has no such process, so the turn loop needs its own knob.
  test("agent.native.transportRetry defaults to 3 attempts and a 2000ms base delay", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent?.native?.transportRetry?.maxAttempts).toBe(3);
    expect(result.agent?.native?.transportRetry?.baseDelayMs).toBe(2000);
  });

  test("agent.native.transportRetry accepts a fully populated override", () => {
    const result = NaxConfigSchema.parse({
      agent: { native: { transportRetry: { maxAttempts: 5, baseDelayMs: 500 } } },
    });
    expect(result.agent?.native?.transportRetry?.maxAttempts).toBe(5);
    expect(result.agent?.native?.transportRetry?.baseDelayMs).toBe(500);
  });

  test("agent.native.transportRetry rejects maxAttempts below 1", () => {
    expect(() => NaxConfigSchema.parse({ agent: { native: { transportRetry: { maxAttempts: 0 } } } })).toThrow();
  });

  test("agent.native.transportRetry rejects a non-positive baseDelayMs", () => {
    expect(() => NaxConfigSchema.parse({ agent: { native: { transportRetry: { baseDelayMs: 0 } } } })).toThrow();
  });
});
