# Worker protocol (shared mechanics)

Self-contained mechanics for a post-impl-review **worker** (SPEC or QUALITY).
Read this plus your dimension reference (`spec-review.md` or `code-quality.md`) —
you do **not** need to read the dispatcher's `SKILL.md`. The dispatcher already
resolved the spec, detected the base branch, and ran the empty-diff/size guards;
your job is to review the diff and return findings.

## Get the diff

The dispatcher gave you the base branch. Fetch the diff content:

```bash
git diff origin/<branch>...HEAD --name-only   # changed file list
git diff origin/<branch>...HEAD               # full diff content
```

## Filter noise

Do not treat churn in these as a reviewable change (you may still *read* them as
context):

- Lockfiles: `bun.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
  `Cargo.lock`, `poetry.lock`, or anything ending in `.lock`.
- Generated output: files in `dist/`, `build/`, `.next/`, `.turbo/`,
  `__pycache__/`, or matching `*.generated.*`.
- nax artifacts: anything under a `.nax/` directory at **any depth**
  (`**/.nax/**` — root or nested per-package in a monorepo): specs, PRDs,
  acceptance result JSON, config, and the generated acceptance tests.
- Binary files: git marks these `Binary files a/... and b/... differ` — skip them.

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

Return **only your findings**, nothing else: no `Spec:`/`Base:` header, no
`FINDINGS` divider, no `VERDICT` line (the dispatcher adds those). Emit each
finding as a block:

```
[SEVERITY] <short title>
  Problem: <what's wrong, with file/line and the concrete cost>
  Fix: <the concrete change, or "note intentional deviation">
```

If you found nothing in your group, return the literal line `No findings.` as
your entire final message. That message is the only thing that travels back to
the dispatcher.
