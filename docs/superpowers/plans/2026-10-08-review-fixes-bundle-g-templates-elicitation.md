# Review Fixes Bundle G — Command Templates and Elicitation Text

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the master plan's **Global Constraints** and the **#19 ruling** first: `2026-10-08-review-fixes-master-plan.md`.

**Goal:** `{{files}}` substitution never corrupts a path containing `$`, and the elicitation prompt never invites an answer it will decline.

**Architecture:** Task 1 switches every `{{files}}` substitution to a function replacement (which `String.prototype.replace*` does not pattern-expand) — the shared `replaceInCommandSpec` in nax-agent and the two hand-rolled sites in nax's rectifier prompts. Task 2 changes only the instruction text and the module doc in nax-agent-acp's elicitation; the accept/decline behaviour is unchanged by ruling.

**Tech Stack:** TypeScript, bun:test.

**Spec:** `docs/superpowers/reviews/2026-10-08-whole-repo-code-review.md` findings #19, #27.

**Branch:** `git fetch origin && git checkout -b fix/review-g-templates-elicitation origin/main`

## Global Constraints

See the master plan. **`packages/nax/src/prompts/builders/rectifier-builder.ts` is grandfathered at 901 lines and may NOT grow**: Task 1's edit there is a same-line replacement. `rectifier-builder-helpers.ts` is 594 lines (budget +6): also a same-line replacement.

## Files

- Modify: `packages/nax-agent/src/internal/command-spec/index.ts:35-42` (Task 1)
- Test: `packages/nax-agent/test/unit/internal/command-spec.test.ts`
- Modify: `packages/nax/src/prompts/builders/rectifier-builder-helpers.ts:580` (Task 1)
- Modify: `packages/nax/src/prompts/builders/rectifier-builder.ts:525` (Task 1)
- Modify: `packages/nax/src/finish/gates/acceptance.ts:58` (Task 1 — same defect, found by the plan review)
- Test: `packages/nax/test/unit/prompts/builders/rectifier-builder-helpers.test.ts` (599 lines)
- Modify: `packages/nax-agent-acp/src/client/elicitation.ts:1-19, 145-151` (Task 2)
- Test: `packages/nax-agent-acp/test/unit/client/elicitation.test.ts` (300 lines)

---

### Task 1: `{{files}}` substitution is literal (#27)

`String.prototype.replace` / `replaceAll` with a STRING replacement expands `$$`, `$&`, `` $` `` and `$'`, so a failing test path such as `a$$b.test.ts` renders as `a$b.test.ts`; the two rectifier sites also use `replace`, which substitutes only the first `{{files}}`. A function replacement is inserted verbatim. `replaceInCommandSpec` (used by scoped-selection, scoped-lint, mechanical lint/format fix) has the same `$` expansion with shell-quoted paths, so fix it at the source.

**Files:** see the list above.

- [ ] **Step 1: Write the failing tests**

In `packages/nax-agent/test/unit/internal/command-spec.test.ts`, append inside `describe("replaceInCommandSpec", ...)`:

```ts
  test("inserts the replacement verbatim: $-patterns in a path are not expanded", () => {
    expect(replaceInCommandSpec("bun test {{files}}", "{{files}}", "'a$$b.ts' '$&.ts' '$`x' \"$'y\"")).toBe(
      "bun test 'a$$b.ts' '$&.ts' '$`x' \"$'y\"",
    );
  });
```

In `packages/nax/test/unit/prompts/builders/rectifier-builder-helpers.test.ts`, append a new describe (the file already imports `RectifierPromptBuilder`, `Finding` and the `TDD_STORY` fixture):

```ts
describe("failingTestRectification — per-file scoped commands", () => {
  test("substitutes every {{files}} with the path verbatim, $ characters included", () => {
    const finding: Finding = {
      source: "test-runner",
      severity: "error",
      category: "failed-test",
      rule: "should work",
      file: "test/unit/a$$b.test.ts",
      message: "AssertionError",
    };
    const prompt = RectifierPromptBuilder.failingTestRectification([finding], TDD_STORY, {
      testCommand: "bun test",
      testScopedTemplate: "bun test {{files}} && echo {{files}}",
    });
    expect(prompt).toContain("bun test test/unit/a$$b.test.ts && echo test/unit/a$$b.test.ts");
  });
});

