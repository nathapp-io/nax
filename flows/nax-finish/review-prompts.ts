import type { Finding } from "./types";

export const SPEC_REVIEW_DIMENSIONS = `# Spec-relative review dimensions

Reference for the post-impl-review **spec-relative** pass: Compliance, Drift,
Integration, and Convention Compliance. Apply every dimension below against the
spec, the filtered diff, the collaborator code you read, and the loaded project
rules.

## Map external touchpoints first (read the unchanged collaborators)

**Do this before judging anything.** Most real defects in a focused diff live on
the boundary between the changed code and the *unchanged* code it calls into —
and that unchanged code is, by definition, not in the diff. A diff-only read
cannot see them.

From the filtered diff, build a list of **external touchpoints** — every symbol
the changed code *uses* but does not *define* in the diff:

- **Callees:** functions/methods the new lines call whose body lives in an
  unchanged file (e.g. \`strategy_instance.get_references(...)\`,
  \`provider.cache.get_ohlcv(...)\`).
- **Polymorphic / interface calls:** any call dispatched through a base class,
  protocol, or registry. The diff sees one signature; the real behaviour is in
  *every concrete implementation*. Enumerate them.
- **New or changed arguments to existing APIs:** a value the diff now passes that
  the callee didn't receive before — especially empty/sentinel/\`None\`/\`{}\`/\`[]\`
  values, or a newly-shaped object. Verify the callee tolerates it.
- **Consumers of changed outputs:** unchanged code that reads a field, sentinel,
  or return value whose meaning the diff altered.
- **Collaborators named in the spec:** if the spec asserts a cross-cutting goal
  ("every built-in strategy works", "all callers", "each adapter"), that goal is
  a claim *about unchanged code*. You must open those files to verify it — the
  diff alone can never prove it.

For each touchpoint, **read the actual definition(s)** with Read/Grep and check
the changed code's assumption holds for *all* of them, not just the convenient
case. Use Grep to find every implementation of an overridden method before
concluding it's safe.

Examples of assumptions that only break in unchanged code:
- The diff calls \`iface.method(emptyValue)\`; one concrete implementation
  immediately indexes a required key → runtime \`KeyError\`/\`NullPointerException\`
  for that case.
- The diff sets a sentinel to \`{}\` instead of \`None\`; a downstream guard checks
  \`is None\`, so \`{}\` slips through and produces a misleading error or silent NaN.
- The spec says "works for every strategy"; the diff only added tests for
  static/test-double strategies, leaving the dynamic real ones unverified.

Treat an untested cross-cutting claim as **unverified, not satisfied** — surface
it as a finding rather than assuming coverage.

## Compliance — per AC/story/requirement

For each numbered or named AC, story, or requirement in the spec, determine:
- **Covered** — the diff clearly addresses it
- **Partial** — the diff touches it but leaves something incomplete
- **Missing** — nothing in the diff implements it

**Coverage ≠ correctness:** when an AC's coverage is a test, do not stop at "a
test exists." Open the test body and verify it (a) restores any global /
\`os.environ\` / filesystem / singleton state it mutates (teardown or fixture),
(b) is deterministic and order-independent, and (c) asserts the AC's actual
behaviour rather than a tautology. A test that passes only by accident of
ordering, or that asserts nothing meaningful, is **Partial**, not Covered.

**If the spec has no numbered or named ACs** (it's written as prose): derive
implicit requirements from the prose — treat each described behaviour, endpoint,
or constraint as a requirement. Note in the findings header: \`(Spec has no
structured ACs — requirements inferred from prose)\`.

**Renames and deletions:** treat them as intentional changes when evaluating
compliance. A diff showing \`rename from A to B\` or a deleted file counts as
coverage for an AC that required moving or removing that module.

## Drift — holistic across the diff

Check whether the implementation matches the spec's described intent:
- API shape: do endpoints, request fields, response fields, and status codes
  match?
- Approach: is the architectural pattern (module structure, design pattern, data
  flow) what the spec called for?
- Constraints: are hard requirements respected (e.g. "must use HMAC-SHA256",
  "must be idempotent", "must validate at startup")?
- Naming: do key identifiers (routes, types, env vars, functions) match the
  spec's terminology?

## Integration — does the changed code actually work against the unchanged collaborators?

For each external touchpoint mapped above, check whether the changed code's
assumptions hold for *every* real implementation/consumer:
- Will any concrete callee raise (KeyError, NPE, ValueError, panic) for an input
  the diff now passes — especially empty/sentinel/\`None\`/\`[]\`/\`{}\` values?
- Does any sentinel or output the diff changed reach a downstream guard that
  interprets it the wrong way (\`{}\` slipping past an \`is None\` check; \`[]\`
  treated as "provided")?
- Does the spec's cross-cutting claim ("every X works") actually hold for the
  real, non-test-double implementations — and is each one exercised by a test?
  An untested real path is a finding, not a pass.
- Are there edge inputs the new tool/endpoint schema now permits (e.g. an
  explicitly empty array) that route into a broken branch?

## Convention Compliance — does the diff obey the project's own rules?

**Load the rules first.** Find the repo's own rule files and read every one that
exists (they may all be absent — then skip this dimension entirely and note
\`(No project rule files found — Convention Compliance skipped)\` in your findings):

\`\`\`bash
ls CLAUDE.md AGENTS.md 2>/dev/null
find .nax/rules .claude/rules -name "*.md" 2>/dev/null
\`\`\`

\`.nax/rules/\` takes priority over \`.claude/rules/\` when they conflict (nax-native
is canonical). Honour each file's \`paths:\` / \`appliesTo:\` frontmatter if present —
a rule scoped to \`src/agents/**\` does not apply to a diff under \`apps/web/\`.
Extract the concrete, checkable directives (forbidden APIs, required patterns,
naming, logging fields, file-size limits) and hold them for the checks below.

For each concrete directive extracted from the loaded rule files, check whether
the changed lines violate it. Only flag rules that actually apply to the changed
files (respect \`paths:\` / \`appliesTo:\` scoping). Examples of the *kind* of
directive to check — the real list comes from the loaded files, not this list:
- Forbidden APIs / patterns (e.g. a banned import, \`console.log\` in source, a
  Node API in a Bun-native repo, hardcoded patterns the project routes through a
  resolver).
- Required structure (barrel imports vs internal paths, file-size limits,
  mandated error/base classes, dependency-injection patterns).
- Required fields / format (e.g. a mandated structured-log field,
  conventional-commit style, naming conventions for routes/types/env vars).

Cite the specific rule file and directive in the finding
(\`forbidden-patterns.md: no console.log in src/\`). A violation of an explicit,
in-scope project rule is a real finding; a generic style opinion **not** backed
by a loaded rule is not — do not invent rules. If no rule files were found, skip
this dimension entirely.

## Confidence threshold (spec-relative)

**Report only findings you are ≥80% confident are real**, not pre-existing ones
the diff didn't introduce. A false "AC missing" or a phantom integration crash
is expensive and erodes trust in the whole report. A missing AC, a runtime crash
you traced through the collaborator, and an in-scope project-rule violation clear
this bar easily; a "this might be slow" hunch you haven't reasoned through does
not — drop it.
`;

