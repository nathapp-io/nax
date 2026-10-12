import { afterEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
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
});
