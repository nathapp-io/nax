/**
 * US-004 — `promptStage.execute` seeds the config-read hint from
 * `ctx.projectDir`.
 *
 * The stage builds its prompt against `ctx.workdir` (the package directory in
 * a monorepo), but the root where `.nax/` lives is `ctx.projectDir`. Both
 * builder chains in `execute` must chain `configRoot(ctx.projectDir)` so the
 * hint's scan reads the repo root, and so the scanner is invoked exactly once
 * per prompt build.
 *
 * Fixtures are real files under a temp root; no process or network I/O.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeNaxConfig, makeStory, makeTestContext, withTempDir } from "@test/helpers";
import type { ConfigSecretScan } from "@/config";
import { promptStage } from "@/pipeline/stages/prompt";
import type { PipelineContext } from "@/pipeline/types";
import { _tddPromptBuilderDeps } from "@/prompts/builders/tdd-builder";

const ROOT_CONFIG = ".nax/config.json";
/** Only the hint paragraph names this path; the baseline artifacts text never does. */
const MONO_HINT = ".nax/mono/<package>/config.json";

function writeConfig(root: string, rel: string, value: unknown): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(value));
}

function cleanScan(files: readonly string[]): ConfigSecretScan {
  return { clean: true, files, findings: [] };
}

/** A context whose repo root (`projectDir`) differs from its package dir (`workdir`). */
function makeMonorepoCtx(root: string): PipelineContext {
  const story = makeStory({ id: "US-004" });
  return makeTestContext({
    config: makeNaxConfig({}),
    rootConfig: makeNaxConfig({}),
    story,
    stories: [story],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "tdd-simple", reasoning: "" },
    projectDir: root,
    workdir: join(root, "packages", "app"),
  });
}

const originalScan = _tddPromptBuilderDeps.scanConfigSecrets;
afterEach(() => {
  _tddPromptBuilderDeps.scanConfigSecrets = originalScan;
});

describe("promptStage.execute — US-004 config-read hint", () => {
  // AC8
  test("AC8: sets ctx.prompt with the hint when projectDir holds a clean root config", async () => {
    await withTempDir(async (root) => {
      mkdirSync(join(root, "packages", "app"), { recursive: true });
      writeConfig(root, ROOT_CONFIG, {});
      const ctx = makeMonorepoCtx(root);
      await promptStage.execute(ctx);
      expect(ctx.prompt).toContain(MONO_HINT);
    });
  });

  // AC8 boundary — the hint's scan reads projectDir, not the package workdir.
  test("AC8 boundary: omits the hint when only the package workdir holds a config", async () => {
    await withTempDir(async (root) => {
      mkdirSync(join(root, "packages", "app"), { recursive: true });
      writeConfig(join(root, "packages", "app"), ROOT_CONFIG, {});
      const ctx = makeMonorepoCtx(root);
      await promptStage.execute(ctx);
      expect(ctx.prompt).not.toContain(MONO_HINT);
    });
  });

  // AC9
  test("AC9: scans once, with ctx.projectDir", async () => {
    await withTempDir(async (root) => {
      mkdirSync(join(root, "packages", "app"), { recursive: true });
      writeConfig(root, ROOT_CONFIG, {});
      const scannedDirs: string[] = [];
      _tddPromptBuilderDeps.scanConfigSecrets = async (dir: string) => {
        scannedDirs.push(dir);
        return cleanScan([ROOT_CONFIG]);
      };
      const ctx = makeMonorepoCtx(root);
      await promptStage.execute(ctx);
      expect(scannedDirs).toEqual([ctx.projectDir]);
    });
  });
});
