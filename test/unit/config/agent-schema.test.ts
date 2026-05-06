import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "../../../src/config/schemas";

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
    expect(() =>
      NaxConfigSchema.parse({ agent: { fallback: { maxHopsPerStory: 0 } } }),
    ).toThrow();
    expect(() =>
      NaxConfigSchema.parse({ agent: { fallback: { maxHopsPerStory: 11 } } }),
    ).toThrow();
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

  test("agent.acp.idleWatchdog is optional by default", () => {
    const result = NaxConfigSchema.parse({});
    // idleWatchdog is optional, so it should be undefined when not provided
    expect(result.agent?.acp?.idleWatchdog).toBeUndefined();
  });

  test("agent.acp.idleWatchdog internal defaults when provided", () => {
    const result = NaxConfigSchema.parse({
      agent: {
        acp: {
          idleWatchdog: {},
        },
      },
    });
    // When provided as an empty object, defaults should be applied
    expect(result.agent?.acp?.idleWatchdog?.enabled).toBe(false);
    expect(result.agent?.acp?.idleWatchdog?.mode).toBe("off");
    expect(result.agent?.acp?.idleWatchdog?.idleTimeoutSeconds).toBe(30);
    expect(result.agent?.acp?.idleWatchdog?.cancelGraceSeconds).toBe(5);
    expect(result.agent?.acp?.idleWatchdog?.maxRetryAttempts).toBe(3);
    expect(result.agent?.acp?.idleWatchdog?.activityKinds).toEqual(["message_update", "thinking_update", "usage_update"]);
  });

  test("agent.acp.idleWatchdog accepts fully populated config", () => {
    const raw = {
      agent: {
        acp: {
          idleWatchdog: {
            enabled: true,
            mode: "warn-then-cancel",
            idleTimeoutSeconds: 60,
            cancelGraceSeconds: 10,
            maxRetryAttempts: 5,
            activityKinds: ["message_update"],
          },
        },
      },
    };
    const result = NaxConfigSchema.parse(raw);
    expect(result.agent?.acp?.idleWatchdog?.mode).toBe("warn-then-cancel");
    expect(result.agent?.acp?.idleWatchdog?.idleTimeoutSeconds).toBe(60);
    expect(result.agent?.acp?.idleWatchdog?.cancelGraceSeconds).toBe(10);
    expect(result.agent?.acp?.idleWatchdog?.maxRetryAttempts).toBe(5);
    expect(result.agent?.acp?.idleWatchdog?.activityKinds).toEqual(["message_update"]);
  });

  test("agent.acp.idleWatchdog rejects idleTimeoutSeconds <= 0 when mode is not 'off'", () => {
    expect(() =>
      NaxConfigSchema.parse({
        agent: {
          acp: {
            idleWatchdog: {
              enabled: true,
              mode: "cancel",
              idleTimeoutSeconds: 0,
            },
          },
        },
      }),
    ).toThrow();

    expect(() =>
      NaxConfigSchema.parse({
        agent: {
          acp: {
            idleWatchdog: {
              enabled: true,
              mode: "observe",
              idleTimeoutSeconds: -1,
            },
          },
        },
      }),
    ).toThrow();
  });

  test("agent.acp.idleWatchdog accepts idleTimeoutSeconds = 0 when mode is 'off'", () => {
    const result = NaxConfigSchema.parse({
      agent: {
        acp: {
          idleWatchdog: {
            mode: "off",
            idleTimeoutSeconds: 0,
          },
        },
      },
    });
    expect(result.agent?.acp?.idleWatchdog?.idleTimeoutSeconds).toBe(0);
    expect(result.agent?.acp?.idleWatchdog?.mode).toBe("off");
  });

  test("agent.acp.idleWatchdog accepts all valid modes", () => {
    const modes = ["off", "observe", "warn-then-cancel", "cancel"] as const;
    for (const mode of modes) {
      const result = NaxConfigSchema.parse({
        agent: {
          acp: {
            idleWatchdog: {
              mode,
              idleTimeoutSeconds: mode === "off" ? 0 : 30,
            },
          },
        },
      });
      expect(result.agent?.acp?.idleWatchdog?.mode).toBe(mode);
    }
  });

  test("agent.acp.idleWatchdog rejects negative cancelGraceSeconds", () => {
    expect(() =>
      NaxConfigSchema.parse({
        agent: {
          acp: {
            idleWatchdog: {
              enabled: true,
              mode: "warn-then-cancel",
              idleTimeoutSeconds: 30,
              cancelGraceSeconds: -1,
            },
          },
        },
      }),
    ).toThrow();
  });

  test("agent.acp.idleWatchdog accepts zero and positive cancelGraceSeconds", () => {
    for (const grace of [0, 1, 5, 10]) {
      const result = NaxConfigSchema.parse({
        agent: {
          acp: {
            idleWatchdog: {
              enabled: true,
              mode: "warn-then-cancel",
              idleTimeoutSeconds: 30,
              cancelGraceSeconds: grace,
            },
          },
        },
      });
      expect(result.agent?.acp?.idleWatchdog?.cancelGraceSeconds).toBe(grace);
    }
  });

  test("agent.acp.idleWatchdog rejects negative maxRetryAttempts", () => {
    expect(() =>
      NaxConfigSchema.parse({
        agent: {
          acp: {
            idleWatchdog: {
              enabled: true,
              mode: "cancel",
              idleTimeoutSeconds: 30,
              maxRetryAttempts: -1,
            },
          },
        },
      }),
    ).toThrow();
  });

  test("agent.acp.idleWatchdog accepts zero and positive maxRetryAttempts", () => {
    for (const retries of [0, 1, 3, 10]) {
      const result = NaxConfigSchema.parse({
        agent: {
          acp: {
            idleWatchdog: {
              enabled: true,
              mode: "cancel",
              idleTimeoutSeconds: 30,
              maxRetryAttempts: retries,
            },
          },
        },
      });
      expect(result.agent?.acp?.idleWatchdog?.maxRetryAttempts).toBe(retries);
    }
  });

  test("agent.acp.idleWatchdog accepts all valid activityKinds combinations", () => {
    const validCombinations: Array<Array<"message_update" | "thinking_update" | "usage_update">> = [
      [],
      ["message_update"],
      ["thinking_update"],
      ["usage_update"],
      ["message_update", "thinking_update"],
      ["message_update", "usage_update"],
      ["thinking_update", "usage_update"],
      ["message_update", "thinking_update", "usage_update"],
    ];

    for (const kinds of validCombinations) {
      const result = NaxConfigSchema.parse({
        agent: {
          acp: {
            idleWatchdog: {
              enabled: true,
              mode: "observe",
              idleTimeoutSeconds: 30,
              activityKinds: kinds,
            },
          },
        },
      });
      expect(result.agent?.acp?.idleWatchdog?.activityKinds).toEqual(kinds);
    }
  });
});
