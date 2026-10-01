/**
 * Constitution Stage tests
 *
 * Covers: content loaded (short + truncated), missing/disabled soft-failure paths.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, makeTestContext } from "@test/helpers";
import { constitutionStage } from "@/pipeline/stages/constitution";

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir("nax-constitution-stage-test-");
});

afterEach(() => {
  cleanupTempDir(tmpDir);
});

describe("constitutionStage", () => {
  test("loads a short project constitution without truncation", async () => {
    await Bun.write(join(tmpDir, "nax", "constitution.md"), "# Rules\n\nAlways write tests.");

    const ctx = makeTestContext({
      workdir: tmpDir,
      config: {
        ...makeTestContext().config,
        constitution: { enabled: true, path: "constitution.md", maxTokens: 2000, skipGlobal: true },
      },
    });

    const result = await constitutionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.constitution).toBeDefined();
    expect(ctx.constitution?.truncated).toBe(false);
    expect(ctx.constitution?.content).toContain("Always write tests.");
  });

  test("truncates and logs a warning when the constitution exceeds maxTokens", async () => {
    const longContent = "word ".repeat(2000);
    await Bun.write(join(tmpDir, "nax", "constitution.md"), longContent);

    const ctx = makeTestContext({
      workdir: tmpDir,
      config: {
        ...makeTestContext().config,
        constitution: { enabled: true, path: "constitution.md", maxTokens: 5, skipGlobal: true },
      },
    });

    const result = await constitutionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.constitution).toBeDefined();
    expect(ctx.constitution?.truncated).toBe(true);
    expect(ctx.constitution?.originalTokens).toBeGreaterThan(5);
  });

  test("continues without a constitution when the file is missing", async () => {
    const ctx = makeTestContext({
      workdir: tmpDir,
      config: {
        ...makeTestContext().config,
        constitution: { enabled: true, path: "constitution.md", maxTokens: 2000, skipGlobal: true },
      },
    });

    const result = await constitutionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.constitution).toBeUndefined();
  });

  test("enabled() reflects config.constitution.enabled", () => {
    const enabledCtx = makeTestContext({
      config: {
        ...makeTestContext().config,
        constitution: { enabled: true, path: "constitution.md", maxTokens: 2000 },
      },
    });
    const disabledCtx = makeTestContext({
      config: {
        ...makeTestContext().config,
        constitution: { enabled: false, path: "constitution.md", maxTokens: 2000 },
      },
    });

    expect(constitutionStage.enabled?.(enabledCtx)).toBe(true);
    expect(constitutionStage.enabled?.(disabledCtx)).toBe(false);
  });

  test("derives the project dir from featureDir two levels up", async () => {
    await Bun.write(join(tmpDir, "constitution.md"), "# Root rules");
    const featureDir = join(tmpDir, "features", "my-feature");

    const ctx = makeTestContext({
      workdir: "/should-not-be-used",
      featureDir,
      config: {
        ...makeTestContext().config,
        constitution: { enabled: true, path: "constitution.md", maxTokens: 2000, skipGlobal: true },
      },
    });

    const result = await constitutionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.constitution?.content).toContain("Root rules");
  });
});
