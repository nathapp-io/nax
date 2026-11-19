import { describe, expect, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import { nameWaiverInSummary, readinessLines } from "@/bot/ci-waiver-ready";
import { CHAIN_HEADING } from "@/bot/convergence-summary";
import { type BotPushEntry, pushRecordBody, readPushLedger, withPushLedger } from "@/bot/push-ledger";
import { MAX_FORGE_COMMENT_CHARS, type PrComment, withNaxBotMarker } from "@/forge";

const sha = (index: number): string => index.toString(16).padStart(40, "0");

function entry(index: number): BotPushEntry {
  const items = Array.from({ length: 20 }, (_unused, item) => ({
    key: `k-${index}-${item}`,
    generation: 0,
    issue: "z".repeat(100),
  }));
  return { base: sha(index - 1), sha: sha(index), at: "2026-01-01T00:00:00.000Z", items };
}

/** A summary whose chain section is `bulletChars` long, ending with the block the old write kept. */
function summary(bulletChars: number, ledger: readonly BotPushEntry[], unreadableBlock?: string): string {
  const bullets = Array.from(
    { length: Math.ceil(bulletChars / 100) },
    (_unused, index) => `- f-${index} ${"c".repeat(90)}`,
  );
  const text = [
    "Pushed abcdef1.",
    "nax bot fix pushes on this PR: 1",
    CHAIN_HEADING,
    ...bullets,
    "Kept as draft: waiting",
  ].join("\n");
  const marked = withNaxBotMarker(text, "fix-summary");
  return unreadableBlock === undefined
    ? withPushLedger(marked, ledger)
    : marked.replace("<!-- nax-bot:v1", `${unreadableBlock}\n<!-- nax-bot:v1`);
}

function comment(id: string, body: string): PrComment {
  return { id, kind: "comment", author: makeBotFixEnv().user.login, body, createdAt: "" };
}

async function rewrite(body: string, records: readonly BotPushEntry[]): Promise<string> {
  const env = makeBotFixEnv();
  const comments = [
    comment("1", body),
    ...records.map((record, index) => comment(`r${index}`, pushRecordBody(record))),
  ];
  let written = "";
  await nameWaiverInSummary({
    env,
    lines: readinessLines({ markedReady: false, ciWaived: { checks: ["lint"], reason: "no runner" } }),
    list: async () => comments,
    edit: async (_ref, _comment, next) => {
      written = next;
    },
  });
  return written;
}

describe("nameWaiverInSummary size budget (B14)", () => {
  test("a near-limit summary whose ledger grows on the merge is trimmed to fit, chain text first", async () => {
    const records = [1, 2, 3, 4, 5].map(entry);
    const original = summary(MAX_FORGE_COMMENT_CHARS - 12_000, [entry(5)]);
    expect(original.length).toBeLessThan(MAX_FORGE_COMMENT_CHARS);
    const body = await rewrite(original, records);
    expect(body.length).toBeLessThanOrEqual(MAX_FORGE_COMMENT_CHARS);
    expect(body).toContain("Marked ready with a CI waiver");
    expect(readPushLedger(body).entries.map(({ sha: s }) => s)).toEqual(records.map(({ sha: s }) => s));
    expect(body.split("\n").filter((line) => line.startsWith("- f-")).length).toBeLessThan(
      original.split("\n").filter((line) => line.startsWith("- f-")).length,
    );
  });

  test("a summary that already fits is rewritten with its chain text intact", async () => {
    const original = summary(2_000, [entry(1)]);
    const body = await rewrite(original, [entry(1)]);
    expect(body).toContain(CHAIN_HEADING);
    expect(body.split("\n").filter((line) => line.startsWith("- f-"))).toHaveLength(20);
  });

  test("an unreadable ledger block is preserved while the chain text is trimmed to fit", async () => {
    const broken = "<!-- nax-bot:pushes v1 not-base64! -->";
    const original = summary(MAX_FORGE_COMMENT_CHARS - 100, [], broken);
    const body = await rewrite(original, []);
    expect(body).toContain(broken);
    expect(body.length).toBeLessThanOrEqual(MAX_FORGE_COMMENT_CHARS);
    expect(body).toContain("Marked ready with a CI waiver");
  });
});
