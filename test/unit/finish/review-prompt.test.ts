import { describe, expect, test } from "bun:test";
import {
  FINDING_BLOCK_SHAPE,
  QUALITY_REVIEW_DIMENSIONS,
  SPEC_REVIEW_DIMENSIONS,
  WORKER_PROTOCOL,
  WORKER_PROTOCOL_MECHANICS,
  buildFixPrompt,
  buildReviewPrompt,
} from "@/finish";

describe("review prompts", () => {
  test("spec dimensions copied verbatim (key markers present)", () => {
    expect(SPEC_REVIEW_DIMENSIONS).toContain("Map external touchpoints first");
    expect(SPEC_REVIEW_DIMENSIONS).toContain("Convention Compliance");
    expect(SPEC_REVIEW_DIMENSIONS).toContain("≥80% confident");
  });

  test("quality dimensions copied verbatim (key markers present)", () => {
    expect(QUALITY_REVIEW_DIMENSIONS).toContain("enumerate before you conclude");
    expect(QUALITY_REVIEW_DIMENSIONS).toContain("≥60% confident");
  });

  test("spec prompt carries the classifier and the three-section output contract", () => {
    const p = buildReviewPrompt("spec", { base: "origin/main", specPath: ".nax/features/x/prd.json" });
    expect(p).toContain("git diff origin/main...HEAD");
    expect(p).toContain(".nax/features/x/prd.json");
    expect(p).toContain("## TOUCHPOINTS");
    expect(p).toContain("## WALK");
    expect(p).toContain("## FINDINGS");
    expect(p).toContain("Judgment: yes");
    expect(p).not.toContain("First char `{`");
  });

  test("the quality prompt asks for a per-file walk, the spec prompt for a per-AC walk", () => {
    const spec = buildReviewPrompt("spec", { base: "origin/main", specPath: "s.md" });
    const quality = buildReviewPrompt("quality", { base: "origin/main", specPath: "s.md" });
    expect(spec).toContain("one line per AC");
    expect(quality).toContain("one line per file");
    expect(quality).not.toContain("one line per function");
  });
});

// US-001: Bound the quality reviewer reply contract.
// Each acceptance criterion has its own test, named after the AC.
describe("buildReviewPrompt — quality reply contract (US-001)", () => {
  const QUALITY_BASE = "origin/main";
  const SPEC_PATH = ".nax/features/x/spec.md";

  // AC 1: the quality prompt asks for one line per file and omits one line per function.
  test("AC 1: quality WALK is per file, not per function", () => {
    const p = buildReviewPrompt("quality", { base: QUALITY_BASE, specPath: SPEC_PATH });
    expect(p).toContain("one line per file");
    expect(p).not.toContain("one line per function");
  });

  // AC 2: the spec prompt asks for one line per AC.
  test("AC 2: spec WALK is per AC", () => {
    const p = buildReviewPrompt("spec", { base: QUALITY_BASE, specPath: SPEC_PATH });
    expect(p).toContain("one line per AC");
  });

  // AC 3: the quality prompt retains the per-function walk as private scratch work.
  test("AC 3: quality prompt keeps the private per-function walk", () => {
    const p = buildReviewPrompt("quality", { base: QUALITY_BASE, specPath: SPEC_PATH });
    expect(p).toContain("write yourself");
  });

  // AC 4: the quality prompt in fresh-review form omits the spec path.
  test("AC 4: quality fresh review omits specPath", () => {
    const p = buildReviewPrompt("quality", { base: QUALITY_BASE, specPath: SPEC_PATH });
    expect(p).not.toContain(SPEC_PATH);
  });

  // AC 5: the quality prompt in re-review form omits the spec path.
  test("AC 5: quality re-review omits specPath", () => {
    const p = buildReviewPrompt("quality", {
      base: QUALITY_BASE,
      specPath: SPEC_PATH,
      since: "abc123",
      priorFindings: [{ severity: "HIGH", title: "T", problem: "P", fix: "F" }],
    });
    expect(p).not.toContain(SPEC_PATH);
  });

  // AC 6: the spec prompt keeps the spec path in both fresh and re-review forms.
  test("AC 6: spec prompt includes specPath in both fresh and re-review forms", () => {
    const fresh = buildReviewPrompt("spec", { base: QUALITY_BASE, specPath: SPEC_PATH });
    expect(fresh).toContain(SPEC_PATH);

    const reReview = buildReviewPrompt("spec", {
      base: QUALITY_BASE,
      specPath: SPEC_PATH,
      since: "abc123",
      priorFindings: [{ severity: "HIGH", title: "T", problem: "P", fix: "F" }],
    });
    expect(reReview).toContain(SPEC_PATH);
  });

  // AC 7: the quality prompt still requires all three reply sections.
  test("AC 7: quality prompt keeps all three reply sections", () => {
    const p = buildReviewPrompt("quality", { base: QUALITY_BASE, specPath: SPEC_PATH });
    expect(p).toContain("## TOUCHPOINTS");
    expect(p).toContain("## WALK");
    expect(p).toContain("## FINDINGS");
  });
});

