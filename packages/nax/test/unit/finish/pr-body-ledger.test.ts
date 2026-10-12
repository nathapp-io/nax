/**
 * Finish A 7: the PR body's findings table, Set aside / Stops sections, escaping and size caps.
 */
import { describe, expect, test } from "bun:test";
import type { Finding, FinishPrContext, FinishPrStory, LedgerEntry } from "@/finish";
import { buildFinishBody } from "@/finish";

const story = (over: Partial<FinishPrStory> = {}): FinishPrStory => ({
  id: "US-001",
  title: "Wire header",
  acCount: 3,
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "HIGH",
  title: "Spec mismatch",
  problem: "p",
  fix: "f",
  ...over,
});

const baseCtx = (over: Partial<FinishPrContext> = {}): FinishPrContext => ({
  feature: "auto-pr-plugin",
  stories: [],
  outOfScope: [],
  gatesRan: [],
  rounds: [],
  run: {},
  title: "feat: auto-pr-plugin",
  ...over,
});

describe("findings table, Set aside and Stops (finish A 7)", () => {
  const unresolvedBase = {
    reason: "r",
    findings: [],
    acceptance: "green" as const,
    gates: [],
    missing: [],
    unreviewed: [],
    accepted: [],
    ledger: [],
    stops: [],
    handoffs: [],
  };
  const e = (title: string, severity: Finding["severity"], state: LedgerEntry["state"], ref?: string): LedgerEntry => ({
    id: title,
    finding: { severity, title, problem: "p", fix: "f", file: "src/x|y.ts" },
    state,
    ...(ref ? { ref } : {}),
  });
  const handoff = (over: Record<string, unknown> = {}) => ({
    n: 1,
    dir: "/o/finish-audit/feat/run-1.handoff-1",
    phase: "review" as const,
    limit: "fix" as const,
    baseSha: "s",
    headSha: "s",
    findingIds: ["a", "b", "c"],
    newUntracked: [],
    changedPaths: [],
    stoppedAt: "t",
    hasNote: true,
    patchSaved: true,
    restored: true,
    consumed: false,
    reapplied: false,
    untrackedRestored: [],
    untrackedMovedAside: ["big.md"],
    untrackedFailed: [],
    ...over,
  });

  test("one table sorted by state then severity; resolved rows collapsed", () => {
    const body = buildFinishBody(
      baseCtx({
        unresolved: {
          ...unresolvedBase,
          ledger: [
            e("fixed one", "HIGH", "fixed-unreviewed", "68e7c2189abc"),
            e("open low", "LOW", "open"),
            e("open high", "HIGH", "open"),
            e("waived one", "MEDIUM", "waived", "D-2"),
          ],
        },
      }),
    );
    const table = body.slice(body.indexOf("| Severity |"));
    expect(table.indexOf("open high")).toBeLessThan(table.indexOf("open low"));
    expect(table.indexOf("open low")).toBeLessThan(table.indexOf("fixed one"));
    expect(body).toContain("`68e7c21`");
    expect(body).toContain("src/x\\|y.ts");
    expect(body).toMatch(/<details>[\s\S]*waived one[\s\S]*D-2[\s\S]*<\/details>/);
  });

  test("states sort open, rejected, set-aside, unresolved, fixed-unreviewed, accepted", () => {
    const states: LedgerEntry["state"][] = [
      "accepted",
      "fixed-unreviewed",
      "unresolved",
      "set-aside",
      "rejected",
      "open",
    ];
    const body = buildFinishBody(
      baseCtx({ unresolved: { ...unresolvedBase, ledger: states.map((s) => e(`t-${s}`, "HIGH", s)) } }),
    );
    const order = ["open", "rejected", "set-aside", "unresolved", "fixed-unreviewed", "accepted"].map((s) =>
      body.indexOf(`t-${s}`),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("LLM-sourced cell text cannot break the table or the details block", () => {
    const hostile: LedgerEntry = {
      id: "h",
      finding: { severity: "HIGH", title: "a </details> `x`\n| b", problem: "p", fix: "f", file: "f`<b>.ts" },
      state: "open",
    };
    const done: LedgerEntry = {
      ...hostile,
      id: "h2",
      finding: { ...hostile.finding, title: "z </details>" },
      state: "waived",
    };
    const body = buildFinishBody(baseCtx({ unresolved: { ...unresolvedBase, ledger: [hostile, done] } }));
    expect(body.match(/<\/details>/g)).toHaveLength(1);
    const rows = body.split("\n").filter((l) => l.startsWith("| HIGH"));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).not.toMatch(/(?<!\\)`|<b>/);
  });

  test("lists set-aside handoffs and stops", () => {
    const body = buildFinishBody(
      baseCtx({
        unresolved: {
          ...unresolvedBase,
          stops: [{ kind: "fix", phase: "review", at: "t", limitMs: 1_200_000, handoff: 1, findings: 3 }],
          handoffs: [handoff()],
        },
      }),
    );
    expect(body).toContain("### Set aside");
    expect(body).toContain("run-1.handoff-1/changes.patch");
    expect(body).toContain("not re-applied");
    expect(body).toContain("moved into the handoff: big.md");
    expect(body).toContain("### Stops");
    expect(body).toContain("fix session stopped at the 20 min limit (3 findings, handoff-1)");
  });

  test("surfaces restore failures and user files that could not be put back", () => {
    const body = buildFinishBody(
      baseCtx({
        unresolved: {
          ...unresolvedBase,
          handoffs: [handoff({ restored: false, untrackedFailed: ["notes.md"], untrackedMovedAside: [] })],
        },
      }),
    );
    expect(body).toContain("worktree restore failed");
    expect(body).toContain("could not be put back: notes.md");
  });

  test("a handoff whose session had committed says so in one line", () => {
    const body = buildFinishBody(
      baseCtx({ unresolved: { ...unresolvedBase, handoffs: [handoff({ headMoved: true })] } }),
    );
    expect(body).toContain("the session had committed; those commits were kept");
  });

  test("a re-applied and consumed handoff reads as committed", () => {
    const body = buildFinishBody(
      baseCtx({ unresolved: { ...unresolvedBase, handoffs: [handoff({ consumed: true, reapplied: true })] } }),
    );
    expect(body).toContain("re-applied and committed");
  });

  test("pre-v3 results with an empty ledger keep the old open-findings list", () => {
    const body = buildFinishBody(
      baseCtx({ unresolved: { ...unresolvedBase, findings: [finding({ title: "legacy" })] } }),
    );
    expect(body).toContain("### Open findings");
    expect(body).not.toContain("| Severity |");
  });

  test("a not-run gate renders as 'Gates did not run', never as a red gate named gates", () => {
    const body = buildFinishBody(
      baseCtx({ unresolved: { ...unresolvedBase, gates: [{ name: "gates", status: "not-run" }] } }),
    );
    expect(body).toContain("Gates did not run");
    expect(body).not.toContain("Gate `gates` is red");
  });

  test("an accepted finding is listed once, in the table, not again under 'Accepted by the advisor'", () => {
    const accepted = e("took it", "HIGH", "accepted", "advisor approval");
    const body = buildFinishBody(
      baseCtx({ unresolved: { ...unresolvedBase, ledger: [accepted], accepted: [accepted.finding] } }),
    );
    expect(body.match(/took it/g)).toHaveLength(1);
    expect(body).not.toContain("Accepted by the advisor");
    expect(body).toContain("| accepted | advisor approval |");
  });

  test("a cleared finding is listed once, folded under 'resolved' with its ref", () => {
    const cleared = e("gone", "MEDIUM", "cleared", "not re-raised by full round 2");
    const body = buildFinishBody(
      baseCtx({ unresolved: { ...unresolvedBase, ledger: [cleared, e("live", "LOW", "open")] } }),
    );
    expect(body.match(/gone/g)).toHaveLength(1);
    expect(body).toContain("| cleared | not re-raised by full round 2 |");
    expect(body.indexOf("1 resolved")).toBeLessThan(body.indexOf("gone"));
    expect(body.indexOf("live")).toBeLessThan(body.indexOf("1 resolved"));
  });

  test("handoff dir, moved file names and the sha ref are escaped", () => {
    const body = buildFinishBody(
      baseCtx({
        unresolved: {
          ...unresolvedBase,
          handoffs: [handoff({ dir: "/o/`x`</details>\nrun", untrackedMovedAside: ["a`<b>.md", "c\nd"] })],
          ledger: [e("t", "LOW", "fixed-unreviewed", "ab`c</details>")],
        },
      }),
    );
    expect(body).not.toContain("</details>");
    expect(body).not.toContain("<b>");
    expect(body).toContain("a'&lt;b&gt;.md, c d");
    expect(body).toContain("/o/'x'&lt;/details&gt; run/changes.patch");
    expect(body).toContain("ab\\`c&lt;/d |");
  });

  test("a non-consumed handoff reads as not re-applied even when its reapplied flag is unset", () => {
    const { reapplied: _drop, ...bare } = handoff();
    const body = buildFinishBody(baseCtx({ unresolved: { ...unresolvedBase, handoffs: [bare] } }));
    expect(body).toContain("set aside, not re-applied");
    expect(body).not.toContain("pending");
  });

  test("unknown state or severity values sort last instead of throwing", () => {
    const odd = { id: "o", finding: { severity: "WEIRD", title: "odd one", problem: "p", fix: "f" }, state: "mystery" };
    const ledger = JSON.parse(JSON.stringify([odd, e("normal", "LOW", "open")]));
    const body = buildFinishBody(baseCtx({ unresolved: { ...unresolvedBase, ledger } }));
    expect(body.indexOf("normal")).toBeLessThan(body.indexOf("odd one"));
  });

  test("a huge ledger stays under the forge limit with caps and an overflow note", () => {
    const big = Array.from({ length: 5000 }, (_, i) => e(`finding ${i} ${"x".repeat(5000)}`, "HIGH", "open"));
    const resolved = Array.from({ length: 300 }, (_, i) => e(`done ${i}`, "LOW", "fixed-reviewed", "abcdef1234"));
    const body = buildFinishBody(
      baseCtx({
        narrative: "n".repeat(100),
        stories: Array.from({ length: 4000 }, (_, i) => story({ id: `US-${i}`, title: "t".repeat(100) })),
        unresolved: { ...unresolvedBase, ledger: [...big, ...resolved] },
      }),
    );
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("4950 more - see result.json");
    expect(body).toContain("250 more - see result.json");
    expect(body).toContain("section(s) omitted to fit the forge's size limit");
    expect(body).toContain("| HIGH | finding 0 ");
    expect(body).not.toContain("x".repeat(300));
  });

  test("a very long handoff dir is capped", () => {
    const body = buildFinishBody(
      baseCtx({ unresolved: { ...unresolvedBase, handoffs: [handoff({ dir: `/o/${"d".repeat(1000)}` })] } }),
    );
    expect(body).not.toContain("d".repeat(300));
  });

  test("a body still over budget after dropping sections is cut at the budget", () => {
    const body = buildFinishBody(baseCtx({ narrative: "n".repeat(70_000) }));
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("body truncated");
  });

  test("a long handoff list is capped with a note", () => {
    const many = Array.from({ length: 80 }, (_, i) => handoff({ n: i + 1 }));
    const body = buildFinishBody(baseCtx({ unresolved: { ...unresolvedBase, handoffs: many } }));
    expect(body).toContain("30 more - see result.json");
  });
});

