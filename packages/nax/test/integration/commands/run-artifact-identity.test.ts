/**
 * US-003 — run artifact identity: registered log lookup in `logs --run` and `replay`.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _deps as _logsReaderDeps, logsCommand } from "@/commands/logs";
import { _replayCmdDeps, runReplay } from "@/commands/replay";
import { _discoveryDeps } from "@/replay/discovery";

const RUN = "run-aaaa1111-2026-01-01T00-00-00.000";
const entry = (message: string) =>
  `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", level: "info", stage: "story-orchestrator", message, data: { storyId: "US-1" } })}\n`;

let root: string;
let runsDir: string;
let eventsDir: string;
let outside: string;

function register(name: string, meta: Record<string, unknown>): void {
  const dir = join(runsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId: RUN,
      project: "p",
      feature: "f",
      workdir: "/w",
      statusPath: join(root, "s.json"),
      eventsDir,
      registeredAt: "2026-01-01T00:00:00.000Z",
      ...meta,
    }),
  );
}

async function logs(): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.join(" "));
  });
  try {
    await logsCommand({ run: RUN });
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

async function replay(): Promise<string> {
  let out = "";
  const metrics = {
    runId: RUN,
    feature: "f",
    storiesFailed: 0,
    stories: [{ storyId: "US-1", success: true, finalTier: "fast", cost: 0, attempts: 1 }],
  } as unknown as Awaited<ReturnType<typeof _replayCmdDeps.readMetrics>>; // test-ratchet-allow: as-unknown-as
  await runReplay(
    RUN,
    { json: true },
    {
      ..._replayCmdDeps,
      readMetrics: async () => metrics,
      stdout: (t) => {
        out += t;
      },
      stderr: () => {},
    },
  );
  return out;
}

describe("logs/replay resolve the registered log", () => {
  let origLogs: typeof _logsReaderDeps.getRunsDir;
  let origDisc: typeof _discoveryDeps.getRunsDir;
  beforeEach(() => {
    root = makeTempDir("run-artifact-identity-");
    runsDir = join(root, "registry");
    eventsDir = join(root, "events");
    outside = join(root, "outside");
    mkdirSync(runsDir, { recursive: true });
    mkdirSync(eventsDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    origLogs = _logsReaderDeps.getRunsDir;
    origDisc = _discoveryDeps.getRunsDir;
    _logsReaderDeps.getRunsDir = () => runsDir;
    _discoveryDeps.getRunsDir = () => runsDir;
  });
  afterEach(() => {
    _logsReaderDeps.getRunsDir = origLogs;
    _discoveryDeps.getRunsDir = origDisc;
    cleanupTempDir(root);
  });

  test("AC-3/AC-4: declared file wins over exact-ID decoy", async () => {
    writeFileSync(join(eventsDir, "declared.jsonl"), entry("Phase passed: older"));
    writeFileSync(join(eventsDir, `${RUN}.jsonl`), entry("Phase passed: decoy"));
    register("r", { logFileName: "declared.jsonl" });
    const l = await logs();
    expect(l).toContain("older");
    expect(l).not.toContain("decoy");
    const r = await replay();
    expect(r).toContain("older");
    expect(r).not.toContain("decoy");
  });

  test("AC-5/AC-7: missing declared file with sibling reports unavailable", async () => {
    writeFileSync(join(eventsDir, "sibling.jsonl"), entry("Phase passed: sibling"));
    register("r", { logFileName: "gone.jsonl" });
    expect(await logs()).toContain("unavailable");
    expect(await logs()).not.toContain("sibling");
    expect(await replay()).not.toContain("sibling");
  });

  test("AC-6: legacy record resolves exact <runId>.jsonl", async () => {
    writeFileSync(join(eventsDir, `${RUN}.jsonl`), entry("Phase passed: legacy"));
    register("r", {});
    expect(await logs()).toContain("legacy");
    expect(await replay()).toContain("legacy");
  });

  test("AC-7: legacy exact-name miss reconstructs nothing from another file", async () => {
    writeFileSync(join(eventsDir, "other.jsonl"), entry("Phase passed: other"));
    register("r", {});
    expect(await replay()).not.toContain("other");
    expect(await logs()).not.toContain("other");
  });

  test.each(["../escape.jsonl", "sub/x.jsonl", "notjsonl.txt", "latest.jsonl", ""])(
    "AC-12/AC-14: logFileName %p is unavailable despite an exact-ID decoy",
    async (bad) => {
      writeFileSync(join(eventsDir, `${RUN}.jsonl`), entry("Phase passed: decoy"));
      writeFileSync(join(eventsDir, "latest.jsonl"), entry("Phase passed: decoy"));
      register("r", { logFileName: bad });
      expect(await logs()).not.toContain("decoy");
      expect(await replay()).not.toContain("decoy");
    },
  );

  test("AC-15: escaping symlinks (declared and legacy) are unavailable", async () => {
    writeFileSync(join(outside, "secret.jsonl"), entry("Phase passed: secret"));
    symlinkSync(join(outside, "secret.jsonl"), join(eventsDir, "link.jsonl"));
    register("r", { logFileName: "link.jsonl" });
    expect(await logs()).not.toContain("secret");
    expect(await replay()).not.toContain("secret");

    symlinkSync(join(outside, "secret.jsonl"), join(eventsDir, `${RUN}.jsonl`));
    register("r", {});
    expect(await logs()).not.toContain("secret");
    expect(await replay()).not.toContain("secret");
  });
});
