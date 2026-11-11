/**
 * US-012 (branch-review-coverage): the pure credit helper. A `verified` ruling names the files a
 * collaborator read at a commit; anything that commit has not changed since needs no second read.
 * Every decision below is the helper's alone — `runPrReview` only supplies `required` and the git
 * comparison, so the rules are pinned here.
 */
import { describe, expect, test } from "bun:test";
import { creditedFiles } from "@/bot/coverage-credit";
import type { BotSettledRuling } from "@/prompts";

const base = { id: "item-1", kind: "cannot-verify", issue: "coverage gap", reason: "read all of it" } as const;

function verified(
  fields: { readonly id?: string; readonly files?: readonly string[]; readonly sha?: string } = {},
): BotSettledRuling {
  return {
    ...base,
    disposition: "verified",
    ...(fields.id !== undefined && { id: fields.id }),
    ...(fields.files !== undefined && { files: fields.files }),
    ...(fields.sha !== undefined && { sha: fields.sha }),
  };
}

/** A `changedSince` that answers per sha and records every call, in order. */
function gitLog(changed: Record<string, readonly string[] | null>): {
  readonly calls: string[];
  readonly changedSince: (sha: string) => Promise<readonly string[] | null>;
} {
  const calls: string[] = [];
  return {
    calls,
    changedSince: async (sha: string) => {
      calls.push(sha);
      return Object.hasOwn(changed, sha) ? (changed[sha] ?? null) : [];
    },
  };
}

const never = async (): Promise<readonly string[] | null> => [];

describe("creditedFiles", () => {
  test("AC-1 credits every listed file when none changed since the sha", async () => {
    expect(
      await creditedFiles({
        settled: [verified({ files: ["a.ts", "b.ts"], sha: "S" })],
        required: ["a.ts", "b.ts", "c.ts"],
        changedSince: never,
      }),
    ).toEqual(["a.ts", "b.ts"]);
  });

  test("AC-2 credits only the listed files the sha has not changed", async () => {
    expect(
      await creditedFiles({
        settled: [verified({ files: ["a.ts", "b.ts"], sha: "S" })],
        required: ["a.ts", "b.ts", "c.ts"],
        changedSince: async () => ["b.ts"],
      }),
    ).toEqual(["a.ts"]);
  });

  test("AC-3 credits nothing when the comparison itself fails", async () => {
    expect(
      await creditedFiles({
        settled: [verified({ files: ["a.ts", "b.ts"], sha: "S" })],
        required: ["a.ts", "b.ts"],
        changedSince: async () => null,
      }),
    ).toEqual([]);
  });

  test("AC-4 credits nothing for a verified ruling that names no commit", async () => {
    const { calls, changedSince } = gitLog({});
    expect(await creditedFiles({ settled: [verified({ files: ["a.ts"] })], required: ["a.ts"], changedSince })).toEqual(
      [],
    );
    expect(calls).toEqual([]);
  });

  test("AC-5 credits nothing for a waived ruling, whatever it lists", async () => {
    const waived: BotSettledRuling = { ...base, disposition: "waived", files: ["a.ts"], sha: "S" };
    expect(await creditedFiles({ settled: [waived], required: ["a.ts"], changedSince: never })).toEqual([]);
  });

  test("AC-6 drops a ruling's file the review does not require", async () => {
    expect(
      await creditedFiles({
        settled: [verified({ files: ["a.ts", "elsewhere.ts"], sha: "S" })],
        required: ["a.ts"],
        changedSince: never,
      }),
    ).toEqual(["a.ts"]);
  });

  test("AC-7 unions two rulings in required order", async () => {
    expect(
      await creditedFiles({
        settled: [verified({ files: ["c.ts"], sha: "S1" }), verified({ id: "item-2", files: ["a.ts"], sha: "S2" })],
        required: ["a.ts", "b.ts", "c.ts"],
        changedSince: never,
      }),
    ).toEqual(["a.ts", "c.ts"]);
  });

  test("AC-8 compares once per distinct sha and never without one", async () => {
    const { calls, changedSince } = gitLog({ S: [] });
    const credited = await creditedFiles({
      settled: [
        verified({ files: ["a.ts"], sha: "S" }),
        verified({ id: "item-2", files: ["b.ts"], sha: "S" }),
        verified({ id: "item-3", files: ["c.ts"] }),
        verified({ id: "item-4", sha: "S2" }),
      ],
      required: ["a.ts", "b.ts", "c.ts", "d.ts"],
      changedSince,
    });
    expect(calls).toEqual(["S"]);
    expect(credited).toEqual(["a.ts", "b.ts"]);
  });

  test("AC-19 credits nothing for a verified ruling with a sha but no files", async () => {
    expect(await creditedFiles({ settled: [verified({ sha: "S" })], required: ["a.ts"], changedSince: never })).toEqual(
      [],
    );
  });

  test("returns no credit when there are no rulings or nothing is required", async () => {
    expect(await creditedFiles({ settled: [], required: ["a.ts"], changedSince: never })).toEqual([]);
    expect(
      await creditedFiles({ settled: [verified({ files: ["a.ts"], sha: "S" })], required: [], changedSince: never }),
    ).toEqual([]);
  });
});
