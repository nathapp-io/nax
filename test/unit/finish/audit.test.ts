import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import type { FinishResult, FinishRound } from "@/finish";
import {
  appendRound,
  createFinishState,
  ledgerPath,
  readLedger,
  readRounds,
  recordRound,
  resultPath,
  roundsPath,
  writeResult,
} from "@/finish";

function baseRound(overrides: Partial<FinishRound> = {}): FinishRound {
  return {
    ts: "2026-08-18T00:00:00.000Z",
    phase: "spec",
    attempt: 1,
    committed: true,
    findings: [],
    ...overrides,
  };
}

describe("roundsPath / resultPath", () => {
  test("derive deterministic paths from auditDir and runId", () => {
    const t = { auditDir: "/tmp/example/finish-audit/my-feature", runId: "run-42" };

    expect(roundsPath(t)).toBe(join(t.auditDir, "run-42.jsonl"));
    expect(resultPath(t)).toBe(join(t.auditDir, "run-42.result.json"));
  });
});

describe("appendRound / readRounds", () => {
  test("appends one JSON object per line and reads them back in order", async () => {
    await withTempDir(async (dir) => {
      const t = { auditDir: join(dir, "finish-audit", "feat"), runId: "run-1" };

      await appendRound(t, baseRound({ attempt: 1, ts: "2026-08-18T00:00:00.000Z" }));
      await appendRound(t, baseRound({ attempt: 2, ts: "2026-08-18T00:00:01.000Z" }));

      const raw = await Bun.file(roundsPath(t)).text();
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      const rounds = await readRounds(t);
      expect(rounds).toEqual([
        baseRound({ attempt: 1, ts: "2026-08-18T00:00:00.000Z" }),
        baseRound({ attempt: 2, ts: "2026-08-18T00:00:01.000Z" }),
      ]);
    });
  });

  test("mkdir's the audit directory on first append (does not exist yet)", async () => {
    await withTempDir(async (dir) => {
      const t = { auditDir: join(dir, "does", "not", "exist", "yet"), runId: "run-1" };
      expect(existsSync(t.auditDir)).toBe(false);

      await appendRound(t, baseRound());

      expect(existsSync(roundsPath(t))).toBe(true);
    });
  });

  test("readRounds skips a torn final line and returns the rounds before it", async () => {
    await withTempDir(async (dir) => {
      const t = { auditDir: join(dir, "finish-audit", "feat"), runId: "run-1" };
      await appendRound(t, baseRound({ attempt: 1 }));
      await appendRound(t, baseRound({ attempt: 2 }));

      const goodText = await Bun.file(roundsPath(t)).text();
      const torn = `${goodText}{"ts":"2026-08-18T00:00:02.000Z","phase":"spec","attempt`;
      await Bun.write(roundsPath(t), torn);

      const rounds = await readRounds(t);
      expect(rounds).toHaveLength(2);
      expect(rounds.map((r) => r.attempt)).toEqual([1, 2]);
    });
  });

  test("readRounds returns an empty array when no rounds file exists", async () => {
    await withTempDir(async (dir) => {
      const t = { auditDir: join(dir, "finish-audit", "feat"), runId: "run-1" };
      expect(await readRounds(t)).toEqual([]);
    });
  });

  test("appendRound resolves rather than throws when the audit directory is unwritable", async () => {
    await withTempDir(async (dir) => {
      const parent = join(dir, "locked");
      await Bun.write(join(parent, ".keep"), "");
      await chmod(parent, 0o500);

      const t = { auditDir: join(parent, "feat"), runId: "run-1" };
      try {
        await expect(appendRound(t, baseRound())).resolves.toBeUndefined();
      } finally {
        await chmod(parent, 0o700);
      }
    });
  });
});

