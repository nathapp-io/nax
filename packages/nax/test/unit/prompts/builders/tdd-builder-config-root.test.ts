/**
 * US-004 — `TddPromptBuilder.configRoot(root)`: the config-read hint.
 *
 * `configRoot(dir)` hands the builder the repo root where `.nax/` lives — not
 * the loader workdir, which is the *package* directory for a monorepo package
 * story. Only when that root scans clean **and** actually holds
 * `.nax/config.json` does the artifacts section gain the declared-commands
 * paragraph. Without a `configRoot()` call no scan runs at all, and a scan
 * that rejects is swallowed (closed).
 *
 * Fixtures are real files under a temp root; no process or network I/O.
 *
 * Split out of `tdd-builder.test.ts` by concern — that file already passes the
 * ~650-line target (test-architecture.md, *Placement Rules* §2).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeNaxConfig, makeStory, withTempDir } from "@test/helpers";
import type { ConfigSecretScan } from "@/config";
import { PromptBuilder } from "@/prompts";
import { _tddPromptBuilderDeps, TddPromptBuilder } from "@/prompts/builders/tdd-builder";

const ROOT_CONFIG = ".nax/config.json";
/** Only the hint paragraph names this path; the baseline artifacts text never does. */
const MONO_HINT = ".nax/mono/<package>/config.json";
/** A sentence of the always-on artifacts text, used to prove the section rendered. */
const BASELINE_MARKER = "do not diff or revert it";

function writeConfig(root: string, rel: string, value: unknown): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(value));
}

function cleanScan(files: readonly string[]): ConfigSecretScan {
  return { clean: true, files, findings: [] };
}

const originalScan = _tddPromptBuilderDeps.scanConfigSecrets;
afterEach(() => {
  _tddPromptBuilderDeps.scanConfigSecrets = originalScan;
});

describe("TddPromptBuilder.configRoot — US-004 config-read hint", () => {
  // AC3
  test("AC3: adds the hint when the root config is a clean empty object", async () => {
    await withTempDir(async (root) => {
      writeConfig(root, ROOT_CONFIG, {});
      const prompt = await PromptBuilder.for("tdd-simple")
        .withLoader(join(root, "packages", "app"), makeNaxConfig({}))
        .configRoot(root)
        .story(makeStory())
        .build();
      expect(prompt).toContain(MONO_HINT);
    });
  });

  // AC4
  test("AC4: omits the hint when the root config holds a literal header secret", async () => {
    await withTempDir(async (root) => {
      writeConfig(root, ROOT_CONFIG, {
        reporters: { webhook: { headers: { Authorization: "Bearer abc12345xyz" } } },
      });
      const prompt = await PromptBuilder.for("tdd-simple")
        .withLoader(root, makeNaxConfig({}))
        .configRoot(root)
        .story(makeStory())
        .build();
      expect(prompt).not.toContain(MONO_HINT);
    });
  });

  // AC5
  test("AC5: omits the hint when the root has no .nax/config.json", async () => {
    await withTempDir(async (root) => {
      const prompt = await PromptBuilder.for("tdd-simple")
        .withLoader(root, makeNaxConfig({}))
        .configRoot(root)
        .story(makeStory())
        .build();
      expect(prompt).not.toContain(MONO_HINT);
    });
  });

  // AC5 boundary — the omission is the *hint*, not the whole artifacts section.
  test("AC5 boundary: the artifacts section still renders when there is no root config", async () => {
    await withTempDir(async (root) => {
      const prompt = await PromptBuilder.for("tdd-simple")
        .withLoader(root, makeNaxConfig({}))
        .configRoot(root)
        .story(makeStory())
        .build();
      expect(prompt).toContain(BASELINE_MARKER);
    });
  });

  // AC6
  test("AC6: without configRoot() the hint is omitted and no scan runs", async () => {
    await withTempDir(async (root) => {
      writeConfig(root, ROOT_CONFIG, {});
      let scans = 0;
      _tddPromptBuilderDeps.scanConfigSecrets = async () => {
        scans += 1;
        return cleanScan([ROOT_CONFIG]);
      };
      const prompt = await PromptBuilder.for("tdd-simple")
        .withLoader(root, makeNaxConfig({}))
        .story(makeStory())
        .build();
      expect(prompt).not.toContain(MONO_HINT);
      expect(scans).toBe(0);
    });
  });

  // AC7
  test("AC7: a rejecting scan omits the hint and build() still resolves", async () => {
    await withTempDir(async (root) => {
      writeConfig(root, ROOT_CONFIG, {});
      _tddPromptBuilderDeps.scanConfigSecrets = async () => {
        throw new Error("scan failed");
      };
      const prompt = await PromptBuilder.for("tdd-simple")
        .withLoader(root, makeNaxConfig({}))
        .configRoot(root)
        .story(makeStory())
        .build();
      expect(typeof prompt).toBe("string");
      expect(prompt).not.toContain(MONO_HINT);
    });
  });

  // AC7 boundary — closed means the section still renders, just unhinted.
  test("AC7 boundary: the artifacts section still renders when the scan rejects", async () => {
    await withTempDir(async (root) => {
      writeConfig(root, ROOT_CONFIG, {});
      _tddPromptBuilderDeps.scanConfigSecrets = async () => {
        throw new Error("scan failed");
      };
      const prompt = await PromptBuilder.for("tdd-simple")
        .withLoader(root, makeNaxConfig({}))
        .configRoot(root)
        .story(makeStory())
        .build();
      expect(prompt).toContain(BASELINE_MARKER);
    });
  });

  // AC10
  test("AC10: buildForRole with opts.root adds the hint", async () => {
    await withTempDir(async (root) => {
      writeConfig(root, ROOT_CONFIG, {});
      const prompt = await TddPromptBuilder.buildForRole(
        "implementer",
        join(root, "packages", "app"),
        makeNaxConfig({}),
        makeStory(),
        { root },
      );
      expect(prompt).toContain(MONO_HINT);
    });
  });

  // AC11
  test("AC11: buildForRole without opts.root omits the hint", async () => {
    await withTempDir(async (root) => {
      writeConfig(root, ROOT_CONFIG, {});
      const prompt = await TddPromptBuilder.buildForRole("implementer", root, makeNaxConfig({}), makeStory(), {});
      expect(prompt).not.toContain(MONO_HINT);
    });
  });
});