export const QUALITY_REVIEW_DIMENSIONS = `# Code quality & test integrity dimension

Reference for the post-impl-review **code-quality** pass: spec-independent
defects and design/maintainability concerns in the changed lines. These findings
are real regardless of what the spec says. Scan the diff — production **and**
test code — and judge each changed function on its own merits.

## Forcing function — enumerate before you conclude

Before reporting, walk **every function/method the diff adds or changes** and
write yourself a one-line verdict for each: *earns its place* or *concern: …*.
This enumeration is a thinking tool — it does not go in the final report, only
the resulting findings do. Skipping it is how real maintainability issues get
missed: an agent that pattern-matches a few obvious smells and stops will always
under-report. Look at each changed function deliberately.

## What to look for

Report only concrete, objective issues, not style preferences:

- **Test isolation:** mutating \`os.environ\` / globals / singletons / filesystem
  without teardown; cross-test ordering dependence; shared mutable fixtures. A
  test that only passes because another test happens to clean up after it is a
  defect even when the suite is currently green.
- **Dead / redundant code:** assignments with no effect, unreachable branches,
  set-up the constructor already performed, unused locals introduced by the diff;
  logic duplicated from an existing helper the diff could have reused.
- **Resource leaks:** opened files / sockets / handles / subprocesses not closed;
  timers / listeners not cleared.
- **Error handling:** swallowed exceptions, bare catches that hide failures,
  missing validation on a newly-introduced input path.
- **Concurrency:** shared state mutated without synchronisation; \`await\` inside a
  loop that should be batched; a race between a check and the action it guards.
- **Performance:** N+1 queries or network calls in a loop; blocking I/O on a hot
  path; an obviously quadratic scan over a large collection the diff introduces.
- **Accessibility (UI diffs only):** interactive elements without an accessible
  name/label, missing \`alt\`, non-keyboard-reachable controls, form inputs with
  no associated label.
- **Security (only when the diff touches it):** hardcoded secrets, unvalidated
  user input reaching a sink, injection vectors.
- **Type safety:** unsafe casts, \`any\`/\`unknown\` escapes, weakened or widened
  types the diff introduces, or a narrowing the diff drops — anywhere the change
  trades a compile-time guarantee for a runtime risk.
- **Design & maintainability (open-ended — not a closed checklist):** a changed
  function that conflates multiple responsibilities (poor separation of
  concerns); an abstraction the diff introduces that is premature (single caller,
  speculative generality) or leaky (callers must understand its internals to use
  it safely); logic the diff writes inline that an existing helper already
  provides (reinvention, not just literal duplication); control flow so nested or
  convoluted the next reader will misread it; an identifier whose name actively
  misleads about what it holds or does; a comment or docstring the diff now leaves
  stale or contradicting the code it sits on, or a changed public API left without
  the docs a caller needs; an edge case the changed code's *own* logic implies but
  doesn't handle. These are the qualitative "this code isn't good yet" findings —
  judge them, don't skip them because they aren't on the defect list above. Anchor
  each to the changed line and state the concrete cost (what breaks, or who is
  misled, later).

Every finding here must point at a specific changed line and name a concrete cost
— a bug, a future break, or a reader who will be misled. Skip pure formatting and
personal taste that carry no such cost, and skip hypotheticals about code outside
the diff. But a design or maintainability concern grounded in a changed line and
its cost **is** in scope even though it's not on the defect checklist above —
that is exactly the signal this dimension exists to surface.

## Confidence threshold (code quality)

**Report findings you are ≥60% confident are real**, *provided* each is anchored
to a specific changed line and names a concrete maintenance or correctness cost.
Design and maintainability problems are inherently probabilistic — a muddy
abstraction, a misleading name, or a fragile edge case rarely clears 80%, and a
blanket 80% gate is precisely what makes a review miss the quality issues it
exists to catch. Let these land as MEDIUM or LOW per the severity table rather
than dropping them; the implementer can waive them, but they should see them.
Still exclude pure formatting and personal taste that carry no stated cost. Do
**not** over-suppress this tier to hit an arbitrary count — a real
maintainability concern stated with its cost is worth surfacing even at moderate
confidence.
`;

