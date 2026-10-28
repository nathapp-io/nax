import { describe, expect, test } from "bun:test";
import type { ReviewSummaryInput } from "@/bot";
import * as bot from "@/bot";
import { MAX_FORGE_COMMENT_CHARS, parseNaxBotMarker, withNaxBotMarker } from "@/forge";
import type { WorkflowFindingDraft } from "@/operations/workflow-types";
import { safeCode } from "@/workflow/pr-body-safe";

const finding: WorkflowFindingDraft = { severity: "important", kind: "quality", issue: "Leaks fd" };
const reply = { id: "T1", decision: "disagree", reason: "Out of scope" } as const;
const comment = { author: "bob", verdict: { id: "C1", decision: "agree", reason: "Good point" } } as const;
function summary(overrides: Partial<ReviewSummaryInput> = {}): ReviewSummaryInput {
  return {
    headSha: "abc1234ffff",
    intent: "pass",
    quality: "approved",
    inlineFindings: 0,
    threadsAnswered: 0,
    offLine: [],
    commentVerdicts: [],
    cannotVerify: [],
    sensitive: [],
    staticMode: false,
    failed: 0,
    ...overrides,
  };
}

describe("renderReviewSummary item status", () => {
  test("US-007 AC-3 names recorded item rulings and forge logins", () => {
    const body = bot.renderReviewSummary(
      summary({
        itemStatus: {
          recorded: [
            { id: "_run:cv1", disposition: "verified", by: "alice" },
            { id: "_run:cv2", disposition: "waived", by: "bob" },
          ],
          open: 0,
          total: 2,
        },
      }),
    );
    expect(body.split("\n")).toContain(
      "Item rulings recorded: 2 (_run:cv1 verified by @alice, _run:cv2 waived by @bob).",
    );
  });
  test("US-007 AC-4 attributes null logins to nax bot and sanitizes ids", () => {
    const id = "@evil [link](https://example.com)";
    const body = bot.renderReviewSummary(
      summary({ itemStatus: { recorded: [{ id, disposition: "verified", by: null }], open: 0, total: 1 } }),
    );
    expect(body).toContain(`${bot.safeText(id, 100)} verified by nax bot`);
    expect(body).not.toContain(id);
  });
  test("US-007 AC-5 lists only the first 20 of 23 rulings", () => {
    const recorded = Array.from({ length: 23 }, (_, i) => ({
      id: `_run:cv${i + 1}`,
      disposition: "verified" as const,
      by: "alice",
    }));
    const body = bot.renderReviewSummary(summary({ itemStatus: { recorded, open: 0, total: 23 } }));
    const line = body.split("\n").find((line) => line.startsWith("Item rulings recorded"));
    expect(line).toBe(
      `Item rulings recorded: 23 (${recorded
        .slice(0, 20)
        .map(({ id }) => `${id} verified by @alice`)
        .join(", ")}, and 3 more).`,
    );
    expect(body).not.toContain("_run:cv21");
  });
  test("US-007 AC-6/7 shows open counts without an empty recorded line", () => {
    const body = bot.renderReviewSummary(summary({ itemStatus: { recorded: [], open: 1, total: 2 } }));
    expect(body.split("\n")).toContain("Open items: 1 of 2.");
    expect(body).not.toContain("Item rulings recorded");
  });
  test("US-007 AC-8 omits both lines without an index status", () => {
    const body = bot.renderReviewSummary(summary());
    expect(body).not.toContain("Item rulings recorded");
    expect(body).not.toContain("Open items:");
  });
});

describe("renderFindingComment", () => {
  test("AC-1 marks the finding identity", () => {
    expect(parseNaxBotMarker(bot.renderFindingComment(finding))).toEqual({ key: bot.findingKey(finding) });
  });
  test("AC-2 renders severity, kind and issue", () => {
    expect(bot.renderFindingComment(finding)).toContain("**Important** (quality): Leaks fd");
  });
  test("AC-3 renders a suggestion", () => {
    expect(bot.renderFindingComment({ ...finding, suggestion: "Close it" })).toContain("\n\nSuggestion: Close it");
  });
  test("AC-4 breaks issue links", () => {
    expect(bot.renderFindingComment({ ...finding, issue: "[x](http://e.com)" })).not.toContain("](");
  });
  test("sanitizes and caps both issue and suggestion", () => {
    const text = `@alice #12 [x](http://e.com) ${"z".repeat(3_000)}`;
    const body = `**Important** (quality): ${bot.safeText(text, 2_000)}\n\nSuggestion: ${bot.safeText(text, 2_000)}`;
    expect(bot.renderFindingComment({ ...finding, issue: text, suggestion: text })).toBe(
      withNaxBotMarker(body, bot.findingKey({ issue: text })),
    );
  });
});

