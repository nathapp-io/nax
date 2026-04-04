/**
 * Tests for session-helpers.ts module exports — US-000
 *
 * Covers:
 * - AC1: No file in src/debate/ exceeds 400 lines
 * - AC5: _debateSessionDeps exported from session-helpers.ts and re-exported through barrel
 * - AC6: resolveDebaterModel() exported from session-helpers.ts and re-exported through barrel
 * - AC7: DebateSessionOptions type exported from session-helpers.ts and re-exported through barrel
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readdirSync } from "node:fs";

// RED: These imports fail until session-helpers.ts is created
import { _debateSessionDeps, resolveDebaterModel } from "../../../src/debate/session-helpers";
import type { DebateSessionOptions } from "../../../src/debate/session-helpers";

// Barrel re-export checks (resolveDebaterModel is also not yet in barrel — both are RED)
import {
  _debateSessionDeps as barrelDeps,
  resolveDebaterModel as barrelResolveDebaterModel,
} from "../../../src/debate";
import type { DebateSessionOptions as BarrelDebateSessionOptions } from "../../../src/debate";

// ─── AC1: File size constraint ────────────────────────────────────────────────

describe("src/debate/ file size constraint (AC1)", () => {
  test("no TypeScript source file in src/debate/ exceeds 400 lines", async () => {
    const debateDir = join(process.cwd(), "src", "debate");
    const tsFiles = readdirSync(debateDir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
    );

    for (const filename of tsFiles) {
      const content = await Bun.file(join(debateDir, filename)).text();
      const lineCount = content.split("\n").length;
      expect(
        lineCount,
        `${filename} has ${lineCount} lines — must be ≤ 400`,
      ).toBeLessThanOrEqual(400);
    }
  });

  test("session-helpers.ts exists as a separate file in src/debate/", async () => {
    const helpersPath = join(process.cwd(), "src", "debate", "session-helpers.ts");
    const file = Bun.file(helpersPath);
    expect(await file.exists()).toBe(true);
  });

  test("session-one-shot.ts exists as a separate file in src/debate/", async () => {
    const oneShotPath = join(process.cwd(), "src", "debate", "session-one-shot.ts");
    const file = Bun.file(oneShotPath);
    expect(await file.exists()).toBe(true);
  });

  test("session-stateful.ts exists as a separate file in src/debate/", async () => {
    const statefulPath = join(process.cwd(), "src", "debate", "session-stateful.ts");
    const file = Bun.file(statefulPath);
    expect(await file.exists()).toBe(true);
  });

  test("session-plan.ts exists as a separate file in src/debate/", async () => {
    const planPath = join(process.cwd(), "src", "debate", "session-plan.ts");
    const file = Bun.file(planPath);
    expect(await file.exists()).toBe(true);
  });
});

// ─── AC5: _debateSessionDeps exported from session-helpers.ts ─────────────────

describe("_debateSessionDeps export from session-helpers.ts (AC5)", () => {
  test("_debateSessionDeps is defined and is an object", () => {
    expect(_debateSessionDeps).toBeDefined();
    expect(typeof _debateSessionDeps).toBe("object");
  });

  test("_debateSessionDeps.getAgent is a function", () => {
    expect(typeof _debateSessionDeps.getAgent).toBe("function");
  });

  test("_debateSessionDeps.getSafeLogger is a function", () => {
    expect(typeof _debateSessionDeps.getSafeLogger).toBe("function");
  });

  test("_debateSessionDeps.readFile is a function", () => {
    expect(typeof _debateSessionDeps.readFile).toBe("function");
  });

  test("_debateSessionDeps is re-exported through the debate barrel index.ts", () => {
    expect(barrelDeps).toBeDefined();
    expect(typeof barrelDeps).toBe("object");
    expect(typeof barrelDeps.getAgent).toBe("function");
  });
});

// ─── AC6: resolveDebaterModel() exported from session-helpers.ts ──────────────

describe("resolveDebaterModel() export from session-helpers.ts (AC6)", () => {
  test("resolveDebaterModel is exported from session-helpers.ts as a function", () => {
    expect(typeof resolveDebaterModel).toBe("function");
  });

  test("resolveDebaterModel returns raw model string when no config provided", () => {
    const result = resolveDebaterModel({ agent: "claude", model: "claude-3-5-haiku" });
    expect(result).toBe("claude-3-5-haiku");
  });

  test("resolveDebaterModel returns undefined when model absent and no config", () => {
    const result = resolveDebaterModel({ agent: "claude" }, undefined);
    expect(result).toBeUndefined();
  });

  test("resolveDebaterModel is re-exported through the debate barrel index.ts", () => {
    expect(typeof barrelResolveDebaterModel).toBe("function");
  });
});

// ─── AC7: DebateSessionOptions type exported from session-helpers.ts ──────────

describe("DebateSessionOptions type export from session-helpers.ts (AC7)", () => {
  test("DebateSessionOptions from session-helpers.ts satisfies expected interface shape", () => {
    // Runtime construction check — if DebateSessionOptions is not exported from session-helpers.ts,
    // tsc (bun run typecheck) will fail at compile time.
    const opts: DebateSessionOptions = {
      storyId: "US-000",
      stage: "review",
      stageConfig: {
        enabled: true,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
        debaters: [{ agent: "claude" }],
        timeoutSeconds: 60,
      },
    };
    expect(opts.storyId).toBe("US-000");
    expect(opts.stage).toBe("review");
    expect(opts.stageConfig.rounds).toBe(1);
  });

  test("DebateSessionOptions supports optional workdir, featureName, config, timeoutSeconds", () => {
    const opts: DebateSessionOptions = {
      storyId: "US-000",
      stage: "plan",
      stageConfig: {
        enabled: true,
        resolver: { type: "synthesis" },
        sessionMode: "stateful",
        rounds: 2,
        debaters: [{ agent: "claude" }, { agent: "gemini" }],
        timeoutSeconds: 120,
      },
      workdir: "/tmp/workspace",
      featureName: "my-feature",
      timeoutSeconds: 300,
    };
    expect(opts.workdir).toBe("/tmp/workspace");
    expect(opts.timeoutSeconds).toBe(300);
  });

  test("DebateSessionOptions is accessible through the debate barrel index.ts", () => {
    // TypeScript will error at compile time if barrel does not export DebateSessionOptions.
    const opts: BarrelDebateSessionOptions = {
      storyId: "US-000",
      stage: "review",
      stageConfig: {
        enabled: true,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
        debaters: [{ agent: "claude" }],
        timeoutSeconds: 60,
      },
    };
    expect(opts.storyId).toBe("US-000");
  });
});