describe("writeResult", () => {
  test("embeds recorded rounds on a status: opened result, not only on escalated", async () => {
    await withTempDir(async (dir) => {
      const t = { auditDir: join(dir, "finish-audit", "feat"), runId: "run-1" };
      await appendRound(t, baseRound({ attempt: 1 }));
      await appendRound(t, baseRound({ attempt: 2 }));

      const result: FinishResult = { feature: "feat", status: "opened", url: "https://example.com/pr/1" };
      await writeResult(t, result);

      const written = JSON.parse(await Bun.file(resultPath(t)).text()) as FinishResult;
      expect(written.status).toBe("opened");
      expect(written.rounds).toHaveLength(2);
      expect(written.rounds?.map((r) => r.attempt)).toEqual([1, 2]);
    });
  });

  test("writes the result with no rounds key added when nothing was recorded", async () => {
    await withTempDir(async (dir) => {
      const t = { auditDir: join(dir, "finish-audit", "feat"), runId: "run-1" };
      const result: FinishResult = { feature: "feat", status: "nothing-to-finish" };

      await writeResult(t, result);

      const written = JSON.parse(await Bun.file(resultPath(t)).text()) as FinishResult;
      expect(written.rounds).toBeUndefined();
    });
  });
});

describe("recordRound — F3 regression: one monotonic attempt counter per phase", () => {
  test("a review round then a commit round for the same phase produce attempt 1 then attempt 2", async () => {
    await withTempDir(async (dir) => {
      const t = { auditDir: join(dir, "finish-audit", "feat"), runId: "run-1" };
      const state = createFinishState({
        feature: "feat",
        workdir: dir,
        branch: "feat/x",
        runId: "run-1",
        base: "origin/main",
        specPath: ".nax/features/feat/spec.md",
      });

      // Round 1: simulates a review round (used to write reviewAttempts into `attempt`).
      await recordRound(t, state, "spec", {
        ts: "2026-08-18T00:00:00.000Z",
        phase: "spec",
        committed: false,
        outcome: "passed",
        findings: [],
      });

      // Round 2: simulates a commit round (used to write fixAttempts into `attempt`).
      await recordRound(t, state, "spec", {
        ts: "2026-08-18T00:00:01.000Z",
        phase: "spec",
        committed: true,
        outcome: "fixed",
        findings: [],
      });

      const rounds = await readRounds(t);
      expect(rounds.map((r) => r.attempt)).toEqual([1, 2]);
      expect(state.phases.spec.rounds).toBe(2);
    });
  });
});