describe("buildFixPrompt", () => {
  test("gate phase pulls gateOutput and demands re-verify + proceed contract", () => {
    const p = buildFixPrompt("gate", { gateOutput: "lint failed on foo.ts" });
    expect(p).toContain("lint failed on foo.ts");
    expect(p).toContain('{"route":"proceed"}');
    expect(p).toContain("re-run the feature's acceptance tests");
  });

  test("acceptance phase pulls acceptanceOutput", () => {
    const p = buildFixPrompt("acceptance", { acceptanceOutput: "test XYZ failed" });
    expect(p).toContain("test XYZ failed");
  });

  test("spec phase numbers findings", () => {
    const p = buildFixPrompt("spec", {
      findings: [{ severity: "HIGH", title: "t", problem: "p", fix: "f" }],
    });
    expect(p).toContain("[1] [HIGH] t");
  });

  test("quality phase numbers findings", () => {
    const p = buildFixPrompt("quality", {
      findings: [{ severity: "LOW", title: "q", problem: "p", fix: "f" }],
    });
    expect(p).toContain("[1] [LOW] q");
  });

  test("the spec fix prompt numbers its findings and demands a disposition for each", () => {
    const p = buildFixPrompt("spec", {
      findings: [{ severity: "HIGH", title: "T", problem: "p", fix: "f" }],
    });
    expect(p).toContain("[1] [HIGH] T");
    expect(p).toContain("## DISPOSITIONS");
    expect(p).toContain("rejected — evidence:");
  });

  test("the gate fix prompt has no dispositions section — it has no findings", () => {
    const p = buildFixPrompt("gate", { gateOutput: "lint failed" });
    expect(p).not.toContain("## DISPOSITIONS");
  });

  test("findings are numbered 1-based in the order given — the DISPOSITIONS index contract", () => {
    const p = buildFixPrompt("spec", {
      findings: [
        { severity: "HIGH", title: "First", problem: "p1", fix: "f1" },
        { severity: "MEDIUM", title: "Second", problem: "p2", fix: "f2" },
        { severity: "LOW", title: "Third", problem: "p3", fix: "f3" },
      ],
    });
    expect(p).toContain("[1] [HIGH] First");
    expect(p).toContain("[2] [MEDIUM] Second");
    expect(p).toContain("[3] [LOW] Third");
    // Ordering in the numbered block must match array order, not a re-sort.
    const i1 = p.indexOf("[1] [HIGH] First");
    const i2 = p.indexOf("[2] [MEDIUM] Second");
    const i3 = p.indexOf("[3] [LOW] Third");
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
  });
});