describe("renderThreadReply", () => {
  test("US-005 AC-18: notQueued retains thread marker and adds exact paragraph", () => {
    const verdict = { id: "T1", decision: "agree", reason: "Valid" } as const;
    const body = bot.renderThreadReply(verdict, { notQueued: true });
    expect(parseNaxBotMarker(body)).toEqual({ key: bot.threadKey("T1") });
    expect(body).toBe(
      withNaxBotMarker(
        "Agree: Valid\n\nNot queued for `nax bot fix`: this thread was not opened by someone with write access.",
        bot.threadKey("T1"),
      ),
    );
  });
  test("AC-5 renders disagreement", () => {
    expect(bot.renderThreadReply(reply)).toContain("Disagree: Out of scope");
  });
  test("AC-6 marks the thread identity", () => {
    expect(parseNaxBotMarker(bot.renderThreadReply(reply))).toEqual({ key: bot.threadKey("T1") });
  });
  test("AC-7 renders handled decisions", () => {
    expect(bot.renderThreadReply({ ...reply, decision: "handled" })).toContain("Already handled: ");
  });
  test.each(["agree", "disagree", "handled"] as const)("sanitizes %s reasons", (decision) => {
    const reason = `@alice #12 [x](http://e.com) ${"z".repeat(3_000)}`;
    const label = { agree: "Agree", disagree: "Disagree", handled: "Already handled" }[decision];
    expect(bot.renderThreadReply({ ...reply, decision, reason })).toBe(
      withNaxBotMarker(`${label}: ${bot.safeText(reason, 2_000)}`, bot.threadKey(reply.id)),
    );
  });
});

describe("renderEarlierReply", () => {
  test("US-007 AC-13 marks withdrawals using the supplied thread identity", () => {
    const body = bot.renderEarlierReply({ id: "T1", status: "withdrawn", reason: "r" }, "T1");
    expect(parseNaxBotMarker(body)).toEqual({ key: bot.earlierKey("T1") });
    expect(body).toContain("Withdrawn: r");
  });
  test("US-007 AC-14 renders fixed reasons", () => {
    expect(bot.renderEarlierReply({ id: "T1", status: "fixed", reason: "r" }, "T1")).toContain("Fixed: r");
  });
  test.each(["fixed", "withdrawn"] as const)("sanitizes and caps %s reasons using the supplied thread id", (status) => {
    const reason = `@alice #12 [x](https://e.com) ${"z".repeat(3_000)}`;
    expect(bot.renderEarlierReply({ id: "verdict-id", status, reason }, "thread-id")).toBe(
      withNaxBotMarker(
        `${status === "fixed" ? "Fixed" : "Withdrawn"}: ${bot.safeText(reason, 2_000)}`,
        bot.earlierKey("thread-id"),
      ),
    );
  });
});

