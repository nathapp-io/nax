# Spec-relative review dimensions

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
  unchanged file (e.g. `strategy_instance.get_references(...)`,
  `provider.cache.get_ohlcv(...)`).
- **Polymorphic / interface calls:** any call dispatched through a base class,
  protocol, or registry. The diff sees one signature; the real behaviour is in
  *every concrete implementation*. Enumerate them.
- **New or changed arguments to existing APIs:** a value the diff now passes that
  the callee didn't receive before — especially empty/sentinel/`None`/`{}`/`[]`
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
- The diff calls `iface.method(emptyValue)`; one concrete implementation
  immediately indexes a required key → runtime `KeyError`/`NullPointerException`
  for that case.
- The diff sets a sentinel to `{}` instead of `None`; a downstream guard checks
  `is None`, so `{}` slips through and produces a misleading error or silent NaN.
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
`os.environ` / filesystem / singleton state it mutates (teardown or fixture),
(b) is deterministic and order-independent, and (c) asserts the AC's actual
behaviour rather than a tautology. A test that passes only by accident of
ordering, or that asserts nothing meaningful, is **Partial**, not Covered.

**If the spec has no numbered or named ACs** (it's written as prose): derive
implicit requirements from the prose — treat each described behaviour, endpoint,
or constraint as a requirement. Note in the findings header: `(Spec has no
structured ACs — requirements inferred from prose)`.

**Renames and deletions:** treat them as intentional changes when evaluating
compliance. A diff showing `rename from A to B` or a deleted file counts as
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
  the diff now passes — especially empty/sentinel/`None`/`[]`/`{}` values?
- Does any sentinel or output the diff changed reach a downstream guard that
  interprets it the wrong way (`{}` slipping past an `is None` check; `[]`
  treated as "provided")?
- Does the spec's cross-cutting claim ("every X works") actually hold for the
  real, non-test-double implementations — and is each one exercised by a test?
  An untested real path is a finding, not a pass.
- Are there edge inputs the new tool/endpoint schema now permits (e.g. an
  explicitly empty array) that route into a broken branch?

## Convention Compliance — does the diff obey the project's own rules?

**Load the rules first.** Find the repo's own rule files and read every one that
exists (they may all be absent — then skip this dimension entirely and note
`(No project rule files found — Convention Compliance skipped)` in your findings):

```bash
ls CLAUDE.md AGENTS.md 2>/dev/null
find .nax/rules .claude/rules -name "*.md" 2>/dev/null
```

`.nax/rules/` takes priority over `.claude/rules/` when they conflict (nax-native
is canonical). Honour each file's `paths:` / `appliesTo:` frontmatter if present —
a rule scoped to `src/agents/**` does not apply to a diff under `apps/web/`.
Extract the concrete, checkable directives (forbidden APIs, required patterns,
naming, logging fields, file-size limits) and hold them for the checks below.

For each concrete directive extracted from the loaded rule files, check whether
the changed lines violate it. Only flag rules that actually apply to the changed
files (respect `paths:` / `appliesTo:` scoping). Examples of the *kind* of
directive to check — the real list comes from the loaded files, not this list:
- Forbidden APIs / patterns (e.g. a banned import, `console.log` in source, a
  Node API in a Bun-native repo, hardcoded patterns the project routes through a
  resolver).
- Required structure (barrel imports vs internal paths, file-size limits,
  mandated error/base classes, dependency-injection patterns).
- Required fields / format (e.g. a mandated structured-log field,
  conventional-commit style, naming conventions for routes/types/env vars).

Cite the specific rule file and directive in the finding
(`forbidden-patterns.md: no console.log in src/`). A violation of an explicit,
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
