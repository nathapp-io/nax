/**
 * nax#2571: the profile-to-ladder binding in `NaxConfigSchema.superRefine`
 * classifies a profile target exactly as dispatch does. A shorthand name is a
 * pin (no rung needed); a suffixed tier name is that tier (rung required).
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { NaxConfigSchema } from "@/config/schemas";

describe("profile-to-ladder binding classifies targets like dispatch (nax#2571)", () => {
  const SHORTHAND_MODELS = {
    claude: { fast: "haiku", balanced: "sonnet[medium]", powerful: "sonnet[medium]" },
    opencode: { fast: "oc-fast", balanced: "oc-balanced" },
  };
  const withProfile = (target: { agent: string; model: string }) =>
    NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      models: SHORTHAND_MODELS,
      routing: {
        ...DEFAULT_CONFIG.routing,
        agents: { enabled: true, strategy: "off", profiles: [{ id: "p", target, strengths: ["impl"] }] },
      },
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        escalation: {
          ...DEFAULT_CONFIG.autoMode?.escalation,
          tierOrder: [{ tier: "balanced", agent: "opencode", attempts: 3 }],
        },
      },
    });

  test("a claude opus[medium] target is a pin and needs no rung", () => {
    expect(withProfile({ agent: "claude", model: "opus[medium]" }).success).toBe(true);
  });

  test("a claude opus target is a pin and needs no rung", () => {
    expect(withProfile({ agent: "claude", model: "opus" }).success).toBe(true);
  });

  test("a suffixed tier target still needs its rung", () => {
    const result = withProfile({ agent: "opencode", model: "fast[high]" });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.message.includes("no matching rung"));
    expect(issue?.message).toContain('"tier": "fast", "agent": "opencode"');
  });

  test("positive control: a suffixed tier target with its rung present loads", () => {
    expect(withProfile({ agent: "opencode", model: "balanced[high]" }).success).toBe(true);
  });
});