// Reviews were 58% of the flow's wall clock on one downstream feature
// (7 calls, 1306s of 2232s), most of it re-reading code an earlier round had
// already cleared.
describe("buildReviewPrompt — incremental re-review", () => {
  const PRIOR = [{ severity: "HIGH" as const, title: "T", problem: "P", fix: "F" }];

  test("round 1 (no since) reviews the whole branch diff", () => {
    const p = buildReviewPrompt("spec", { base: "origin/main", specPath: "s.md" });
    expect(p).toContain("git diff origin/main...HEAD");
    expect(p).not.toContain("continuing a review you already started");
  });

  test("a re-review scopes the verdict to the fix diff", () => {
    const p = buildReviewPrompt("spec", {
      base: "origin/main",
      specPath: "s.md",
      since: "abc123",
      priorFindings: PRIOR,
    });
    expect(p).toContain("git diff abc123..HEAD");
    expect(p).toContain("continuing a review you already started");
    expect(p).toContain("do not re-derive a verdict on it");
  });

  test("a re-review carries the prior findings forward, so the fix can be checked against them", () => {
    const p = buildReviewPrompt("quality", {
      base: "origin/main",
      specPath: "s.md",
      since: "abc123",
      priorFindings: PRIOR,
    });
    expect(p).toContain('"title": "T"');
  });

  // The saving must come from narrowing what is *judged*, never from blinding
  // the reviewer — a fix's real damage is often in the unchanged code it calls.
  test("a re-review may still read anything, and is told so explicitly", () => {
    const p = buildReviewPrompt("spec", { base: "origin/main", specPath: "s.md", since: "abc", priorFindings: PRIOR });
    expect(p).toContain("the whole repo is available");
    expect(p).toContain("Scope means *what you judge*, not *what you may read*");
  });

  test("a re-review refuses papered-over fixes rather than accepting a green gate", () => {
    const p = buildReviewPrompt("spec", { base: "origin/main", specPath: "s.md", since: "abc", priorFindings: PRIOR });
    expect(p).toContain("assertion weakened, test deleted, check disabled");
  });

  test("both rounds keep the full dimensions and the output contract", () => {
    for (const since of [null, "abc123"]) {
      const p = buildReviewPrompt("quality", { base: "origin/main", specPath: "s.md", since, priorFindings: PRIOR });
      expect(p).toContain("Confidence threshold");
      expect(p).toContain("## FINDINGS");
    }
  });
});

