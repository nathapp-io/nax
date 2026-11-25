/** Shared on-disk mirror fixture for compaction failure and retention tests. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryOutbox, createMemoryStore, type MemoryNote } from "@nathapp/nax-agent";
import { applyMemoryCompaction, type MemoryCompactionApplyInput } from "@nathapp/nax-agent/internal";
import { makeFakeClock } from "@nathapp/nax-test-kit/bun/fake-clock";
import type { MemoryCompactionManifest } from "#src/memory/compaction-archive";
import { makeLogger } from "./agent-logger";
import { assertCaughtInstanceOf } from "./assert-nax-error";

export const COMPACTION_ID = "20261125T101500Z-3fa2c1";
export const COMPACTION_STAMP = "2026-11-25T10:15:00.000Z";

export async function makeCompactionHarness(dir: string) {
  const logger = makeLogger();
  const store = createMemoryStore({ projectDir: join(dir, "project"), logger });
  const originals: MemoryNote[] = ["retired", "source-a", "source-b", "unrelated"].map((slug) => ({
    id: `id-${slug}`,
    slug,
    type: "project",
    scope: "project",
    description: `Original ${slug}`,
    body: `Body of ${slug}`,
    source: "nax-chat",
    status: "active",
    updatedAt: "2026-11-02T08:11:00.000Z",
  }));
  for (const note of originals) await store.writeNote(note);
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir });
  const input: MemoryCompactionApplyInput = {
    store,
    outbox,
    logger,
    plan: {
      retire: [{ slug: "retired", reason: "obsolete" }],
      merge: [
        {
          from: ["source-a", "source-b"],
          into: { slug: "merged", type: "project", description: "Combined", body: "Combined body" },
        },
      ],
    },
    provider: "local",
    model: "balanced",
    fillBefore: 0.9,
    keepArchives: 2,
    now: () => new Date(COMPACTION_STAMP),
    newId: () => COMPACTION_ID,
    timers: makeFakeClock(),
  };
  return {
    store,
    outbox,
    logger,
    originals,
    input,
    apply: (overrides: Partial<MemoryCompactionApplyInput> = {}) => applyMemoryCompaction({ ...input, ...overrides }),
  };
}

export async function compactionFailure(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    assertCaughtInstanceOf(error, Error);
    return error;
  }
  throw new Error("Expected compaction to fail");
}

export async function compactionManifest(
  h: Awaited<ReturnType<typeof makeCompactionHarness>>,
): Promise<MemoryCompactionManifest> {
  return JSON.parse(await readFile(join(h.store.paths.archiveDir, COMPACTION_ID, "manifest.json"), "utf8"));
}
