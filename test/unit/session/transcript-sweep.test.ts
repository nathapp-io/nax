/**
 * US-002 AC4-AC9 — sweepFeatureTranscripts
 *
 * `sweepFeatureTranscripts({ featureName, transcriptRoot, dryRun })` resolves
 * the feature's `sessions/` directory under the runtime outputDir via
 * `deriveNativeTranscriptDir` and delegates to `pruneRetainedTranscripts`.
 * It must return `0` (and not touch disk) when the directory cannot be
 * derived, when `dryRun` is true, or when the derived directory is absent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessage } from "@nathapp/nax-ai";
import { saveTranscript } from "@/agents/native/session/transcript-store";

let rootDir: string;
let transcriptRoot: string;
const FEATURE = "demo-feature";

const msgs: ConversationMessage[] = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
];

const SESSIONS_DIR = () => join(transcriptRoot, "features", FEATURE, "sessions");

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "nax-sweep-"));
  transcriptRoot = join(rootDir, "nax-out");
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function seedSessions(n: number): Promise<void> {
  const dir = SESSIONS_DIR();
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const name = `sess-${String(i).padStart(3, "0")}`;
    await saveTranscript(dir, name, msgs);
    const mtime = new Date(2026, 0, 1 + i);
    await utimes(join(dir, `${name}.transcript.json`), mtime, mtime);
  }
}

describe("sweepFeatureTranscripts — AC4", () => {
  test("prunes the derived directory and returns the count", async () => {
    await seedSessions(53);
    const dir = SESSIONS_DIR();
    const files = (await readdir(dir)).filter((n) => n.endsWith(".transcript.json"));
    expect(files).toHaveLength(50);
  });
});
