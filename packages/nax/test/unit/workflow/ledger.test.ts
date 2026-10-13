import { afterEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { appendLedger, ensureLedger, ledgerFilePath, ledgerText } from "@/workflow/ledger";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

describe("workflow ledger", () => {
  test("header once, then storyId-prefixed lines", async () => {
    const dir = makeTempDir("wf-ledger-");
    dirs.push(dir);
    await ensureLedger(dir, "run-1", "feat-a");
    await ensureLedger(dir, "run-1", "feat-a");
    await appendLedger(dir, "US-001", ledgerText.fixRound(2, 5, "2 open: F1, F2"));
    await appendLedger(dir, "US-001", ledgerText.end("complete", "1 round"));
    const text = await Bun.file(ledgerFilePath(dir)).text();
    expect(text).toBe(
      "# Workflow ledger — run: run-1 — feature: feat-a\n" +
        "US-001: fix round 2/5 (2 open: F1, F2)\n" +
        "US-001: complete (1 round)\n",
    );
  });

  test("ruling line uses the skill's three-part shape", () => {
    expect(
      ledgerText.ruling({
        action: "hold",
        text: "hold F3",
        why: "no advisor",
        costIfWrong: "stays open",
        source: "default",
      }),
    ).toBe("Ruling: hold F3 — no advisor — stays open");
  });

  test("multi-line text is folded onto one line", () => {
    expect(ledgerText.deferredMinor("a\nb")).toBe("deferred-minor: a b");
  });

  test("every append is mirrored to the run log at info level, tag workflow, with storyId first", async () => {
    const dir = makeTempDir("wf-ledger-log-");
    dirs.push(dir);
    resetLogger();
    const logs: LogEntry[] = [];
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
    try {
      await ensureLedger(dir, "run-1", "feat-a");
      await appendLedger(dir, "US-001", ledgerText.fixRound(1, 5, "2 open: F1, F2"));
      await appendLedger(dir, "_run", ledgerText.note("feature local-only: no forge"));
    } finally {
      resetLogger();
    }
    expect(logs.map((e) => [e.level, e.stage, e.message])).toEqual([
      ["info", "workflow", "US-001: fix round 1/5 (2 open: F1, F2)"],
      ["info", "workflow", "feature local-only: no forge"],
    ]);
    expect(Object.keys(logs[0]?.data ?? {})[0]).toBe("storyId");
    expect(logs[1]?.data?.storyId).toBe("_run");
  });

  test("mirror: false writes ledger.md but logs nothing (the step line already says it)", async () => {
    const dir = makeTempDir("wf-ledger-nomirror-");
    dirs.push(dir);
    resetLogger();
    const logs: LogEntry[] = [];
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
    try {
      await ensureLedger(dir, "run-1", "feat-a");
      await appendLedger(dir, "US-001", "hidden fact", { mirror: false });
    } finally {
      resetLogger();
    }
    expect(logs).toHaveLength(0);
    expect(await Bun.file(ledgerFilePath(dir)).text()).toContain("US-001: hidden fact");
  });

  test("mirrored text is capped at 200 chars in the log; ledger.md keeps all of it", async () => {
    const dir = makeTempDir("wf-ledger-cap-");
    dirs.push(dir);
    resetLogger();
    const logs: LogEntry[] = [];
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
    const long = "x".repeat(500);
    try {
      await ensureLedger(dir, "run-1", "feat-a");
      await appendLedger(dir, "US-001", long);
    } finally {
      resetLogger();
    }
    expect(logs[0]?.message.length).toBeLessThanOrEqual("US-001: ".length + 200);
    expect(logs[0]?.message.endsWith("...")).toBe(true);
    expect(await Bun.file(ledgerFilePath(dir)).text()).toContain(long);
  });

  test("ledgerText.ruling marks a coerced defer (#2496)", () => {
    const text = ledgerText.ruling({
      findingId: "B3",
      action: "hold",
      text: "t",
      why: "w",
      costIfWrong: "c",
      source: "advisor",
      coercedFrom: "defer",
    });
    expect(text).toEndWith("(coerced from defer: no later review step)");
  });
});
