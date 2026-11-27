/**
 * US-003 — feature-directory chronology for plain `logs` and `logs --list`.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { logsCommand } from "@/commands/logs";
import { buildRunId } from "@/execution/run-id";

const rec = (message: string) =>
  `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", level: "info", stage: "x", message, data: {} })}\n`;

let root: string;
let runs: string;

async function capture(opts: { list?: boolean }): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.join(" "));
  });
  try {
    await logsCommand({ dir: root, ...opts });
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

describe("logs chronology across filename formats", () => {
  beforeEach(() => {
    root = makeTempDir("run-artifact-chrono-");
    runs = join(root, ".nax", "features", "feat", "runs");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(root, ".nax", "config.json"), "{}");
  });
  afterEach(() => cleanupTempDir(root));

  function twoIds(): { older: string; newer: string } {
    const t1 = new Date("2026-01-01T00:00:00.000Z");
    const t2 = new Date("2026-02-01T00:00:00.000Z");
    const candidates = ["/w/a", "/w/b", "/w/c", "/w/d"];
    const sorted = candidates.map((w) => buildRunId(w, t1)).sort((a, b) => a.localeCompare(b));
    const hi = sorted[sorted.length - 1].split("-")[1];
    const lo = sorted[0].split("-")[1];
    const hiW = candidates.find((w) => buildRunId(w, t1).split("-")[1] === hi) as string;
    const loW = candidates.find((w) => buildRunId(w, t1).split("-")[1] === lo) as string;
    return { older: buildRunId(hiW, t1), newer: buildRunId(loW, t2) };
  }

  test("AC-16/AC-17: newest by timestamp, not greatest filename; list newest first", async () => {
    const { older, newer } = twoIds();
    expect(older > newer).toBe(true);
    writeFileSync(join(runs, `${older}.jsonl`), rec("OLDER-SENTINEL"));
    writeFileSync(join(runs, `${newer}.jsonl`), rec("NEWER-SENTINEL"));
    const out = await capture({});
    expect(out).toContain("NEWER-SENTINEL");
    expect(out).not.toContain("OLDER-SENTINEL");
    const list = await capture({ list: true });
    expect(list.indexOf("2026-02-01")).toBeLessThan(list.indexOf("2026-01-01"));
  });

  test("AC-16: a newer legacy timestamp-only file beats an older hash-prefixed one", async () => {
    const { older } = twoIds();
    writeFileSync(join(runs, `${older}.jsonl`), rec("OLDER-SENTINEL"));
    writeFileSync(join(runs, "2026-03-01T00-00-00.jsonl"), rec("LEGACY-NEWEST"));
    expect(await capture({})).toContain("LEGACY-NEWEST");
  });

  test("AC-18: list renders only the timestamp portion of a hash-prefixed stem", async () => {
    const { older } = twoIds();
    writeFileSync(join(runs, `${older}.jsonl`), rec("x"));
    const list = await capture({ list: true });
    expect(list).toContain("2026-01-01T00-00-00.000");
    expect(list).not.toContain("run-");
  });
});
