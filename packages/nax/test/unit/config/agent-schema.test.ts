import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";

describe("AgentConfigSchema", () => {
  test("native instruction filename defaults to AGENTS.md", () => {
    expect(NaxConfigSchema.parse({}).agent?.native?.instructionFileName).toBe("AGENTS.md");
    expect(NaxConfigSchema.parse({ agent: { native: {} } }).agent?.native?.instructionFileName).toBe("AGENTS.md");
  });

  test("accepts a custom native instruction filename", () => {
    expect(
      NaxConfigSchema.parse({ agent: { native: { instructionFileName: "TEAM.md" } } }).agent?.native
        ?.instructionFileName,
    ).toBe("TEAM.md");
  });

  test.each([
    "",
    " ",
    "../TEAM.md",
    "docs/TEAM.md",
    "docs\\TEAM.md",
    "/TEAM.md",
    ".private.md",
    "TEAM.txt",
    "C:TEAM.md",
    "TEAM\u0000.md",
  ])("rejects invalid instruction filename %s", (instructionFileName) => {
    expect(() => NaxConfigSchema.parse({ agent: { native: { instructionFileName } } })).toThrow();
  });

  test("default values", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent).toBeDefined();
    expect(result.agent?.protocol).toBe("hybrid");
    expect(result.agent?.default).toBe("native");
    expect(result.agent?.maxInteractionTurns).toBe(20);
    expect(result.agent?.fallback.enabled).toBe(false);
    expect(result.agent?.fallback.map).toEqual({});
    expect(result.agent?.fallback.maxHopsPerStory).toBe(2);
    expect(result.agent?.fallback.onQualityFailure).toBe(false);
    expect(result.agent?.fallback.rebuildContext).toBe(true);
    expect(result.agent?.idleWatchdog?.enabled).toBe(true);
    expect(result.agent?.idleWatchdog?.mode).toBe("warn-then-cancel");
  });

  // #2045: the per-round-trip usage record is the usage analogue of
  // promptAudit — opt-in, off by default, same dir contract.
  test("agent.usageAudit defaults to disabled with no dir", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent?.usageAudit?.enabled).toBe(false);
    expect(result.agent?.usageAudit?.dir).toBeUndefined();
  });

  test("agent.usageAudit enabled resolves to false when supplied as an empty object", () => {
    const result = NaxConfigSchema.parse({ agent: { usageAudit: {} } });
    expect(result.agent?.usageAudit?.enabled).toBe(false);
  });

  test("agent.usageAudit accepts enabled and an absolute dir", () => {
    const result = NaxConfigSchema.parse({
      agent: { usageAudit: { enabled: true, dir: "/tmp/usage-audit" } },
    });
    expect(result.agent?.usageAudit?.enabled).toBe(true);
    expect(result.agent?.usageAudit?.dir).toBe("/tmp/usage-audit");
  });

  test("agent.usageAudit accepts a workdir-relative dir", () => {
    const result = NaxConfigSchema.parse({
      agent: { usageAudit: { enabled: true, dir: ".nax/usage" } },
    });
    expect(result.agent?.usageAudit?.dir).toBe(".nax/usage");
  });

  // #2453: native transcript archive, opt-in like usageAudit.
  test("agent.transcriptAudit defaults to disabled, no dir, 200 retained", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent?.transcriptAudit?.enabled).toBe(false);
    expect(result.agent?.transcriptAudit?.dir).toBeUndefined();
    expect(result.agent?.transcriptAudit?.maxRetained).toBe(200);
  });

  test("agent.transcriptAudit fills defaults when supplied as an empty object and rejects maxRetained < 1", () => {
    const result = NaxConfigSchema.parse({ agent: { transcriptAudit: {} } });
    expect(result.agent?.transcriptAudit).toEqual({ enabled: false, maxRetained: 200 });
    expect(() => NaxConfigSchema.parse({ agent: { transcriptAudit: { maxRetained: 0 } } })).toThrow();
  });

  // AC 10: a relative archive dir would resolve against the process cwd.
  test("agent.transcriptAudit rejects a relative dir", () => {
    const result = NaxConfigSchema.safeParse({
      agent: { transcriptAudit: { enabled: true, dir: ".nax/transcript-audit" } },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("agent.transcriptAudit.dir must be an absolute path");
  });

  test("agent.transcriptAudit accepts an absolute dir", () => {
    const result = NaxConfigSchema.safeParse({
      agent: { transcriptAudit: { enabled: true, dir: "/tmp/transcript-audit" } },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.agent?.transcriptAudit?.dir).toBe("/tmp/transcript-audit");
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

  test("agent.acp.promptRetries defaults to 0; agent.spinBreaker applies all six documented defaults from an empty config", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent?.acp?.promptRetries).toBe(0);
    expect(result.agent?.spinBreaker).toEqual({
      enabled: true,
      nudgeAfterRepeats: 25,
      maxNudges: 3,
      stopAfterRepeats: 50,
      recentKeyWindow: 64,
      stopAfterSameKeyRepeats: 12,
    });
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

  test("US-006 AC-21: agent.acp includes the full shellSandbox default block", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent?.acp).toEqual({
      promptRetries: 0,
      trackedSpawnDeadlineMs: 10_000,
      trackedSpawnStartupDeadlineMs: 30_000,
      codex: { isolateHome: false, fullMode: "workspace-write" },
      opencode: { isolateConfig: false },
      gemini: { isolateHome: false },
      shellSandbox: {
        mode: "auto",
        pi: { extensions: "user" },
        opencode: { projectConfig: "disable" },
        cursor: { onUnwrapped: "rules" },
      },
    });
  });

  // US-002 (gemini-acp-read-only): agent.acp.gemini decides whether a gemini
  // session gets its own home, sharing only the operator's credentials.
  test("AC-1: agent.acp.gemini defaults to { isolateHome: false } when agent.acp is unset", () => {
    expect(NaxConfigSchema.parse({}).agent?.acp?.gemini).toEqual({ isolateHome: false });
    expect(NaxConfigSchema.parse({ agent: { acp: {} } }).agent?.acp?.gemini).toEqual({ isolateHome: false });
  });

  test("AC-2: codex and opencode keep their existing defaults when agent.acp is unset", () => {
    const acp = NaxConfigSchema.parse({}).agent?.acp;
    expect(acp?.codex).toEqual({ isolateHome: false, fullMode: "workspace-write" });
    expect(acp?.opencode).toEqual({ isolateConfig: false });
  });

  test("AC-2: setting agent.acp.gemini leaves codex and opencode untouched", () => {
    const acp = NaxConfigSchema.parse({ agent: { acp: { gemini: { isolateHome: true } } } }).agent?.acp;
    expect(acp?.codex).toEqual({ isolateHome: false, fullMode: "workspace-write" });
    expect(acp?.opencode).toEqual({ isolateConfig: false });
  });

  test("AC-3: a non-boolean gemini.isolateHome fails validation with an issue path ending in isolateHome", () => {
    const result = NaxConfigSchema.safeParse({ agent: { acp: { gemini: { isolateHome: "yes" } } } });
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
    expect(paths.some((path) => path.endsWith("isolateHome"))).toBe(true);
  });

  test("AC-3: gemini.isolateHome round-trips when true", () => {
    expect(NaxConfigSchema.parse({ agent: { acp: { gemini: { isolateHome: true } } } }).agent?.acp?.gemini).toEqual({
      isolateHome: true,
    });
  });

  // US-002 (opencode-acp-read-only): agent.acp.opencode decides whether an
  // opencode session gets its own, empty config dir.
  test("AC-1: agent.acp.opencode defaults to { isolateConfig: false } when agent.acp is unset", () => {
    expect(NaxConfigSchema.parse({}).agent?.acp?.opencode).toEqual({ isolateConfig: false });
    expect(NaxConfigSchema.parse({ agent: { acp: {} } }).agent?.acp?.opencode).toEqual({ isolateConfig: false });
  });

  test("AC-2: agent.acp.codex is unaffected by the opencode key's arrival", () => {
    expect(NaxConfigSchema.parse({}).agent?.acp?.codex).toEqual({
      isolateHome: false,
      fullMode: "workspace-write",
    });
    expect(NaxConfigSchema.parse({ agent: { acp: { opencode: { isolateConfig: true } } } }).agent?.acp?.codex).toEqual({
      isolateHome: false,
      fullMode: "workspace-write",
    });
  });

  test("AC-3: a non-boolean isolateConfig fails validation with an issue path ending in isolateConfig", () => {
    const result = NaxConfigSchema.safeParse({ agent: { acp: { opencode: { isolateConfig: "yes" } } } });
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
    expect(paths.some((path) => path.endsWith("isolateConfig"))).toBe(true);
  });

  test("AC-3: opencode.isolateConfig round-trips when true", () => {
    expect(
      NaxConfigSchema.parse({ agent: { acp: { opencode: { isolateConfig: true } } } }).agent?.acp?.opencode,
    ).toEqual({ isolateConfig: true });
  });

  // US-002 (codex-acp-read-only): agent.acp.codex decides what codex's `full`
  // profile means and whether the session gets its own codex home.
  test("AC-1: agent.acp.codex defaults when agent.acp is unset", () => {
    expect(NaxConfigSchema.parse({}).agent?.acp?.codex).toEqual({
      isolateHome: false,
      fullMode: "workspace-write",
    });
    expect(NaxConfigSchema.parse({ agent: { acp: {} } }).agent?.acp?.codex).toEqual({
      isolateHome: false,
      fullMode: "workspace-write",
    });
  });

  test("AC-2: agent.acp.codex.fullMode accepts agent-full-access; isolateHome keeps its default", () => {
    const codex = NaxConfigSchema.parse({ agent: { acp: { codex: { fullMode: "agent-full-access" } } } }).agent?.acp
      ?.codex;
    expect(codex?.fullMode).toBe("agent-full-access");
    expect(codex?.isolateHome).toBe(false);
  });

  test("AC-3: an unknown fullMode fails validation with an issue path ending in fullMode", () => {
    const result = NaxConfigSchema.safeParse({ agent: { acp: { codex: { fullMode: "danger" } } } });
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
    expect(paths.some((path) => path.endsWith("fullMode"))).toBe(true);
  });

  test("AC-4: a non-boolean isolateHome fails validation with an issue path ending in isolateHome", () => {
    const result = NaxConfigSchema.safeParse({ agent: { acp: { codex: { isolateHome: "yes" } } } });
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
    expect(paths.some((path) => path.endsWith("isolateHome"))).toBe(true);
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

  // nax#2013: the .refine() is what stops a misconfigured breaker from ending
  // every turn with no warning ever reaching the model. It fails silently if
  // broken, so it needs its own regression coverage at the real config
  // boundary (NaxConfigSchema), not just a hand check against the sub-schema.
  test("agent.spinBreaker rejects stopAfterRepeats at or below nudgeAfterRepeats", () => {
    const result = NaxConfigSchema.safeParse({
      agent: { spinBreaker: { nudgeAfterRepeats: 40, stopAfterRepeats: 30 } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.includes("stopAfterRepeats"));
    expect(issue).toBeDefined();
    expect(issue?.message).toBe("agent.spinBreaker.stopAfterRepeats must be greater than nudgeAfterRepeats");
  });

  test("agent.spinBreaker accepts a valid nudge/stop pairing", () => {
    const result = NaxConfigSchema.safeParse({
      agent: { spinBreaker: { nudgeAfterRepeats: 25, stopAfterRepeats: 50 } },
    });
    expect(result.success).toBe(true);
  });
});

describe("AgentConfigSchema modelAliases", () => {
  test("defaults to an empty map when agent is absent", () => {
    expect(NaxConfigSchema.parse({}).agent?.modelAliases).toEqual({});
  });

  test("defaults to an empty map when agent is present without modelAliases", () => {
    expect(NaxConfigSchema.parse({ agent: { protocol: "native" } }).agent?.modelAliases).toEqual({});
  });

  test("accepts a provider/model alias value", () => {
    const modelAliases = { sonnet: "anthropic/claude-sonnet-5-5" };
    const result = NaxConfigSchema.safeParse({ agent: { modelAliases } });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agent?.modelAliases).toEqual(modelAliases);
  });

  test("accepts extra slashes in the model and an [effort] suffix", () => {
    const modelAliases = { glm: "openrouter/z-ai/glm-5.3-flash[high]" };
    const result = NaxConfigSchema.safeParse({ agent: { modelAliases } });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agent?.modelAliases).toEqual(modelAliases);
  });

  test("rejects a value with no provider and reports a modelAliases path", () => {
    const result = NaxConfigSchema.safeParse({ agent: { modelAliases: { sonnet: "claude-sonnet" } } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.includes("modelAliases"))).toBe(true);
  });

  test.each([
    ["empty model after the slash", "a/"],
    ["empty provider before the slash", "/m"],
    ["whitespace in the provider", "a b/c"],
    ["whitespace in the model", "a/b c"],
    ["a bare effort suffix with no provider", "claude-opus-5[high]"],
    ["an empty value", ""],
  ])("rejects %s", (_label, value) => {
    const result = NaxConfigSchema.safeParse({ agent: { modelAliases: { sonnet: value } } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.includes("modelAliases"))).toBe(true);
  });
});