describe("table cell escaping (finish A 7)", () => {
  test("a story title with a backtick, tag or pipe stays one inert cell", () => {
    const body = buildFinishBody(baseCtx({ stories: [story({ id: "US-9", title: "a|b `c` <i>d</i>\ne" })] }));
    expect(body).toContain("| US-9 | a\\|b \\`c\\` &lt;i&gt;d&lt;/i&gt; e | 3 |");
  });
});

describe("size budget and the last-resort cut (finish A 7)", () => {
  const unresolvedBase = {
    reason: "r",
    findings: [],
    acceptance: "green" as const,
    gates: [],
    missing: [],
    unreviewed: [],
    accepted: [],
    ledger: [],
    stops: [],
    handoffs: [],
  };
  const row = (title: string, state: LedgerEntry["state"], ref?: string): LedgerEntry => ({
    id: `${state}-${title.slice(0, 20)}`,
    finding: { severity: "HIGH", title, problem: "p", fix: "f", file: "src/a.ts" },
    state,
    ...(ref ? { ref } : {}),
  });
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const wellFormed = (body: string): void => {
    expect(body.length).toBeLessThan(65_536);
    expect(body.match(/<details>/g)?.length ?? 0).toBe(body.match(/<\/details>/g)?.length ?? 0);
    expect((body.match(/```/g)?.length ?? 0) % 2).toBe(0);
    for (const line of body.split("\n")) if (line.startsWith("| ")) expect(line.endsWith(" |")).toBe(true);
    expect(LONE.test(body)).toBe(false);
  };
  const hostileTitle = (i: number): string => `${i} <${"😀".repeat(40)}>${"<".repeat(150)}`;

  test("many escaped resolved rows: under the limit, details balanced, no row cut mid-cell, pairs intact", () => {
    const ledger = [
      ...Array.from({ length: 10 }, (_, i) => row(hostileTitle(i), "open")),
      ...Array.from({ length: 60 }, (_, i) => row(hostileTitle(i + 100), "fixed-reviewed", "abcdef1")),
    ];
    const body = buildFinishBody(
      baseCtx({
        unresolved: {
          ...unresolvedBase,
          ledger,
          stops: [{ kind: "fix", phase: "review", at: "t", limitMs: 1_200_000, handoff: 1, findings: 3 }],
        },
      }),
    );
    wellFormed(body);
    expect(body).toContain("### Stops");
    expect(body).toContain("<details>");
  });

  test("60 live rows: the resolved block, Set aside and Stops survive (tighter caps, with notes)", () => {
    const ledger = [
      ...Array.from({ length: 60 }, (_, i) => row(hostileTitle(i), "open")),
      ...Array.from({ length: 60 }, (_, i) => row(hostileTitle(i + 100), "waived", "D-1")),
    ];
    const handoffs = [
      {
        n: 1,
        dir: "/o/run-1.handoff-1",
        phase: "review" as const,
        limit: "fix" as const,
        baseSha: "s",
        headSha: "s",
        findingIds: [],
        newUntracked: [],
        changedPaths: [],
        stoppedAt: "t",
        hasNote: false,
        patchSaved: true,
        restored: true,
        consumed: false,
        untrackedRestored: [],
        untrackedMovedAside: [],
        untrackedFailed: [],
      },
    ];
    const body = buildFinishBody(
      baseCtx({
        narrative: "n",
        unresolved: {
          ...unresolvedBase,
          ledger,
          handoffs,
          stops: [{ kind: "fix", phase: "review", at: "t", limitMs: 1_200_000, handoff: 1, findings: 3 }],
        },
      }),
    );
    wellFormed(body);
    expect(body).toContain("### Set aside");
    expect(body).toContain("### Stops");
    expect(body).toContain("</details>");
    expect(body).toContain("more - see result.json");
  });

  test("huge handoff lists tighten the caps instead of losing Stops or the table", () => {
    const handoff = (n: number) => ({
      n,
      dir: `/o/run-1.handoff-${n}`,
      phase: "review" as const,
      limit: "fix" as const,
      baseSha: "s",
      headSha: "s",
      findingIds: [],
      newUntracked: [],
      changedPaths: [],
      stoppedAt: "t",
      hasNote: false,
      patchSaved: true,
      restored: true,
      consumed: false,
      untrackedRestored: [],
      untrackedMovedAside: Array.from({ length: 30 }, (_, i) => `${"<".repeat(60)}${n}-${i}.md`),
      untrackedFailed: [],
    });
    const body = buildFinishBody(
      baseCtx({
        unresolved: {
          ...unresolvedBase,
          ledger: [row("keep me", "open"), ...Array.from({ length: 49 }, (_, i) => row(hostileTitle(i), "open"))],
          handoffs: Array.from({ length: 50 }, (_, i) => handoff(i + 1)),
          stops: [{ kind: "fix", phase: "review", at: "t", limitMs: 1_200_000, handoff: 1, findings: 3 }],
        },
      }),
    );
    wellFormed(body);
    expect(body).toContain("keep me");
    expect(body).toContain("### Stops");
    expect(body).toContain("more - see result.json");
    expect(body.match(/- handoff-/g)?.length ?? 0).toBeLessThan(50);
  });

  test("dropping lower sections says so", () => {
    const body = buildFinishBody(
      baseCtx({
        narrative: "n",
        stories: Array.from({ length: 3000 }, (_, i) => story({ id: `US-${i}`, title: "t".repeat(150) })),
      }),
    );
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("1 section(s) omitted");
    expect(body).not.toContain("US-2999");
  });

  test("the final cut lands on a line boundary, closes an open details block and keeps pairs whole", () => {
    const narrative = `<details>\n${Array.from({ length: 700 }, () => "😀".repeat(50)).join("\n")}`;
    const body = buildFinishBody(baseCtx({ narrative }));
    wellFormed(body);
    expect(body).toContain("body truncated");
    expect(body).toContain("</details>");
    // every kept narrative line is whole (50 emoji = 100 UTF-16 units): the cut was on a line boundary
    for (const line of body.split("\n")) if (line.includes("😀")) expect(line.length).toBe(100);
  });

  test("a hostile severity or state prints through the escape helper", () => {
    const odd = JSON.parse(
      JSON.stringify({
        id: "o",
        finding: { severity: "HI|`<b>`", title: "t", problem: "p", fix: "f" },
        state: "st|`<i>`",
      }),
    );
    const body = buildFinishBody(baseCtx({ unresolved: { ...unresolvedBase, ledger: [odd] } }));
    expect(body).not.toContain("<b>");
    expect(body).not.toContain("<i>");
    expect(body).toContain("| HI\\|\\`&lt;b&gt;\\` |");
    expect(body).toContain("st\\|\\`&lt;i&gt;\\`");
  });
});