export const WORKER_PROTOCOL = `# Worker protocol (shared mechanics)

Self-contained mechanics for a post-impl-review **worker** (SPEC or QUALITY).
Read this plus your dimension reference (\`spec-review.md\` or \`code-quality.md\`) —
you do **not** need to read the dispatcher's \`SKILL.md\`. The dispatcher already
resolved the spec, detected the base branch, and ran the empty-diff/size guards;
your job is to review the diff and return findings.

## Get the diff

The dispatcher gave you the base branch. Fetch the diff content:

\`\`\`bash
git diff origin/<branch>...HEAD --name-only   # changed file list
git diff origin/<branch>...HEAD               # full diff content
\`\`\`

## Filter noise

Do not treat churn in these as a reviewable change (you may still *read* them as
context):

- Lockfiles: \`bun.lock\`, \`package-lock.json\`, \`yarn.lock\`, \`pnpm-lock.yaml\`,
  \`Cargo.lock\`, \`poetry.lock\`, or anything ending in \`.lock\`.
- Generated output: files in \`dist/\`, \`build/\`, \`.next/\`, \`.turbo/\`,
  \`__pycache__/\`, or matching \`*.generated.*\`.
- nax artifacts: anything under a \`.nax/\` directory at **any depth**
  (\`**/.nax/**\` — root or nested per-package in a monorepo): specs, PRDs,
  acceptance result JSON, config, and the generated acceptance tests.
- Binary files: git marks these \`Binary files a/... and b/... differ\` — skip them.

## Read the unchanged collaborators (before judging)

Most real defects in a focused diff live on the boundary between the changed code
and the *unchanged* code it calls into — which is, by definition, not in the
diff. Build the list of external touchpoints (every symbol the changed code
*uses* but does not *define*: callees, polymorphic/interface calls, new arguments
to existing APIs, consumers of changed outputs, collaborators named in the spec)
and read each definition with Read/Grep before concluding. Treat an untested
cross-cutting claim as **unverified, not satisfied**. (The SPEC dimension file
has the full procedure with worked examples; the QUALITY worker needs the same
reads to judge an integration-shaped defect.)

## Severity table

| Severity | Meaning |
|:---------|:--------|
| CRITICAL | AC entirely missing; implementation directly contradicts a hard spec requirement; the changed code raises/crashes at runtime for a case the spec requires to work; or a security defect the diff introduces (hardcoded secret, injection sink) |
| HIGH | Significant drift (wrong API shape, missing constraint, wrong architectural approach); an integration defect that breaks a real collaborator the spec depends on; or a violation of a project rule explicitly marked as required/forbidden (a banned API, a hard-blocked pattern) |
| MEDIUM | Partial coverage — AC present but incomplete; minor drift affecting correctness; an integration gap reachable through a now-permitted input; a test-isolation defect that can cause false positives or flakiness under reordering/parallelism; a resource leak; a swallowed error on a real path; a concurrency/race or performance regression the diff introduces; or an accessibility defect on a new interactive UI element |
| LOW | Minor naming deviation, style mismatch, dead/redundant/duplicated code, unused locals, a soft convention deviation, or other non-blocking gap |

## Output format — return ONLY this

Return **only your findings**, nothing else: no \`Spec:\`/\`Base:\` header, no
\`FINDINGS\` divider, no \`VERDICT\` line (the dispatcher adds those). Emit each
finding as a block:

\`\`\`
[SEVERITY] <short title>
  Problem: <what's wrong, with file/line and the concrete cost>
  Fix: <the concrete change, or "note intentional deviation">
\`\`\`

If you found nothing in your group, return the literal line \`No findings.\` as
your entire final message. That message is the only thing that travels back to
the dispatcher.
`;