describe("ledger — writeResult updates last.json for terminal statuses (#1674 part 1)", () => {
  test("an 'opened' result with headSha/branch writes a ledger entry", async () => {
    await withTempDir(async (dir) => {
      const t = { auditDir: join(dir, "finish-audit", "feat"), runId: "run-1" };
      const result: FinishResult = {
        feature: "feat",
        status: "opened",
        headSha: "abc123",
        branch: "feat/x",
        url: "https://example.com/pr/1",
      };
      await writeResult(t, result);

      const ledger = await readLedger(t.auditDir);
      expect(ledger).toEqual({
        branch: "feat/x",
        headSha: "abc123",
        status: "opened",
        prUrl: "https://example.com/pr/1",
        runId: "run-1",
        finishedAt: expect.any(String),
      });
    });
  });

  test("'escalated' also updates the ledger (a re-run must not re-page)", async () => {
    await withTempDir(async (dir) => {
      const t = { auditDir: join(dir, "finish-audit", "feat"), runId: "run-1" };
      const result: FinishResult = {
        feature: "feat",
        status: "escalated",
        headSha: "def456",
        branch: "feat/x",
        escalationReason: "needs a human",
      };
      await writeResult(t, result);

      const ledger = await readLedger(t.auditDir);
      expect(ledger?.status).toBe("escalated");
      expect(ledger?.headSha).toBe("def456");
    });
  });

  test("'nothing-to-finish' (no headSha/branch) leaves the ledger untouched", async () => {
    await withTempDir(async (dir) => {
      const t = { auditDir: join(dir, "finish-audit", "feat"), runId: "run-1" };
      const result: FinishResult = { feature: "feat", status: "nothing-to-finish" };
      await writeResult(t, result);

      expect(await readLedger(t.auditDir)).toBeNull();
    });
  });

  test("a second terminal result overwrites the ledger with the newer HEAD", async () => {
    await withTempDir(async (dir) => {
      const t = { auditDir: join(dir, "finish-audit", "feat"), runId: "run-1" };
      await writeResult(t, { feature: "feat", status: "opened", headSha: "sha-1", branch: "feat/x" });
      await writeResult(t, { feature: "feat", status: "promoted", headSha: "sha-2", branch: "feat/x" });

      const ledger = await readLedger(t.auditDir);
      expect(ledger?.headSha).toBe("sha-2");
      expect(ledger?.status).toBe("promoted");
    });
  });

  test("readLedger returns null when last.json does not exist", async () => {
    await withTempDir(async (dir) => {
      expect(await readLedger(join(dir, "finish-audit", "feat"))).toBeNull();
    });
  });

  test("readLedger fails open on corrupt JSON rather than throwing", async () => {
    await withTempDir(async (dir) => {
      const auditDir = join(dir, "finish-audit", "feat");
      await Bun.write(ledgerPath(auditDir), "{ not valid json");
      await expect(readLedger(auditDir)).resolves.toBeNull();
    });
  });

  test("readLedger fails open on a well-formed JSON object missing required fields", async () => {
    await withTempDir(async (dir) => {
      const auditDir = join(dir, "finish-audit", "feat");
      await Bun.write(ledgerPath(auditDir), JSON.stringify({ status: "opened" }));
      await expect(readLedger(auditDir)).resolves.toBeNull();
    });
  });

  test("a ledger write failure is fail-soft — writeResult still resolves and still wrote result.json", async () => {
    await withTempDir(async (dir) => {
      const auditDir = join(dir, "finish-audit", "feat");
      // Force the ledger write specifically to fail (EISDIR) while leaving
      // the audit dir itself, and result.json's own path, writable — proving
      // this is the ledger update that is fail-soft, not writeResult's own
      // (still-throwing) result.json write.
      await mkdir(ledgerPath(auditDir), { recursive: true });
      const t = { auditDir, runId: "run-1" };
      await expect(
        writeResult(t, { feature: "feat", status: "opened", headSha: "sha-1", branch: "feat/x" }),
      ).resolves.toBeUndefined();
      expect(await Bun.file(resultPath(t)).exists()).toBe(true);
    });
  });

  test("writeResult(..., { ledger: false }) writes result.json but skips the ledger update", async () => {
    await withTempDir(async (dir) => {
      const t = { auditDir: join(dir, "finish-audit", "feat"), runId: "run-1" };
      await writeResult(
        t,
        { feature: "feat", status: "opened", headSha: "sha-1", branch: "feat/x" },
        { ledger: false },
      );

      expect(await Bun.file(resultPath(t)).exists()).toBe(true);
      expect(await readLedger(t.auditDir)).toBeNull();
    });
  });

  test("an 'escalated' result carrying deliveryError does not update the ledger (CRITICAL, post-#1675 review)", async () => {
    await withTempDir(async (dir) => {
      const t = { auditDir: join(dir, "finish-audit", "feat"), runId: "run-1" };
      await writeResult(t, {
        feature: "feat",
        status: "escalated",
        headSha: "sha-1",
        branch: "feat/x",
        deliveryError: "no forge detected",
      });

      expect(await readLedger(t.auditDir)).toBeNull();
    });
  });

  test("an 'escalated' result with NO deliveryError (delivery succeeded) still updates the ledger", async () => {
    await withTempDir(async (dir) => {
      const t = { auditDir: join(dir, "finish-audit", "feat"), runId: "run-1" };
      await writeResult(t, {
        feature: "feat",
        status: "escalated",
        headSha: "sha-1",
        branch: "feat/x",
        url: "https://example.com/pr/1",
      });

      const ledger = await readLedger(t.auditDir);
      expect(ledger?.status).toBe("escalated");
      expect(ledger?.prUrl).toBe("https://example.com/pr/1");
    });
  });
});
