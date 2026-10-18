/**
 * US-007 — `context.projectContext.file`: the run's project-context override.
 *
 * Two halves of one contract. `loadProjectContextOverride` reads the configured
 * file and is deliberately fail-closed: the operator asked for that file, and a
 * run that silently proceeded without it would look identical to a run that
 * honoured it. The cap is never applied as truncation — half a context file is a
 * different document, and the agent cannot tell it was cut.
 *
 * `rootInstructionDenyPaths` answers the other half: under `mode: "replace"` a
 * native session must stop auto-loading the repository's *root* instruction file,
 * and it does that by denying reads of the names the native session would
 * otherwise discover. `matchesDenyPaths` anchors on the whole repo-relative path,
 * so a bare `AGENTS.md` denies the root file alone and a package-level
 * `packages/api/AGENTS.md` still loads.
 *
 * The AC id is the test-name prefix.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertNaxError, cleanupTempDir, makeNaxConfig, makeSparseNaxConfig, makeTempDir } from "@test/helpers";
import type { NaxConfig } from "@/config";
import {
  loadProjectContextOverride,
  MAX_PROJECT_CONTEXT_BYTES,
  rootInstructionDenyPaths,
} from "@/context/project-context-override";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) cleanupTempDir(dir);
  }
});

/** A fresh temp dir, removed by the file-level afterEach. */
function tempRoot(prefix = "nax-project-context-"): string {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}

/** A config with `context.projectContext.file` set (the only key these tests read). */
function configWithFile(file: string | undefined): NaxConfig {
  return makeNaxConfig({ context: { projectContext: file === undefined ? {} : { file } } });
}

/** A file of exactly `bytes` UTF-8 bytes whose head names it, so a returned body is recognisable. */
async function writeSizedFile(path: string, bytes: number, head = ""): Promise<void> {
  const tail = Math.max(0, bytes - Buffer.byteLength(head, "utf8"));
  await Bun.write(path, `${head}${"x".repeat(tail)}`);
  expect(Bun.file(path).size).toBe(bytes);
}

describe("loadProjectContextOverride (AC-1)", () => {
  test("AC-1: returns the file's content for an existing file of exactly 32,768 bytes", async () => {
    const dir = tempRoot();
    const file = join(dir, "org-context.md");
    await writeSizedFile(file, MAX_PROJECT_CONTEXT_BYTES, "# Org context\n\n");

    const content = await loadProjectContextOverride(configWithFile(file));

    expect(MAX_PROJECT_CONTEXT_BYTES).toBe(32_768);
    expect(content).toBeDefined();
    expect(content?.startsWith("# Org context\n\n")).toBe(true);
    expect(Buffer.byteLength(content ?? "", "utf8")).toBe(MAX_PROJECT_CONTEXT_BYTES);
    expect(content).not.toContain("\uFFFD");
  });

  test("the size is UTF-8 bytes, not characters: 16,384 two-byte characters are accepted", async () => {
    const dir = tempRoot();
    const file = join(dir, "org-context.md");
    const body = "é".repeat(MAX_PROJECT_CONTEXT_BYTES / 2);
    await Bun.write(file, body);
    expect(Bun.file(file).size).toBe(MAX_PROJECT_CONTEXT_BYTES);

    expect(await loadProjectContextOverride(configWithFile(file))).toBe(body);
  });
});

describe("loadProjectContextOverride — no file configured (AC-2)", () => {
  test("AC-2: an unset context.projectContext.file returns undefined", async () => {
    expect(await loadProjectContextOverride(makeNaxConfig())).toBeUndefined();
  });

  test("AC-2: an explicit file: undefined returns undefined", async () => {
    expect(await loadProjectContextOverride(configWithFile(undefined))).toBeUndefined();
  });

  test("AC-2: a sparse config (no context block at all) reads defensively and returns undefined", async () => {
    expect(await loadProjectContextOverride(makeSparseNaxConfig({}))).toBeUndefined();
  });
});

describe("loadProjectContextOverride — a missing file (AC-3)", () => {
  test("AC-3: rejects with PROJECT_CONTEXT_FILE_NOT_FOUND, naming the file", async () => {
    const dir = tempRoot();
    const file = join(dir, "gone.md");

    const err = await loadProjectContextOverride(configWithFile(file)).catch((caught: unknown) => caught);

    assertNaxError(err, "loadProjectContextOverride rejection");
    expect(err.code).toBe("PROJECT_CONTEXT_FILE_NOT_FOUND");
    expect(err.context).toMatchObject({ stage: "run-setup", file });
    expect(err.message).toContain(file);
  });
});

describe("loadProjectContextOverride — a file past the cap (AC-4)", () => {
  test("AC-4: a 32,769-byte file rejects with PROJECT_CONTEXT_FILE_TOO_LARGE rather than truncating", async () => {
    const dir = tempRoot();
    const file = join(dir, "org-context.md");
    await writeSizedFile(file, MAX_PROJECT_CONTEXT_BYTES + 1);

    const err = await loadProjectContextOverride(configWithFile(file)).catch((caught: unknown) => caught);

    assertNaxError(err, "loadProjectContextOverride rejection");
    expect(err.code).toBe("PROJECT_CONTEXT_FILE_TOO_LARGE");
    expect(err.context).toMatchObject({
      stage: "run-setup",
      file,
      bytes: MAX_PROJECT_CONTEXT_BYTES + 1,
      maxBytes: MAX_PROJECT_CONTEXT_BYTES,
    });
  });

  test("AC-4: one byte past the cap in a multi-byte body is rejected too", async () => {
    const dir = tempRoot();
    const file = join(dir, "org-context.md");
    await Bun.write(file, `${"é".repeat(MAX_PROJECT_CONTEXT_BYTES / 2)}x`);

    const err = await loadProjectContextOverride(configWithFile(file)).catch((caught: unknown) => caught);

    assertNaxError(err, "loadProjectContextOverride rejection");
    expect(err.code).toBe("PROJECT_CONTEXT_FILE_TOO_LARGE");
    expect(err.context).toMatchObject({ bytes: MAX_PROJECT_CONTEXT_BYTES + 1 });
  });

  test("AC-4: the message names the size and the cap, so the operator can act on it", async () => {
    const dir = tempRoot();
    const file = join(dir, "org-context.md");
    await writeSizedFile(file, MAX_PROJECT_CONTEXT_BYTES + 100);

    const err = await loadProjectContextOverride(configWithFile(file)).catch((caught: unknown) => caught);

    assertNaxError(err, "loadProjectContextOverride rejection");
    expect(err.message).toContain("32868");
    expect(err.message).toContain("32768");
  });
});

describe("rootInstructionDenyPaths (AC-10, AC-11)", () => {
  test("AC-10: the default instruction file name denies the three root names", () => {
    expect(rootInstructionDenyPaths("AGENTS.md")).toEqual(["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"]);
  });

  test("AC-11: a configured instruction file name denies that name alone", () => {
    expect(rootInstructionDenyPaths("GUIDE.md")).toEqual(["GUIDE.md"]);
  });

  test("the returned list is a fresh array, so a caller spreading it cannot mutate a shared one", () => {
    const first = rootInstructionDenyPaths("AGENTS.md");
    first.push("SOMETHING.md");

    expect(rootInstructionDenyPaths("AGENTS.md")).toEqual(["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"]);
  });

  test("the names are bare, so the deny is rooted at the repository's own instruction file", () => {
    for (const name of rootInstructionDenyPaths("AGENTS.md")) {
      expect(name).not.toContain("/");
      expect(name).toMatch(/^[^/]+\.md$/i);
    }
  });
});