const CLASSIFIER = [
  "After producing findings, classify the OVERALL route for this phase:",
  '- Route "proceed" when every finding has a clear recommended fix you can apply now',
  "  (CRITICAL/HIGH, or MEDIUM whose fix is clear and low-risk) — you will fix them and re-verify.",
  '- Route "escalate" when ANY finding is a spec conflict, a contradiction with the spec,',
  "  or a design/judgment concern with no safe mechanical fix. Do not attempt to fix those.",
].join("\n");

const JSON_CONTRACT = [
  "Return exactly one JSON object and nothing else. First char `{`, last char `}`.",
  "Shape:",
  "{",
  '  "route": "proceed" | "escalate",',
  '  "findings": [{ "severity": "CRITICAL"|"HIGH"|"MEDIUM"|"LOW", "title": string, "problem": string, "fix": string }],',
  '  "escalationReason": string   // required when route is "escalate"; omit otherwise',
  "}",
].join("\n");

/**
 * Build the reviewer prompt.
 *
 * With `since` set this is a **re-review**: the same reviewer already read the
 * whole branch and raised `priorFindings`, a fix was applied and committed, and
 * the only new material is `since..HEAD`. Re-reading the full branch diff every
 * round made reviews 58% of the flow's wall clock, most of it re-reading code an
 * earlier round had already cleared. The narrowed round still has the full repo
 * available — it is told to open whatever the fix touches — it just is not asked
 * to re-derive a verdict on unchanged code.
 *
 * `since` is only ever supplied when exactly one commit separates the two
 * reviews (see `incrementalSince`), so `since..HEAD` provably contains every
 * change made since the previous verdict.
 */