describe("RectifierPromptBuilder.escalated — per-file scoped commands", () => {
  test("substitutes {{files}} with the path verbatim", () => {
    const prompt = RectifierPromptBuilder.escalated(
      [{ file: "test/unit/a$$b.test.ts", testName: "works", error: "AssertionError" }],
      TDD_STORY,
      2,
      "fast",
      "powerful",
      undefined,
      "bun test",
      "bun test {{files}}",
    );
    expect(prompt).toContain("bun test test/unit/a$$b.test.ts");
  });
});
```

(`RectifierPromptBuilder.escalated` has no production callers today — see the review's "verified-intentional" list — but it shares the defect and the fix costs nothing, so it is pinned too.)

- [ ] **Step 2: Run them to verify they fail**

Run (from `packages/nax-agent`): `timeout 30 bun test test/unit/internal/command-spec.test.ts --timeout=5000`
Run (from `packages/nax`): `timeout 30 bun test test/unit/prompts/builders/rectifier-builder-helpers.test.ts --timeout=5000`
Expected: all three new tests FAIL (`a$b`, the second `{{files}}` left in place, and so on).

- [ ] **Step 3: Implement**

`command-spec/index.ts`:

```ts
export function replaceInCommandSpec(
  spec: QualityCommandSpec,
  searchValue: string,
  replacement: string,
): QualityCommandSpec {
  // A function replacement is inserted verbatim; a string one expands $$, $&, $` and $' (#27).
  const replace = (command: string) => command.replaceAll(searchValue, () => replacement);
  return typeof spec === "string" ? replace(spec) : spec.map(replace);
}
```

`rectifier-builder-helpers.ts:580` — same-line replacement:

```ts
            ? opts.testScopedTemplate.replaceAll("{{files}}", () => file)
```

`rectifier-builder.ts:525` — same-line replacement:

```ts
          ? testScopedTemplate.replaceAll("{{files}}", () => file)
```

`finish/gates/acceptance.ts:58` (`buildAcceptanceCommand`) has the same `$` expansion with a shell-quoted absolute path — same-line replacement:

```ts
  return template.replace(/\{\{FILE\}\}|\{\{file\}\}|\{\{files\}\}/g, () => absFile);
```

Pin it in `packages/nax/test/unit/finish/gates-acceptance.test.ts` (the existing test file for `finish/gates/acceptance.ts`; add `buildAcceptanceCommand` to its `@/finish/gates/acceptance` import if it is not imported yet):

```ts
  test("buildAcceptanceCommand inserts a $-containing path verbatim", () => {
    const command = buildAcceptanceCommand("/repo", {
      packageDir: "pkg",
      testPath: "pkg/a$$b.acceptance.test.ts",
      exists: true,
      command: "bun test {{FILE}}",
      cwd: "pkg",
    });
    expect(command).toContain("a$$b.acceptance.test.ts");
  });