// The assembled prompt used to carry two contradictory output contracts.
// `WORKER_PROTOCOL` closes with "## Output format — return ONLY this" ("return
// only your findings, nothing else: ... no `FINDINGS` divider"), and
// `outputContract` then demands three headed sections. The negative instruction
// came first and was the more emphatic of the two.
//
// The sharpest edge is the clean review: "return the literal line `No findings.`
// as your entire final message" forbids emitting ## TOUCHPOINTS and ## WALK at
// all when nothing was found — which is exactly what `steps/review-audit.ts`
// treats as an incomplete review. Both quality reviews ever recorded came back
// `outcome: "unparseable"` on their first attempt.
describe("buildReviewPrompt — exactly one output contract", () => {
  const CASES = [
    { phase: "spec" as const, since: null },
    { phase: "spec" as const, since: "abc123" },
    { phase: "quality" as const, since: null },
    { phase: "quality" as const, since: "abc123" },
  ];

  for (const { phase, since } of CASES) {
    const label = `${phase} / ${since ? "re-review" : "first round"}`;

    test(`${label}: the worker protocol's competing output format never reaches the prompt`, () => {
      const p = buildReviewPrompt(phase, {
        base: "origin/main",
        specPath: "s.md",
        since,
        priorFindings: since ? [{ severity: "HIGH", title: "T", problem: "P", fix: "F" }] : undefined,
      });
      expect(p).not.toContain("## Output format");
      expect(p).not.toContain("return ONLY this");
      expect(p).not.toContain("nothing else");
      expect(p).not.toContain("entire final message");
      expect(p).not.toContain("no `FINDINGS` divider");
    });

    test(`${label}: the reply contract survives, block shape included`, () => {
      const p = buildReviewPrompt(phase, {
        base: "origin/main",
        specPath: "s.md",
        since,
        priorFindings: since ? [{ severity: "HIGH", title: "T", problem: "P", fix: "F" }] : undefined,
      });
      expect(p).toContain("## TOUCHPOINTS");
      expect(p).toContain("## WALK");
      expect(p).toContain("## FINDINGS");
      // Dropping the worker protocol's output section must not take the block
      // template with it — `outputContract` used to just point at it.
      expect(p).toContain("[SEVERITY] <short title>");
      expect(p).toContain("Problem:");
      expect(p).toContain("Fix:");
      // A clean review still has a way to say so, from the reply contract.
      expect(p).toContain("No findings.");
    });

    test(`${label}: the mechanics the worker still needs are all present`, () => {
      const p = buildReviewPrompt(phase, {
        base: "origin/main",
        specPath: "s.md",
        since,
        priorFindings: since ? [{ severity: "HIGH", title: "T", problem: "P", fix: "F" }] : undefined,
      });
      expect(p).toContain("Worker protocol (shared mechanics)");
      expect(p).toContain("## Filter noise");
      expect(p).toContain("## Severity table");
      expect(p).toContain("## Read the unchanged collaborators");
    });

    // New (Task 5): the #1625 regression, pinned on the assembled string.
    test(`${label}: the ## FINDINGS output contract appears exactly once`, () => {
      const p = buildReviewPrompt(phase, {
        base: "origin/main",
        specPath: "s.md",
        since,
        priorFindings: since ? [{ severity: "HIGH", title: "T", problem: "P", fix: "F" }] : undefined,
      });
      const count = (p.match(/## FINDINGS/g) ?? []).length;
      expect(count).toBe(1);
    });
  }

  // The whole constant stays exported and byte-identical to the skill's
  // references/worker-protocol.md, which is why it was inlined verbatim in the
  // first place. Only what this module assembles changes.
  test("WORKER_PROTOCOL is still whole, and the mechanics are a strict prefix of it", () => {
    expect(WORKER_PROTOCOL).toContain("## Output format — return ONLY this");
    expect(WORKER_PROTOCOL).toContain("entire final message");
    expect(WORKER_PROTOCOL.startsWith(WORKER_PROTOCOL_MECHANICS)).toBe(true);
    expect(WORKER_PROTOCOL_MECHANICS).not.toContain("## Output format");
  });

  test("the finding block shape is its own constant, shared by both", () => {
    expect(FINDING_BLOCK_SHAPE).toContain("[SEVERITY] <short title>");
    expect(WORKER_PROTOCOL).toContain(FINDING_BLOCK_SHAPE);
  });
});

// New (Task 5): with gaps set, the prompt opens with the gap notice and names
// each gap explicitly.
describe("buildReviewPrompt — gap notice", () => {
  test("gaps set: the prompt opens with the gap notice and names each gap", () => {
    const gaps = [
      "no `## TOUCHPOINTS` section: list every external definition you opened",
      "no `## WALK` section: the per-AC enumeration is required",
    ];
    const p = buildReviewPrompt("spec", { base: "origin/main", specPath: "s.md", gaps });
    expect(p.startsWith("IMPORTANT — your previous review was not accepted")).toBe(true);
    for (const gap of gaps) {
      expect(p).toContain(`- ${gap}`);
    }
    expect(p).toContain("Do the reading this time and emit all three sections.");
  });

  test("gaps unset: no gap notice appears", () => {
    const p = buildReviewPrompt("spec", { base: "origin/main", specPath: "s.md" });
    expect(p).not.toContain("IMPORTANT — your previous review was not accepted");
  });

  test("empty gaps array: no gap notice appears", () => {
    const p = buildReviewPrompt("spec", { base: "origin/main", specPath: "s.md", gaps: [] });
    expect(p).not.toContain("IMPORTANT — your previous review was not accepted");
  });
});

// New (Task 5): the diff-range form differs between the full-diff (three-dot)
// and incremental (two-dot) branches, and the incremental branch also carries
// the prior findings as JSON. Pin which form appears in which branch.
describe("buildReviewPrompt — diff range form", () => {
  const PRIOR = [{ severity: "MEDIUM" as const, title: "Prior", problem: "P", fix: "F" }];

  test("since unset: references the three-dot base diff, not a two-dot since diff", () => {
    const p = buildReviewPrompt("spec", { base: "origin/main", specPath: "s.md" });
    expect(p).toContain("git diff origin/main...HEAD");
    expect(p).not.toContain("git diff origin/main..HEAD");
  });

  test("since set: references the two-dot since diff and includes prior findings JSON", () => {
    const p = buildReviewPrompt("spec", {
      base: "origin/main",
      specPath: "s.md",
      since: "abc123",
      priorFindings: PRIOR,
    });
    expect(p).toContain("git diff abc123..HEAD");
    expect(p).not.toContain("git diff abc123...HEAD");
    // The three-dot base diff is still mentioned as context for the prior pass.
    expect(p).toContain("git diff origin/main...HEAD");
    expect(p).toContain(JSON.stringify(PRIOR, null, 2));
  });
});
