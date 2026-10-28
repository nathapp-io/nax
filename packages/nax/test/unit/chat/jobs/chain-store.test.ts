import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  _chainStoreDeps,
  chainsDir,
  createChainRecord,
  newChainId,
  readChainRecord,
  writeChainRecord,
} from "@/chat/jobs/chain-store";
import {
  CHAIN_CHECK_MAX_LENGTH,
  CHAIN_ID_PATTERN,
  CHAIN_MAX_STEPS,
  CHAIN_PR_PLACEHOLDER,
  type ChatChain,
} from "@/chat/jobs/chain-types";
import { NaxError } from "@/errors";

let dir: string;
const originalDeps = { ..._chainStoreDeps };
beforeEach(() => {
  dir = makeTempDir("chat-chains-");
});
afterEach(() => {
  Object.assign(_chainStoreDeps, originalDeps);
  cleanupTempDir(dir);
});
function chain(overrides: Partial<ChatChain> = {}): ChatChain {
  return {
    schemaVersion: 1,
    id: "chain-1a2b3c4d",
    sessionId: "session-1",
    cwd: dir,
    steps: [
      {
        kind: "bot_review",
        argv: ["nax", "bot", "review", "<pr>"],
        prIndex: 3,
        target: "",
        checkBefore: "verify",
        check: { passed: true, note: "verified", at: "2026-10-01T00:00:00Z" },
        jobId: "bot_review-12345678",
      },
    ],
    costCap: 10,
    pr: 12,
    approvedAt: "2026-10-01T00:00:00Z",
    state: "active",
    ...overrides,
  };
}
describe("chainsDir", () => {
  test("AC-1 joins output directory", () => {
    expect(chainsDir("/o")).toBe("/o/chat-chains");
  });
});
describe("newChainId", () => {
  test("AC-2 uses injectable random hex", () => {
    _chainStoreDeps.randomHex = () => "1a2b3c4d";
    expect(newChainId()).toBe("chain-1a2b3c4d");
  });
  test("generates a valid id by default", () => {
    expect(CHAIN_ID_PATTERN.test(newChainId())).toBe(true);
  });
});
describe("chain constants", () => {
  test("AC-3 rejects traversal", () => {
    expect(CHAIN_ID_PATTERN.test("chain-../../x")).toBe(false);
  });
  test("exposes workflow limits", () => {
    expect(CHAIN_MAX_STEPS).toBe(6);
    expect(CHAIN_CHECK_MAX_LENGTH).toBe(200);
    expect(CHAIN_PR_PLACEHOLDER).toBe("<pr>");
  });
});
describe("writeChainRecord", () => {
  test("failed temp cleanup cannot reject an already committed exclusive publication", async () => {
    _chainStoreDeps.unlink = () => {
      throw new NaxError("cleanup failed", "TEST_FAILURE", { stage: "test" });
    };
    expect(await createChainRecord(dir, chain())).toBe(true);
    expect(await readChainRecord(dir, chain().id)).toEqual(chain());
    expect(readdirSync(chainsDir(dir))).toHaveLength(2);
  });
  test("AC-4 round trips full record", async () => {
    const record = chain();
    await writeChainRecord(dir, record);
    expect(await readChainRecord(dir, record.id)).toEqual(record);
  });
  test("AC-5 replaces existing record with stopped state", async () => {
    await writeChainRecord(dir, chain());
    const updated = chain({ state: "stopped", stopReason: "user", endedAt: "2026-10-02T00:00:00Z" });
    await writeChainRecord(dir, updated);
    expect(await readChainRecord(dir, updated.id)).toEqual(updated);
  });
  test("AC-6 publishes complete temp file by rename and leaves exactly one entry", async () => {
    let renamed = false;
    _chainStoreDeps.rename = (from, to) => {
      expect(from).not.toBe(to);
      expect(statSync(from).size).toBeGreaterThan(0);
      expect(readdirSync(chainsDir(dir))).not.toContain(`${chain().id}.json`);
      renamed = true;
      return originalDeps.rename(from, to);
    };
    await writeChainRecord(dir, chain());
    expect(renamed).toBe(true);
    expect(readdirSync(chainsDir(dir))).toEqual([`${chain().id}.json`]);
  });
  test("AC-7 rejects unsafe id before creating any files", async () => {
    const promise = writeChainRecord(dir, chain({ id: "../x" }));
    await expect(promise).rejects.toBeInstanceOf(NaxError);
    await expect(promise).rejects.toMatchObject({ code: "CHAT_CHAIN_INVALID_ID", context: { stage: "chat" } });
    expect(readdirSync(dir)).toEqual([]);
  });
  test("AC-8 wraps rejected write and removes partially written temp file", async () => {
    const cause = new NaxError("test write failure", "TEST_FAILURE", { stage: "test" });
    _chainStoreDeps.randomUUID = () => "partial-write";
    _chainStoreDeps.write = async () => {
      await Bun.write(join(chainsDir(dir), `${chain().id}.partial-write.tmp`), "partial");
      throw cause;
    };
    const promise = writeChainRecord(dir, chain());
    await expect(promise).rejects.toBeInstanceOf(NaxError);
    await expect(promise).rejects.toMatchObject({ code: "CHAT_CHAIN_WRITE_FAILED", context: { stage: "chat", cause } });
    expect(readdirSync(chainsDir(dir))).toEqual([]);
  });
  test("preserves old record on rename failure", async () => {
    await writeChainRecord(dir, chain());
    _chainStoreDeps.rename = () => {
      throw new NaxError("rename failed", "TEST_FAILURE", { stage: "test" });
    };
    await expect(writeChainRecord(dir, chain({ state: "stopped" }))).rejects.toMatchObject({
      code: "CHAT_CHAIN_WRITE_FAILED",
    });
    expect(await readChainRecord(dir, chain().id)).toEqual(chain());
    expect(readdirSync(chainsDir(dir))).toEqual([`${chain().id}.json`]);
  });
});
describe("readChainRecord", () => {
  test("AC-9 returns null for missing file", async () => {
    expect(await readChainRecord(dir, "chain-1a2b3c4d")).toBeNull();
  });
  test("AC-10 returns null for malformed JSON", async () => {
    await Bun.write(join(chainsDir(dir), "chain-1a2b3c4d.json"), "not json");
    expect(await readChainRecord(dir, "chain-1a2b3c4d")).toBeNull();
  });
  test.each([{ value: null }, { value: [] }, { value: { schemaVersion: 2 } }, { value: { state: "unknown" } }])(
    "rejects malformed shape %j",
    async ({ value }) => {
      await Bun.write(join(chainsDir(dir), "chain-1a2b3c4d.json"), JSON.stringify(value));
      expect(await readChainRecord(dir, "chain-1a2b3c4d")).toBeNull();
    },
  );
  test("rejects unsafe read ids without accessing disk", async () => {
    let read = false;
    _chainStoreDeps.file = () => {
      read = true;
      throw new NaxError("unexpected read", "TEST_FAILURE", { stage: "test" });
    };
    expect(await readChainRecord(dir, "../x")).toBeNull();
    expect(read).toBe(false);
  });
});
