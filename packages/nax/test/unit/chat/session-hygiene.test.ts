import { describe, expect, mock, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { hasHadTurn, removeIfEmpty } from "@/chat/session-hygiene";

describe("removeIfEmpty", () => {
  test("AC-18 missing metadata removes nothing and logs nothing", async () => {
    const removeMeta = mock(async () => {});
    const logger = makeLogger();
    await removeIfEmpty({
      storage: { readMeta: async () => null, removeMeta },
      logger,
      sessionId: "gone",
      history: { messages: [] },
      sentOn: new Set(),
    });
    expect(removeMeta).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("hasHadTurn", () => {
  test.each([null, "2026-10-28T01:00:00.000Z"])("uses stored updatedAt %s", (updatedAt) => {
    expect(
      hasHadTurn({
        schemaVersion: 1,
        sessionId: "s",
        cwd: "/repo",
        mode: "ask",
        model: "m",
        bashApproval: "raw",
        title: null,
        createdAt: "now",
        updatedAt,
      }),
    ).toBe(updatedAt !== null);
  });
});