```

(`AcceptanceGroupResult` fields: `packageDir`, `testPath`, `exists`, `command?`, `cwd`, `language?` — `cli/features-acceptance.ts:19-34`.)

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/nax-agent`): `timeout 30 bun test test/unit/internal/ --timeout=5000`
Run (from `packages/nax`): `timeout 60 bun test test/unit/prompts/ test/unit/operations/ test/unit/test-runners/ test/unit/review/ --timeout=5000`
Expected: PASS. `wc -l src/prompts/builders/rectifier-builder.ts` — exactly 901.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/src/internal/command-spec/index.ts packages/nax-agent/test/unit/internal/command-spec.test.ts packages/nax/src/prompts/builders/rectifier-builder-helpers.ts packages/nax/src/prompts/builders/rectifier-builder.ts packages/nax/test/unit/prompts/builders/rectifier-builder-helpers.test.ts packages/nax/src/finish/gates/acceptance.ts packages/nax/test/unit/finish/gates-acceptance.test.ts
git commit -m "fix(prompts): substitute {{files}} verbatim, every occurrence (review #27)"
```

---

### Task 2: The elicitation prompt only offers answers it will accept (#19)

Ruling: the decline behaviour is correct — a REQUIRED select must name a choice, because filling only its `<key>_custom` companion would omit the required key and violate the requester's own schema. (Claude's AskUserQuestion forms never mark fields required, `claude-agent-acp` 0.85.1 `dist/elicitation.js:111-167`, so this arises only from third-party MCP forms.) Two things are wrong and get fixed:

1. `instruction()` appends ", or type your own answer" whenever a companion exists, even for a required single-select, where a typed answer is then declined.
2. The module doc does not state the required-select rule, so it reads as contradicting the code.

New instruction text:
- optional field with companion (unchanged): `…, or type your own answer.` + ` Leave empty to skip.`
- required SINGLE-select with companion: `Reply with one number or choice.` (no own-answer offer)
- required MULTI-select with companion: `Reply with numbers or choices, separated by commas; you may add your own after at least one choice.`

**Files:**
- Modify: `packages/nax-agent-acp/src/client/elicitation.ts`
- Test: `packages/nax-agent-acp/test/unit/client/elicitation.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a new describe to `elicitation.test.ts` (uses the file's `form`, `answer` and `NO_MATCH_NOTE`):

```ts
describe("answerElicitation: required selects with a companion (#19 ruling)", () => {
  const AUTH = {
    type: "string",
    title: "Auth",
    oneOf: [
      { const: "OAuth", title: "OAuth" },
      { const: "API key", title: "API key" },
    ],
  };
  const CACHE = {
    type: "array",
    title: "Cache",
    items: { anyOf: [{ const: "Redis", title: "Redis" }] },
  };

  test("a required single-select does not offer a free-text answer, and declines one", async () => {
    const request = form({ auth: AUTH, auth_custom: { type: "string" } }, { required: ["auth"] });
    const { response, questions, notes } = await answer(request, ["mTLS"]);
    expect(questions[0]?.split("\n").at(-1)).toBe("Reply with one number or choice.");
    expect(response).toEqual({ action: "decline" });
    expect(notes).toEqual([NO_MATCH_NOTE]);
  });

  test("a required single-select still accepts a named choice", async () => {
    const request = form({ auth: AUTH, auth_custom: { type: "string" } }, { required: ["auth"] });
    expect((await answer(request, ["2"])).response).toEqual({ action: "accept", content: { auth: "API key" } });
  });

  test("a required multi-select offers free text only beside a choice", async () => {
    const request = form({ cache: CACHE, cache_custom: { type: "string" } }, { required: ["cache"] });
    const { response, questions } = await answer(request, ["1, Hazelcast"]);
    expect(questions[0]?.split("\n").at(-1)).toBe(
      "Reply with numbers or choices, separated by commas; you may add your own after at least one choice.",
    );
    expect(response).toEqual({ action: "accept", content: { cache: ["Redis"], cache_custom: "Hazelcast" } });
  });

  test("a required multi-select declines free text with no choice", async () => {
    const request = form({ cache: CACHE, cache_custom: { type: "string" } }, { required: ["cache"] });
    const { response, notes } = await answer(request, ["Hazelcast"]);
    expect(response).toEqual({ action: "decline" });
    expect(notes).toEqual([NO_MATCH_NOTE]);
  });
});
```

- [ ] **Step 2: Run them to verify which fail**

Run (from `packages/nax-agent-acp`): `timeout 30 bun test test/unit/client/elicitation.test.ts --timeout=5000`
Expected: the two instruction-text assertions FAIL (today: `Reply with one number or choice, or type your own answer.` and `…, or type your own answer.`); the accept/decline assertions already PASS — they pin the ruled behaviour.

- [ ] **Step 3: Implement**

Replace `instruction()`:

```ts
/**
 * The companion offer, only where a typed answer would be accepted: a required
 * select must name a choice (filling only `<key>_custom` would omit the required
 * key), so a required single-select gets no offer and a required multi-select
 * gets one only beside a choice.
 */
function ownAnswerHint(field: Field): string {
  if (field.companion === undefined) return "";
  if (!field.required) return ", or type your own answer";
  return field.kind === "multi" ? "; you may add your own after at least one choice" : "";
}

function instruction(field: Field): string {
  const own = ownAnswerHint(field);
  const skip = field.required ? "" : " Leave empty to skip.";
  if (field.kind === "single") return `Reply with one number or choice${own}.${skip}`;
  if (field.kind === "multi") return `Reply with numbers or choices, separated by commas${own}.${skip}`;
  return field.required ? "Reply with your answer." : "Reply with your answer, or leave it empty to skip.";
}
```

In the module doc comment at the top, replace the sentence

```
 * a reply naming no choice without a companion, or an empty reply to a
 * required field, declines after asking.
```

with:

```
 * a reply naming no choice without a companion, a reply naming no choice to a
 * REQUIRED select (its companion only adds to a choice — filling it alone would
 * omit the required key), or an empty reply to a required field, declines after
 * asking.
```

(Keep the rest of the doc as is; reflow the surrounding lines only if biome requires it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/client/ --timeout=5000`
Expected: PASS, including the existing Claude-form tests (their fields are optional, so their text is unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent-acp/src/client/elicitation.ts packages/nax-agent-acp/test/unit/client/elicitation.test.ts
git commit -m "fix(acp): elicitation never offers a free-text answer a required select would decline (review #19)"
```

---

## Bundle wrap-up

Run the master plan's **Per-bundle PR checklist** with scope `prompts,command-spec,acp`, running the gates for nax, nax-agent and nax-agent-acp.
