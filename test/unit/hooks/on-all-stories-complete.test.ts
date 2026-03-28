/**
 * Tests for the on-all-stories-complete lifecycle hook (RL-001)
 *
 * RED phase: these tests must FAIL until the feature is implemented.
 *
 * Acceptance criteria:
 * - on-all-stories-complete is a registered HookEvent
 * - Hook receives NAX_EVENT, NAX_FEATURE, NAX_STATUS, and cost via env/stdin
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fireHook } from "../../../src/hooks/runner";
import { HOOK_EVENTS } from "../../../src/hooks/types";
import type { HooksConfig } from "../../../src/hooks/types";
import { makeTempDir } from "../../helpers/temp";

describe("HookEvent: on-all-stories-complete type registration", () => {
  test("on-all-stories-complete is in the HOOK_EVENTS registry", () => {
    // FAILS until "on-all-stories-complete" is added to HOOK_EVENTS in types.ts
    // @ts-ignore - "on-all-stories-complete" intentionally not yet in HookEvent
    expect(HOOK_EVENTS).toContain("on-all-stories-complete");
  });

  test("HOOK_EVENTS contains expected base events plus on-all-stories-complete", () => {
    const events = [...HOOK_EVENTS];
    expect(events).toContain("on-start");
    expect(events).toContain("on-story-complete");
    expect(events).toContain("on-complete");
    // FAILS until "on-all-stories-complete" is added
    // @ts-ignore - "on-all-stories-complete" intentionally not yet in HookEvent
    expect(events).toContain("on-all-stories-complete");
  });
});

describe("on-all-stories-complete hook payload (env vars + stdin)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-hook-asc-test-");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test("hook subprocess receives NAX_EVENT=on-all-stories-complete", async () => {
    const outputFile = join(tmpDir, "event.txt");
    const scriptFile = join(tmpDir, "capture-event.ts");

    await Bun.write(scriptFile, `await Bun.write(${JSON.stringify(outputFile)}, process.env.NAX_EVENT ?? "");`);

    const config: HooksConfig = {
      hooks: {
        // @ts-expect-error on-all-stories-complete not yet in HookEvent
        "on-all-stories-complete": {
          command: `bun ${scriptFile}`,
          enabled: true,
          timeout: 10000,
        },
      },
    };

    await fireHook(
      config,
      // @ts-expect-error on-all-stories-complete not yet in HookEvent
      "on-all-stories-complete",
      {
        event: "on-start", // placeholder; fireHook overrides with the passed event
        feature: "my-feature",
        status: "passed",
        cost: 1.5,
      },
      tmpDir,
    );

    // FAILS until on-all-stories-complete is in HookEvent and fireHook sets NAX_EVENT correctly
    const capturedEvent = await Bun.file(outputFile).text();
    expect(capturedEvent.trim()).toBe("on-all-stories-complete");
  });

  test("hook subprocess receives NAX_FEATURE with the feature name", async () => {
    const outputFile = join(tmpDir, "feature.txt");
    const scriptFile = join(tmpDir, "capture-feature.ts");

    await Bun.write(scriptFile, `await Bun.write(${JSON.stringify(outputFile)}, process.env.NAX_FEATURE ?? "");`);

    const config: HooksConfig = {
      hooks: {
        // @ts-expect-error on-all-stories-complete not yet in HookEvent
        "on-all-stories-complete": {
          command: `bun ${scriptFile}`,
          enabled: true,
          timeout: 10000,
        },
      },
    };

    await fireHook(
      config,
      // @ts-expect-error on-all-stories-complete not yet in HookEvent
      "on-all-stories-complete",
      {
        event: "on-start",
        feature: "my-cool-feature",
        status: "passed",
        cost: 0.75,
      },
      tmpDir,
    );

    const capturedFeature = await Bun.file(outputFile).text();
    expect(capturedFeature.trim()).toBe("my-cool-feature");
  });

  test("hook subprocess receives NAX_STATUS=passed", async () => {
    const outputFile = join(tmpDir, "status.txt");
    const scriptFile = join(tmpDir, "capture-status.ts");

    await Bun.write(scriptFile, `await Bun.write(${JSON.stringify(outputFile)}, process.env.NAX_STATUS ?? "");`);

    const config: HooksConfig = {
      hooks: {
        // @ts-expect-error on-all-stories-complete not yet in HookEvent
        "on-all-stories-complete": {
          command: `bun ${scriptFile}`,
          enabled: true,
          timeout: 10000,
        },
      },
    };

    await fireHook(
      config,
      // @ts-expect-error on-all-stories-complete not yet in HookEvent
      "on-all-stories-complete",
      {
        event: "on-start",
        feature: "my-feature",
        status: "passed",
        cost: 3.14,
      },
      tmpDir,
    );

    // FAILS until on-all-stories-complete is in HookEvent (hook not fired)
    const capturedStatus = await Bun.file(outputFile).text();
    expect(capturedStatus.trim()).toBe("passed");
  });

  test("hook subprocess receives NAX_COST formatted to 4 decimal places", async () => {
    const outputFile = join(tmpDir, "cost.txt");
    const scriptFile = join(tmpDir, "capture-cost.ts");

    await Bun.write(scriptFile, `await Bun.write(${JSON.stringify(outputFile)}, process.env.NAX_COST ?? "");`);

    const config: HooksConfig = {
      hooks: {
        // @ts-expect-error on-all-stories-complete not yet in HookEvent
        "on-all-stories-complete": {
          command: `bun ${scriptFile}`,
          enabled: true,
          timeout: 10000,
        },
      },
    };

    await fireHook(
      config,
      // @ts-expect-error on-all-stories-complete not yet in HookEvent
      "on-all-stories-complete",
      {
        event: "on-start",
        feature: "my-feature",
        status: "passed",
        cost: 2.5,
      },
      tmpDir,
    );

    // FAILS until on-all-stories-complete is in HookEvent (hook not fired)
    const capturedCost = await Bun.file(outputFile).text();
    expect(capturedCost.trim()).toBe("2.5000");
  });

  test("hook subprocess receives full context as JSON via stdin", async () => {
    const outputFile = join(tmpDir, "stdin.json");
    const scriptFile = join(tmpDir, "capture-stdin.ts");

    await Bun.write(
      scriptFile,
      `const chunks: Uint8Array[] = [];
for await (const chunk of Bun.stdin.stream()) {
  chunks.push(chunk);
}
const raw = Buffer.concat(chunks).toString();
await Bun.write(${JSON.stringify(outputFile)}, raw);`,
    );

    const config: HooksConfig = {
      hooks: {
        // @ts-expect-error on-all-stories-complete not yet in HookEvent
        "on-all-stories-complete": {
          command: `bun ${scriptFile}`,
          enabled: true,
          timeout: 10000,
        },
      },
    };

    await fireHook(
      config,
      // @ts-expect-error on-all-stories-complete not yet in HookEvent
      "on-all-stories-complete",
      {
        event: "on-start",
        feature: "my-feature",
        status: "passed",
        cost: 1.0,
      },
      tmpDir,
    );

    // FAILS until on-all-stories-complete is in HookEvent
    const raw = await Bun.file(outputFile).text();
    const ctx = JSON.parse(raw);
    expect(ctx.feature).toBe("my-feature");
    // The event in stdin context should reflect on-all-stories-complete
    expect(ctx.event).toBe("on-all-stories-complete");
  });
});
