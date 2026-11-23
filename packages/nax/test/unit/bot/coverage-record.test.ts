import { describe, expect, test } from "bun:test";
import {
  COVERAGE_RECORD_KEY,
  type CoverageRecord,
  parseCoverageRecord,
  recordsCodeReview,
  renderCoverageRecord,
} from "@/bot/coverage-record";
import type { PostReviewInput } from "@/bot/post";
import type { BotReviewScope } from "@/bot/review-rulings";
import { NAX_WORKFLOW_PR_MARKER, withNaxBotMarker } from "@/forge";

/** A reviewed head, as the forge reports it. */
const HEAD = "3f786850e387550fdab836ed7e6dc881de23001b";
const OTHER = "0123456789abcdef0123456789abcdef01234567";

describe("renderCoverageRecord", () => {
  test("AC-1 starts with the head and the uncovered count", () => {
    const body = renderCoverageRecord({ headSha: HEAD, uncovered: ["a.ts"] });
    expect(body.startsWith(`Review coverage at ${HEAD}: 1 required file(s) not read`)).toBe(true);
  });

  test("AC-1 lists one code-span line per uncovered file under the heading", () => {
    expect(renderCoverageRecord({ headSha: HEAD, uncovered: ["a.ts", "b.ts"] })).toBe(
      `Review coverage at ${HEAD}: 2 required file(s) not read\n- \`a.ts\`\n- \`b.ts\``,
    );
  });

  test("AC-1 renders no file lines for a review that read everything", () => {
    expect(renderCoverageRecord({ headSha: HEAD, uncovered: [] })).toBe(
      `Review coverage at ${HEAD}: 0 required file(s) not read`,
    );
  });
});

describe("parseCoverageRecord", () => {
  test("AC-2 round-trips a record with two uncovered files", () => {
    const record: CoverageRecord = { headSha: HEAD, uncovered: ["a.ts", "b.ts"] };
    expect(parseCoverageRecord(renderCoverageRecord(record))).toEqual(record);
  });

  test("AC-3 reads a record wrapped in the bot marker", () => {
    const record: CoverageRecord = { headSha: HEAD, uncovered: ["a.ts", "b.ts"] };
    const wrapped = withNaxBotMarker(renderCoverageRecord(record), COVERAGE_RECORD_KEY);
    expect(parseCoverageRecord(wrapped)).toEqual(record);
  });

  test("AC-4 round-trips an empty record", () => {
    const record: CoverageRecord = { headSha: HEAD, uncovered: [] };
    expect(parseCoverageRecord(renderCoverageRecord(record))).toEqual(record);
  });

  test("AC-5 returns null for text that is not a record", () => {
    expect(parseCoverageRecord("hello")).toBeNull();
  });

  test("returns null when the heading names fewer files than are listed", () => {
    expect(
      parseCoverageRecord(`Review coverage at ${HEAD}: 1 required file(s) not read\n- \`a.ts\`\n- \`b.ts\``),
    ).toBeNull();
  });

  test("returns null when the heading does not carry a full sha", () => {
    expect(parseCoverageRecord("Review coverage at abc1234: 1 required file(s) not read\n- `a.ts`")).toBeNull();
  });

  test("returns null when a zero-count record is followed by other text", () => {
    expect(parseCoverageRecord(`Review coverage at ${HEAD}: 0 required file(s) not read\njunk`)).toBeNull();
  });

  test("returns null when a counted record is followed by other text", () => {
    expect(parseCoverageRecord(`Review coverage at ${HEAD}: 1 required file(s) not read\n- \`a.ts\`\njunk`)).toBeNull();
  });

  test("returns null when a list is interrupted and resumed", () => {
    expect(
      parseCoverageRecord(`Review coverage at ${HEAD}: 2 required file(s) not read\n- \`a.ts\`\njunk\n- \`b.ts\``),
    ).toBeNull();
  });

  test("reads the record a later review appended after other text", () => {
    const body = withNaxBotMarker(
      `Review coverage at ${OTHER}: 1 required file(s) not read\n- \`c.ts\``,
      COVERAGE_RECORD_KEY,
    );
    expect(parseCoverageRecord(body)).toEqual({ headSha: OTHER, uncovered: ["c.ts"] });
  });

  test("reads a body that carries a Windows line ending", () => {
    expect(
      parseCoverageRecord(renderCoverageRecord({ headSha: HEAD, uncovered: ["a.ts"] }).replace(/\n/g, "\r\n")),
    ).toEqual({ headSha: HEAD, uncovered: ["a.ts"] });
  });
});

describe("COVERAGE_RECORD_KEY", () => {
  test("AC-6 names the marker key the record is posted under", () => {
    expect(COVERAGE_RECORD_KEY).toBe("w-coverage");
  });
});

describe("recordsCodeReview", () => {
  /** A trusted review of a workflow PR; only the fields this predicate reads are given real values. */
  function review(scope: BotReviewScope | undefined): PostReviewInput {
    return {
      scope,
      staticMode: false,
      ref: { forge: "github", host: "github.test", repo: "o/r", number: 7 },
      info: {
        number: 7,
        title: "PR",
        body: NAX_WORKFLOW_PR_MARKER,
        url: "url",
        state: "open",
        draft: true,
        author: { login: "writer" },
        baseRef: "main",
        headRef: "topic",
        headSha: HEAD,
        crossRepo: false,
      },
      verdict: {
        intent: "pass",
        quality: "approved",
        findings: [],
        threads: [],
        comments: [],
        cannotVerify: [],
        inspectedFiles: [],
      },
      threads: [],
      comments: [],
      own: [],
      sensitive: [],
      stateDir: "/state",
      deps: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readText: async () => null },
      cwd: "/state",
    };
  }

  test("AC-6 US-004: a rebased review of a trusted workflow PR counts as a code review", () => {
    expect(recordsCodeReview(review("rebased"))).toBe(true);
  });

  test("a conversation-only review records no coverage", () => {
    expect(recordsCodeReview(review("conversation-only"))).toBe(false);
  });

  test("a static (untrusted) review records no coverage, whatever its scope", () => {
    expect(recordsCodeReview({ ...review("rebased"), staticMode: true })).toBe(false);
  });

  test("a PR without the workflow marker records no coverage", () => {
    const input = review("rebased");
    expect(recordsCodeReview({ ...input, info: { ...input.info, body: "plain" } })).toBe(false);
  });
});
