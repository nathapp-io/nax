/**
 * In-flight mutant journal tests.
 *
 * The journal is what makes an interrupted run recoverable: it is written
 * before the mutation and removed only after a verified revert, so its
 * presence at the start of a later run means a mutation was applied and never
 * confirmed restored. These tests pin that contract, including the fail-open
 * paths — leftover cleanup must never be the thing that breaks a run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type Mutant,
  applyMutant,
  clearInFlight,
  journalPathFor,
  recordInFlight,
  restoreInFlight,
} from "@/verification";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

describe("mutation journal", () => {
  let repoRoot: string;
  let filePath: string;
  const original = "const x = 1;\nconst y = 2;\n";

  const mutant = (): Mutant => ({
    file: filePath,
    line: 2,
    before: "const y = 2;",
    after: "const y = 99;",
    operatorId: "ts:literal-flip",
  });

  beforeEach(async () => {
    repoRoot = makeTempDir("nax-journal-");
    filePath = join(repoRoot, "src.ts");
    await Bun.write(filePath, original);
  });

  afterEach(() => {
    cleanupTempDir(repoRoot);
  });

  test("a recorded entry lands on disk and clears again", async () => {
    await recordInFlight(repoRoot, { ...mutant(), storyId: "US-001" });
    expect(await Bun.file(journalPathFor(repoRoot, "US-001")).exists()).toBe(true);

    await clearInFlight(repoRoot, "US-001");

    expect(await Bun.file(journalPathFor(repoRoot, "US-001")).exists()).toBe(false);
  });

  test("clearing a journal that was never written is not an error", async () => {
    await clearInFlight(repoRoot, "US-404");
    expect(await Bun.file(journalPathFor(repoRoot, "US-404")).exists()).toBe(false);
  });

  test("stories get separate journals — a parallel story does not clobber another", async () => {
    await recordInFlight(repoRoot, { ...mutant(), storyId: "US-001" });
    await recordInFlight(repoRoot, { ...mutant(), storyId: "US-002" });

    await clearInFlight(repoRoot, "US-001");

    expect(await Bun.file(journalPathFor(repoRoot, "US-001")).exists()).toBe(false);
    expect(await Bun.file(journalPathFor(repoRoot, "US-002")).exists()).toBe(true);
  });

  test("a story id with path separators cannot escape the journal directory", async () => {
    await recordInFlight(repoRoot, { ...mutant(), storyId: "../../escape" });

    const path = journalPathFor(repoRoot, "../../escape");
    expect(path.startsWith(join(repoRoot, ".nax", "mutation-journal"))).toBe(true);
    expect(await Bun.file(path).exists()).toBe(true);
  });
});

describe("restoreInFlight — sweeping an interrupted run", () => {
  let repoRoot: string;
  let filePath: string;
  const original = "const x = 1;\nconst y = 2;\n";

  const mutant = (): Mutant => ({
    file: filePath,
    line: 2,
    before: "const y = 2;",
    after: "const y = 99;",
    operatorId: "ts:literal-flip",
  });

  beforeEach(async () => {
    repoRoot = makeTempDir("nax-journal-sweep-");
    filePath = join(repoRoot, "src.ts");
    await Bun.write(filePath, original);
  });

  afterEach(() => {
    cleanupTempDir(repoRoot);
  });

  test("a mutation left on disk is undone and the journal cleared", async () => {
    // Exactly the state a SIGKILL between apply and revert leaves behind.
    await recordInFlight(repoRoot, { ...mutant(), storyId: "US-001" });
    await applyMutant(mutant());

    const results = await restoreInFlight(repoRoot);

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe("restored");
    expect(await Bun.file(filePath).text()).toBe(original);
    expect(await Bun.file(journalPathFor(repoRoot, "US-001")).exists()).toBe(false);
  });

  test("a journal whose mutation was already reverted reports already-clean", async () => {
    await recordInFlight(repoRoot, { ...mutant(), storyId: "US-001" });

    const results = await restoreInFlight(repoRoot);

    expect(results[0]?.outcome).toBe("already-clean");
    expect(await Bun.file(filePath).text()).toBe(original);
  });

  test("a line rewritten by someone else is left alone and reported unrecoverable", async () => {
    await recordInFlight(repoRoot, { ...mutant(), storyId: "US-001" });
    const rewritten = "const x = 1;\nconst y = somethingElse();\n";
    await Bun.write(filePath, rewritten);

    const results = await restoreInFlight(repoRoot);

    expect(results[0]?.outcome).toBe("unrecoverable");
    expect(results[0]?.actual).toBe("const y = somethingElse();");
    expect(await Bun.file(filePath).text()).toBe(rewritten);
  });

  test("an unrecoverable entry still clears its journal — it would nag every run otherwise", async () => {
    await recordInFlight(repoRoot, { ...mutant(), storyId: "US-001" });
    await Bun.write(filePath, "const x = 1;\nconst y = somethingElse();\n");

    await restoreInFlight(repoRoot);

    expect(await Bun.file(journalPathFor(repoRoot, "US-001")).exists()).toBe(false);
    expect(await restoreInFlight(repoRoot)).toEqual([]);
  });

  test("a mutation whose file has since been deleted is unrecoverable, not a throw", async () => {
    await recordInFlight(repoRoot, { ...mutant(), storyId: "US-001" });
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath);

    const results = await restoreInFlight(repoRoot);

    expect(results[0]?.outcome).toBe("unrecoverable");
  });

  test("every journalled story is swept, not just the first", async () => {
    const second = join(repoRoot, "other.ts");
    await Bun.write(second, original);
    await recordInFlight(repoRoot, { ...mutant(), storyId: "US-001" });
    await recordInFlight(repoRoot, { ...mutant(), file: second, storyId: "US-002" });
    await applyMutant(mutant());
    await applyMutant({ ...mutant(), file: second });

    const results = await restoreInFlight(repoRoot);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.outcome === "restored")).toBe(true);
    expect(await Bun.file(filePath).text()).toBe(original);
    expect(await Bun.file(second).text()).toBe(original);
  });

  test("an entry naming a file outside the root is neither restored nor cleared", async () => {
    // Belt and braces against a wrong anchor: the entry belongs to another
    // working tree, so this sweep must leave both the file and the journal for
    // whoever owns them.
    const otherTree = makeTempDir("nax-journal-other-");
    try {
      const foreign = join(otherTree, "src.ts");
      const mutated = "const y = 99;\n";
      await Bun.write(foreign, mutated);
      await recordInFlight(repoRoot, { ...mutant(), file: foreign, storyId: "US-OTHER" });

      const results = await restoreInFlight(repoRoot);

      expect(results).toEqual([]);
      expect(await Bun.file(foreign).text()).toBe(mutated);
      expect(await Bun.file(journalPathFor(repoRoot, "US-OTHER")).exists()).toBe(true);
    } finally {
      cleanupTempDir(otherTree);
    }
  });

  test("no journal directory yields no work", async () => {
    expect(await restoreInFlight(repoRoot)).toEqual([]);
  });

  test("a corrupt journal entry is discarded rather than throwing", async () => {
    await recordInFlight(repoRoot, { ...mutant(), storyId: "US-001" });
    await Bun.write(journalPathFor(repoRoot, "US-001"), "{ not json");

    expect(await restoreInFlight(repoRoot)).toEqual([]);
    expect(await Bun.file(journalPathFor(repoRoot, "US-001")).exists()).toBe(false);
  });

  test("a structurally invalid entry is discarded rather than half-applied", async () => {
    await recordInFlight(repoRoot, { ...mutant(), storyId: "US-001" });
    await Bun.write(journalPathFor(repoRoot, "US-001"), JSON.stringify({ storyId: "US-001" }));

    expect(await restoreInFlight(repoRoot)).toEqual([]);
    expect(await Bun.file(filePath).text()).toBe(original);
  });
});