describe("renderReviewSummary", () => {
  test("US-015 AC-10 lists unread paths safely and omits empty coverage", () => {
    const path = "src/`odd`\nname.ts";
    const body = bot.renderReviewSummary(summary({ unreadFiles: [path, "settings.json"] }));
    expect(body).toContain(`Not read by the review: \`${safeCode(path)}\``);
    expect(body).toContain("Not read by the review: `settings.json`");
    expect(bot.renderReviewSummary(summary({ unreadFiles: [] }))).not.toContain("Not read by the review:");
    expect(bot.renderReviewSummary(summary())).not.toContain("### Review coverage");
  });
  test("US-015 bounds huge unread file lists within the forge comment budget", () => {
    const body = bot.renderReviewSummary(
      summary({
        unreadFiles: Array.from({ length: 2_000 }, (_, i) => `${i}/${"x".repeat(100)}`),
        offLine: [finding],
        cannotVerify: ["manual smoke"],
        sensitive: ["credentials.ts"],
      }),
    );
    expect(body.length).toBeLessThanOrEqual(MAX_FORGE_COMMENT_CHARS);
    expect(body).toContain("more not shown.");
    expect(body).toContain("Not read by the review: `0/");
    expect(body).toContain("Leaks fd");
    expect(body).toContain("manual smoke");
    expect(body).toContain("credentials.ts");
  });
  test("US-010 AC-6/7: minor items follow off-line findings", () => {
    const body = bot.renderReviewSummary(
      summary({ offLine: [finding], minor: [{ ...finding, severity: "minor", file: "a.ts", line: 8 }] }),
    );
    expect(body).toContain("### Minor findings\n- **Minor** `a.ts:8` Leaks fd");
    expect(body.indexOf("### Minor findings")).toBeGreaterThan(body.indexOf("### Findings not on a changed line"));
  });
  test("US-010 AC-8: renders earlier counts after the two prefix lines", () => {
    const body = bot.renderReviewSummary(summary({ earlier: { open: 1, fixed: 2, withdrawn: 0 } }));
    expect(body.split("\n")[4]).toBe("3 earlier findings re-checked: 1 still open, 2 fixed, 0 withdrawn.");
  });
  test("US-010 AC-9: omits zero earlier counts", () => {
    expect(bot.renderReviewSummary(summary({ earlier: { open: 0, fixed: 0, withdrawn: 0 } }))).not.toContain(
      "earlier findings re-checked",
    );
  });
  test.each([
    ["agents-md", "AGENTS.md"],
    ["detected", "package.json scripts"],
    ["config", ".nax/config.json"],
    ["claude-md", "CLAUDE.md"],
  ] as const)("US-010 AC-10/11: labels %s checks", (source, label) => {
    expect(
      bot.renderReviewSummary(
        summary({
          checks: {
            source,
            gates: [
              { name: "lint", command: "bun run lint" },
              { name: "test", command: ["bun run test"] },
            ],
            preRun: [],
          },
        }),
      ),
    ).toContain(`Checks (${label}): bun run lint, bun run test.`);
  });
  test("US-010 AC-12: explains missing checks", () => {
    expect(bot.renderReviewSummary(summary({ checks: { source: "none", gates: [], preRun: [] } }))).toContain(
      "No check commands found on the base branch, so nax bot fix will refuse. Add quality.commands to .nax/config.json, or list the commands in AGENTS.md or CLAUDE.md.",
    );
  });
  test.each([null, undefined])("US-010 AC-13: absent checks %s render no readiness line", (checks) => {
    const body = bot.renderReviewSummary(summary({ checks }));
    expect(body).not.toMatch(/^Checks \(/m);
    expect(body).not.toContain("No check commands found");
  });
  test("US-010 AC-14: reports install failure", () => {
    expect(bot.renderReviewSummary(summary({ preRunFailed: "npm ci" }))).toContain(
      "Install step failed (npm ci); checks may not have run.",
    );
  });
  test("review-build US-007 AC-18: reports a failed build after the install", () => {
    const body = bot.renderReviewSummary(summary({ buildFailed: "bun run build" }));
    expect(body).toContain(
      "Build step failed (bun run build); checks that import built workspace packages may not have started.",
    );
    expect(body).not.toContain("Install step failed");
  });
  test("US-010 AC-15: budgets minor items with an accurate omission notice", () => {
    const minor = Array.from({ length: 200 }, () => ({
      ...finding,
      severity: "minor" as const,
      issue: "x".repeat(1_900),
    }));
    const body = bot.renderReviewSummary(summary({ minor }));
    expect(body.length).toBeLessThanOrEqual(MAX_FORGE_COMMENT_CHARS);
    const shown = body.match(/^- \*\*Minor\*\*/gm)?.length ?? 0;
    expect(shown).toBeGreaterThan(0);
    expect(body).toContain(`… and ${200 - shown} more not shown.`);
    expect(minor).toHaveLength(200);
  });
  test("omits a line number without a file", () => {
    expect(bot.renderReviewSummary(summary({ offLine: [{ ...finding, line: 5 }] }))).toContain(
      "- **Important** Leaks fd",
    );
  });
  test("AC-8 marks the summary", () => {
    expect(parseNaxBotMarker(bot.renderReviewSummary(summary()))).toEqual({ key: "summary" });
  });
  test("AC-9 renders the abbreviated head and verdict", () => {
    expect(bot.renderReviewSummary(summary())).toContain("Review of abc1234: intent pass, quality approved.");
  });
  test("AC-10 renders posted counts", () => {
    expect(
      bot.renderReviewSummary(summary({ inlineFindings: 3, threadsAnswered: 2, commentVerdicts: [comment] })),
    ).toContain("3 inline findings, 2 threads answered, 1 comments answered.");
  });
  test("AC-11 explains static review", () => {
    expect(bot.renderReviewSummary(summary({ staticMode: true }))).toContain(
      "Untrusted PR: reviewed without running any code.",
    );
  });
  test.each([
    ".github/[click](http://evil.example/x).yml",
    ".github/@alice#12.yml",
    ".github/`[click](http://evil.example/x)`.yml",
  ])("keeps hostile path %s inside code spans in both lists", (path) => {
    const body = bot.renderReviewSummary(
      summary({
        sensitive: [path],
        offLine: [{ ...finding, file: path, line: 8 }],
      }),
    );
    expect(body).toContain(`### Sensitive paths changed\n- \`${safeCode(path)}\``);
    expect(body).toContain(`- **Important** \`${safeCode(path)}:8\` Leaks fd`);
    expect(safeCode(path)).not.toContain("`");
  });
  test("AC-12 lists sensitive paths", () => {
    expect(bot.renderReviewSummary(summary({ sensitive: [".nax/config.json"] }))).toContain(
      "### Sensitive paths changed\n- `.nax/config.json`",
    );
  });
  test("AC-13 lists off-line findings with optional locations", () => {
    expect(bot.renderReviewSummary(summary({ offLine: [finding, { ...finding, file: "a.ts", line: 8 }] }))).toContain(
      "### Findings not on a changed line\n- **Important** Leaks fd\n- **Important** `a.ts:8` Leaks fd",
    );
  });
  test("AC-14 lists top-level triage", () => {
    expect(bot.renderReviewSummary(summary({ commentVerdicts: [comment] }))).toMatch(/^- bob: Agree — Good point$/m);
  });
  test("AC-15 lists verification limitations", () => {
    expect(bot.renderReviewSummary(summary({ cannotVerify: ["No database"] }))).toContain(
      "### Could not verify\n- No database",
    );
  });
  test("AC-16 reports posting failures", () => {
    expect(bot.renderReviewSummary(summary({ failed: 2 }))).toContain(
      "Could not post 2 comments; re-run nax bot review.",
    );
  });
  const largeInput = () =>
    summary({ offLine: Array.from({ length: 5_000 }, (_, i) => ({ ...finding, issue: `Leak ${i}` })) });
  test("AC-17 bounds 5,000 findings below the real forge cap and reserve", () => {
    expect(bot.renderReviewSummary(largeInput()).length).toBeLessThanOrEqual(MAX_FORGE_COMMENT_CHARS - 512);
  });
  test("AC-18 ends the list with an accurate omitted count", () => {
    const body = bot.renderReviewSummary(largeInput());
    const shown = body.match(/^- \*\*Important\*\*/gm)?.length ?? 0;
    expect(shown).toBeGreaterThan(0);
    expect(body).toEndWith(
      `… and ${5_000 - shown} more not shown. Omitted from: Findings not on a changed line.\n\n<!-- nax-bot:v1 key=summary -->`,
    );
  });
  test("sanitizes all author text and paths in section order", () => {
    const text = `@alice #12 [x](http://e.com) ${"z".repeat(3_000)}`;
    const path = "some`path\nfile.ts";
    const body = bot.renderReviewSummary(
      summary({
        sensitive: [path],
        offLine: [{ ...finding, file: path, issue: text }],
        commentVerdicts: [{ author: text, verdict: { ...reply, reason: text } }],
        cannotVerify: [text],
        staticMode: true,
        failed: 1,
      }),
    );
    const expected = [
      "Untrusted PR:",
      `### Sensitive paths changed\n- \`${safeCode(path)}\``,
      `### Findings not on a changed line\n- **Important** \`${safeCode(path)}\` ${bot.safeText(text, 2_000)}`,
      `### Top-level comments\n- ${bot.safeText(text, 100)}: Disagree — ${bot.safeText(text, 2_000)}`,
      `### Could not verify\n- ${bot.safeText(text, 2_000)}`,
      "Could not post 1 comments;",
    ];
    let previous = -1;
    for (const section of expected) {
      const index = body.indexOf(section);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
  });
  test("omits empty optional sections and failure messages", () => {
    expect(bot.renderReviewSummary(summary())).toBe(
      withNaxBotMarker(
        "Review of abc1234: intent pass, quality approved.\n0 inline findings, 0 threads answered, 0 comments answered.",
        "summary",
      ),
    );
  });
  test("removes later lists before earlier lists without mutating input", () => {
    const input = summary({
      sensitive: ["keep.ts"],
      offLine: [finding],
      commentVerdicts: [comment],
      cannotVerify: Array.from({ length: 100 }, () => "x".repeat(2_000)),
      failed: 2,
    });
    const body = bot.renderReviewSummary(input);
    expect(body.length).toBeLessThanOrEqual(MAX_FORGE_COMMENT_CHARS - 512);
    expect(body).toContain("- `keep.ts`");
    expect(body).toContain("- **Important** Leaks fd");
    expect(body).toContain("- bob: Agree — Good point");
    const shown = body.match(/^- x+$/gm)?.length ?? 0;
    expect(body).toContain(`… and ${100 - shown} more not shown.`);
    expect(body).toContain("Could not post 2 comments;");
    expect(input.cannotVerify).toHaveLength(100);
  });
  test("drops exhausted later sections, retaining earlier path items", () => {
    const body = bot.renderReviewSummary(
      summary({
        sensitive: Array.from({ length: 1_000 }, () => "x".repeat(200)),
        offLine: [finding],
        commentVerdicts: [comment],
        cannotVerify: ["later"],
      }),
    );
    expect(body.length).toBeLessThanOrEqual(MAX_FORGE_COMMENT_CHARS - 512);
    const shown = body.match(/^- `x+`$/gm)?.length ?? 0;
    expect(shown).toBeGreaterThan(0);
    expect(body).toContain(`… and ${1_003 - shown} more not shown.`);
    expect(body).not.toContain("### Findings");
    expect(body).not.toContain("### Top-level");
    expect(body).not.toContain("### Could not verify");
    expect(parseNaxBotMarker(body)).toEqual({ key: "summary" });
  });
});

describe("renderReviewSummary CI line (nax#2631)", () => {
  test("names CI's verdict on the reviewed head", () => {
    expect(bot.renderReviewSummary(summary({ ci: { outcome: "green", detail: "CI checks: 3/3 passed" } }))).toContain(
      "CI on abc1234: green (CI checks: 3/3 passed).",
    );
  });
  test("no CI read adds no line", () => {
    expect(bot.renderReviewSummary(summary())).not.toContain("CI on");
  });
});

describe("renderReviewSummary review scope (nax#2667)", () => {
  /** The marker block precedes the summary; the summary's own first line is what a human reads first. */
  function firstLine(overrides: Partial<ReviewSummaryInput>): string {
    const body = bot.renderReviewSummary(summary(overrides));
    return (body.slice(body.indexOf("Review of")).split("\n")[0] ?? "").trim();
  }
  test("AC-11 states an incremental review and its since sha", () => {
    expect(firstLine({ scope: "incremental", incrementalSince: "def5678aaaa" })).toBe(
      "Review of abc1234 (incremental since def5678): intent pass, quality approved.",
    );
  });
  test("AC-12 states a conversation-only review", () => {
    expect(firstLine({ scope: "conversation-only" })).toStartWith("Review of abc1234 (conversation only): intent");
  });
  test("AC-13 keeps the plain head line for a full review", () => {
    expect(firstLine({ scope: "full" })).toStartWith("Review of abc1234: intent");
  });
  test("keeps the first line plain when the scope is absent", () => {
    expect(firstLine({})).toBe("Review of abc1234: intent pass, quality approved.");
  });
});
