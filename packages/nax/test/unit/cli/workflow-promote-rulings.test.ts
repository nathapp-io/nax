/** PR-ruling inputs to the workflow promote command. */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  checkOf,
  emittedJson,
  makePromoteFixture,
  PROMOTE_SHA,
  type PromoteFixtureOptions,
  prWrites,
  withTempDir,
  withWarnSpy,
} from "@test/helpers";
import { withNaxBotMarker } from "@/forge";
import { resetLogger } from "@/logger";
import { _loggerDeps, _resetDeferredWarnings } from "@/logger/logger";
import { itemKey, renderItemIndex, renderItemOpener, renderRulingEcho } from "@/workflow/item-threads";
import type { OpenItem, WorkflowResultFile } from "@/workflow/types";

const prItem = (id: string, kind: OpenItem["kind"] = "finding"): OpenItem => ({
  id,
  kind,
  issue: `${id} is broken`,
});

/** Real forge payloads keep the command-to-shared-state seam under test. */
function prRulingAnswers(
  items: readonly OpenItem[],
  options: {
    reply?: string;
    permission?: string;
    accessFails?: boolean;
    indexed?: boolean;
    owner?: string;
  } = {},
): NonNullable<PromoteFixtureOptions["onRun"]> {
  const comment = (body: string, login = options.owner ?? "nax") => ({
    databaseId: 1,
    author: { login },
    body,
    createdAt: "2026-10-13T09:12:00Z",
  });
  const nodes = items.map((item, i) => ({
    id: `thread-${i}`,
    isResolved: true,
    isOutdated: false,
    path: "src/a.ts",
    line: 3,
    originalLine: 3,
    comments: {
      nodes: [
        comment(withNaxBotMarker(renderItemOpener(item), itemKey(item))),
        comment(
          withNaxBotMarker(
            renderRulingEcho({
              itemKey: itemKey(item),
              itemId: item.id,
              disposition: "fixed",
              reason: "PR repaired",
              sha: PROMOTE_SHA,
              by: "alice",
            }),
            `wr-fixed-${itemKey(item)}`,
          ),
        ),
        ...(options.reply ? [comment("please reconsider", options.reply)] : []),
      ],
    },
  }));
  return (argv) => {
    if (argv.includes("graphql"))
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        }),
      };
    if (argv.at(-1)?.includes("/issues/7/comments?"))
      return {
        stdout: JSON.stringify(
          options.indexed === false
            ? []
            : [
                {
                  id: 9,
                  user: { login: options.owner ?? "nax" },
                  created_at: "2026-10-13T09:12:00Z",
                  body: withNaxBotMarker(renderItemIndex({ keys: items.map(itemKey) }), "w-index"),
                },
              ],
        ),
      };
    if (argv.at(-1)?.endsWith("/permission"))
      return options.accessFails
        ? { exitCode: 1, stderr: "lookup unavailable" }
        : { stdout: JSON.stringify({ permission: options.permission ?? "read" }) };
    return undefined;
  };
}