export function buildReviewPrompt(
  phase: "spec" | "quality",
  args: { base: string; specPath: string; since?: string | null; priorFindings?: Finding[] },
): string {
  const dims = phase === "spec" ? SPEC_REVIEW_DIMENSIONS : QUALITY_REVIEW_DIMENSIONS;
  if (!args.since) {
    return [
      `You are the ${phase.toUpperCase()} reviewer for a completed feature.`,
      `The spec/requirements source is: ${args.specPath}. Read it in full.`,
      `Fetch and review the diff: \`git diff ${args.base}...HEAD\` (also \`--name-only\` for the file list).`,
      WORKER_PROTOCOL,
      dims,
      CLASSIFIER,
      JSON_CONTRACT,
    ].join("\n\n");
  }
  return [
    `You are the ${phase.toUpperCase()} reviewer for a completed feature, continuing a review you already started.`,
    `On your previous pass over \`git diff ${args.base}...HEAD\` you raised the findings below, and they have since been fixed and committed. Everything else in that diff you already judged acceptable — do not re-derive a verdict on it.`,
    `Your findings from the previous pass:\n${JSON.stringify(args.priorFindings ?? [], null, 2)}`,
    `The fix is \`git diff ${args.since}..HEAD\` — this is the only code that has changed since your last verdict. Review it, and only it, for two questions:`,
    [
      "1. **Resolved?** Does the fix actually resolve each finding above? A finding that was papered over (assertion weakened, test deleted, check disabled) is NOT resolved — re-raise it.",
      "2. **Broken?** Did the fix introduce a new problem, in the changed lines or in the unchanged code they now call into?",
      "",
      `Read whatever files you need — the spec is at ${args.specPath} and the whole repo is available. Scope means *what you judge*, not *what you may read*.`,
    ].join("\n"),
    WORKER_PROTOCOL,
    dims,
    CLASSIFIER,
    JSON_CONTRACT,
  ].join("\n\n");
}

export function fixPrompt(
  phase: "acceptance" | "spec" | "quality" | "gate",
  ctx: { outputs: Record<string, unknown> },
): string {
  const outs = ctx.outputs as Record<string, { findings?: unknown; output?: string }>;
  const detail =
    phase === "gate"
      ? (outs.quality_gates?.output ?? "")
      : phase === "acceptance"
        ? (outs.acceptance?.output ?? "")
        : JSON.stringify(outs[`review_${phase}`]?.findings ?? []);
  return [
    `Apply the recommended fixes for the ${phase} phase, directly in the repo.`,
    "Do not commit, push, or open PRs — nax-finish commits and pushes your edits itself.",
    `Context:\n${detail}`,
    "After fixing, re-run the feature's acceptance tests and the relevant checks; only proceed when they pass.",
    'Return exactly {"route":"proceed"} when done and green.',
  ].join("\n\n");
}