describe("nax workflow promote PR rulings", () => {
  test.each(["read", "access"] as const)(
    "F1: bare CLI preserves %s warnings on stderr without polluting JSON",
    async (failure) => {
      resetLogger();
      _resetDeferredWarnings();
      const original = { ..._loggerDeps };
      const exits: (() => void)[] = [];
      const stderr: string[] = [];
      Object.assign(_loggerDeps, {
        onExit: (handler: () => void) => exits.push(handler),
        writeStderr: (text: string) => stderr.push(text),
      });
      try {
        await withTempDir(async (dir) => {
          const fx = await makePromoteFixture(dir, {
            onRun:
              failure === "read"
                ? (argv) => (argv.includes("graphql") ? { exitCode: 1, stderr: "offline" } : undefined)
                : prRulingAnswers([prItem("B1")], { reply: "bob", accessFails: true }),
          });
          await fx.run(["--json"]);
          expect(fx.out).toHaveLength(1);
          expect(emittedJson(fx.out).prRulings).toEqual(
            failure === "read"
              ? { read: false, error: "[forge] Cannot read o/r#7: offline" }
              : { read: true, count: 0 },
          );
          expect(exits).toHaveLength(1);
          for (const flush of exits) flush();
          expect(stderr).toHaveLength(1);
          expect(stderr[0]).toContain("nax warning (workflow-promote):");
          expect(stderr[0]).toContain(failure === "read" ? "offline" : "lookup unavailable");
          if (failure === "access") expect(stderr[0]).toContain("bob");
        });
      } finally {
        _resetDeferredWarnings();
        Object.assign(_loggerDeps, original);
        resetLogger();
      }
    },
  );
  test("US-016: _run:ci remains sidecar-only even with an indexed settled echo and live green CI", async () => {
    await withTempDir(async (dir) => {
      const ci = { id: "_run:ci", kind: "ci", issue: "CI failed" } as const;
      const fx = await makePromoteFixture(dir, { openItems: [], rulings: null, onRun: prRulingAnswers([ci]) });
      const path = join(fx.runDir, "result.json");
      const result: WorkflowResultFile = await Bun.file(path).json();
      assertDefined(result.featureWorkflow, "feature record");
      await Bun.write(
        path,
        JSON.stringify({
          ...result,
          featureWorkflow: { ...result.featureWorkflow, ci: "failed", ciDetail: "CI failed" },
        }),
      );
      await fx.run(["--yes", "--json"]);
      expect(checkOf(emittedJson(fx.out), "items-ruled").passed).toBe(false);
      expect(checkOf(emittedJson(fx.out), "ci-green").passed).toBe(true);
      expect(emittedJson(fx.out).prRulings).toEqual({ read: true, count: 0 });
      expect(prWrites(fx.forgeCalls)).toEqual([]);
    });
  });

  test("US-016 AC-7: comment read failure discards an otherwise usable thread snapshot", async () => {
    await withTempDir(async (dir) => {
      const answers = prRulingAnswers([prItem("B1")]);
      const fx = await makePromoteFixture(dir, {
        rulings: null,
        onRun: (argv) =>
          argv.at(-1)?.includes("/pulls/7/reviews?") ? { exitCode: 1, stderr: "comments offline" } : answers(argv),
      });
      await fx.run(["--yes", "--json"]);
      expect(emittedJson(fx.out).prRulings).toEqual({
        read: false,
        error: "[forge] Cannot read o/r#7: comments offline",
      });
      expect(checkOf(emittedJson(fx.out), "items-ruled").passed).toBe(false);
      expect(prWrites(fx.forgeCalls)).toEqual([]);
    });
  });
  test("US-016 AC-1/8: merges local and current indexed PR rulings for checks and actions", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, {
        openItems: ["B1", "B2"],
        rulings: ["B1"],
        onRun: prRulingAnswers([prItem("B2")]),
      });
      await fx.run(["--yes", "--json"]);
      const report = emittedJson(fx.out);
      expect(checkOf(report, "items-ruled")).toEqual({ passed: true, detail: "" });
      expect(report.prRulings).toEqual({ read: true, count: 1 });
      expect(fx.codes).toEqual([0]);
      const writes = prWrites(fx.forgeCalls);
      expect(writes.map((argv) => argv[2])).toEqual(["edit", "comment", "ready"]);
      expect(writes[0]?.at(-1)).toContain("- [x] **B2**");
      expect(writes[1]?.at(-1)).toContain(`- B2 (finding) fixed: PR repaired (${PROMOTE_SHA})`);
      expect((await fx.sidecar())?.decisions).toContainEqual({
        id: "B2",
        kind: "finding",
        disposition: "fixed",
        reason: "PR repaired",
        sha: PROMOTE_SHA,
      });
    });
  });

  test("US-016 AC-2: names only ids with neither local nor PR rulings", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, {
        openItems: ["B1", "B2", "B3", "B4"],
        rulings: ["B1"],
        onRun: prRulingAnswers([prItem("B2")]),
      });
      await fx.run(["--yes", "--json"]);
      expect(checkOf(emittedJson(fx.out), "items-ruled")).toEqual({
        passed: false,
        detail: "no ruling recorded for B3, B4",
      });
      expect(prWrites(fx.forgeCalls)).toEqual([]);
    });
  });

  test.each([
    { label: "stale hash", item: { ...prItem("B2"), issue: "old text" }, options: {} },
    { label: "missing index", item: prItem("B2"), options: { indexed: false } },
    { label: "foreign owner", item: prItem("B2"), options: { owner: "imposter" } },
  ])("US-016 AC-3: rejects $label", async ({ item, options }) => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, {
        openItems: ["B1", "B2"],
        rulings: ["B1"],
        onRun: prRulingAnswers([item], options),
      });
      await fx.run(["--json"]);
      expect(checkOf(emittedJson(fx.out), "items-ruled")).toEqual({
        passed: false,
        detail: "no ruling recorded for B2",
      });
      expect(emittedJson(fx.out).prRulings).toEqual({ read: true, count: 0 });
    });
  });

  test("US-016 AC-4: local precedence applies to both tick and evidence, and used count excludes shadowed PR rulings", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { disposition: "waived", onRun: prRulingAnswers([prItem("B1")]) });
      await fx.run(["--yes", "--json"]);
      const writes = prWrites(fx.forgeCalls);
      expect(writes[0]?.at(-1)).toContain(" — waived: B1 ruled");
      expect(writes[1]?.at(-1)).toContain("- B1 (finding) waived: B1 ruled");
      expect(writes[1]?.at(-1)).not.toContain("PR repaired");
      expect(emittedJson(fx.out).prRulings).toEqual({ read: true, count: 0 });
    });
  });

  test("US-016 AC-5: maps ruling kind to advisor and retains echo disposition, reason and fixed sha", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { rulings: null, onRun: prRulingAnswers([prItem("B1", "ruling")]) });
      const path = join(fx.runDir, "result.json");
      const result: WorkflowResultFile = await Bun.file(path).json();
      assertDefined(result.featureWorkflow, "feature record");
      await Bun.write(
        path,
        JSON.stringify({
          ...result,
          featureWorkflow: {
            ...result.featureWorkflow,
            rulings: [
              {
                findingId: "B1",
                action: "hold",
                text: "hold",
                why: "confirm",
                costIfWrong: "high",
                source: "advisor",
              },
            ],
          },
        }),
      );
      await fx.run(["--yes", "--json"]);
      expect(fx.codes).toEqual([0]);
      expect(prWrites(fx.forgeCalls)[1]?.at(-1)).toContain(`- B1 (advisor) fixed: PR repaired (${PROMOTE_SHA})`);
    });
  });

  test.each([
    { permission: "read", accessFails: false, passed: true },
    { permission: "write", accessFails: false, passed: false },
    { permission: "read", accessFails: true, passed: true },
  ])("US-016 AC-6: access $permission, failure $accessFails yields ruled $passed", async (options) => {
    await withWarnSpy(async (warn) => {
      await withTempDir(async (dir) => {
        const fx = await makePromoteFixture(dir, {
          rulings: null,
          onRun: prRulingAnswers([prItem("B1")], { ...options, reply: "bob" }),
        });
        await fx.run(["--json"]);
        expect(checkOf(emittedJson(fx.out), "items-ruled").passed).toBe(options.passed);
        expect(fx.forgeCalls).toContainEqual([
          "gh",
          "api",
          "--hostname",
          "github.com",
          "repos/o/r/collaborators/bob/permission",
        ]);
        expect(emittedJson(fx.out).prRulings).toEqual({ read: true, count: options.passed ? 1 : 0 });
        if (options.accessFails)
          expect(warn).toHaveBeenCalledWith(
            "workflow-promote",
            expect.stringMatching(/Reply access lookup failed for bob; denying access: .*lookup unavailable/),
          );
      });
    });
  });

  test.each([true, false])("US-016 AC-7: PR read failure falls back to sidecar (present: %s)", async (hasSidecar) => {
    await withWarnSpy(async (warn) => {
      await withTempDir(async (dir) => {
        const fx = await makePromoteFixture(dir, {
          rulings: hasSidecar ? ["B1"] : null,
          onRun: (argv) => (argv.includes("graphql") ? { exitCode: 1, stderr: "offline" } : undefined),
        });
        await fx.run(["--yes", "--json"]);
        const report = emittedJson(fx.out);
        expect(report.prRulings).toEqual({ read: false, error: "[forge] Cannot read o/r#7: offline" });
        expect(checkOf(report, "items-ruled").passed).toBe(hasSidecar);
        expect(report.promoted).toBe(hasSidecar);
        expect(warn).toHaveBeenCalledWith(
          "workflow-promote",
          expect.stringContaining("using sidecar only: [forge] Cannot read o/r#7: offline"),
        );
      });
    });
  });
});
