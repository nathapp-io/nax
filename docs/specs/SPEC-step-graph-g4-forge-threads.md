# SPEC: Branch steps outside a run (G4) and forge threads (B1)

## Summary

Two independent pieces that `nax bot review` (B2) needs, bundled into one feature by the user's ruling
(2026-10-20). **G4:** the whole-branch review, re-review, branch fix and repo gates take a narrow
`BranchStepContext` instead of the full `FeatureContext`, the branch prompts accept a missing PRD, and a new
provider `buildPrStepContext` builds that context for a pull request with no nax run, no PRD and no run
record. Inside `nax run` nothing changes: `FeatureContext` already has every field the narrow context names,
so it is passed as is. **B1:** the forge layer (`packages/nax/src/forge/`) learns to read a PR (details,
review threads, top-level comments), classify how far its author can be trusted, and write to it (inline
comment, summary comment, thread reply, thread resolve, comment edit), plus the nax bot comment marker that
lets a later run find its own comments. Every forge call goes through the injected `ForgeDeps`, so all tests
run against mocks. No production code calls the new pieces yet; B2 is their first caller.

## Motivation

The step graph master plan (`nax-step-graph-and-bot-master-plan.md`, rulings R1-R11) builds `nax bot review`
and `nax bot fix`, which QA any PR: read every comment, check each one, fix or answer it. G0-G3 moved both
workflow machines onto the step graph with no behaviour change (#2618-#2621). Two gaps remain before B2:

1. The review and fix steps only run inside a nax run. `runBranchReview`, `runBranchReReview`,
   `runBranchFix` and `runRepoGates` take a `FeatureContext` built from a PRD and a run id
   (`packages/nax/src/workflow/feature-context.ts`), and the branch prompts require a PRD path
   (`BranchReviewPromptInput.prdPath: string`). A PR opened by a person has no PRD.
2. The forge layer can open, view, edit and promote a PR, and post one top-level comment
   (`packages/nax/src/workflow/promote.ts`). It cannot read review threads or comments, post on a line, reply
   in a thread, resolve a thread, or tell a fork PR from a trusted one. All of those are in B1's scope in the
   master plan (§7 B1, §5a trust classification).

The two pieces share no files, so one run can carry both. Bundling saves one full spec -> plan -> run -> review
cycle (user, 2026-10-20).

## Design

### Approach

**G4 is a type narrowing plus one new provider, not a rewrite.** The four branch steps keep their bodies. Only
their parameter type changes, from `FeatureContext` to `BranchStepContext`. `BranchStepContext` lists only the
fields those bodies read today, with the same names and types, except `prdPath`, which becomes optional. So a
`FeatureContext` is assignable to it with no adapter, and every call inside `nax run` passes the same object
it passes today. The G0 equivalence suites (`feature-machine-equivalence.test.ts`,
`story-loop-equivalence.test.ts`) and the existing step tests are the proof that nothing changed. They must
pass with no edit.

**B1 is new forge functions in the existing style**: one function per capability, a `ForgeKind` branch that
builds a GitHub argv or a GitLab argv, `deps.run(argv, { cwd })`, a thrown `NaxError` on a non-zero exit
(BUG-8 rule, `hasOpenPr` in `forge/pr.ts`), and JSON parsing of stdout. Every read and write goes through the
`gh api` / `glab api` REST or GraphQL endpoints with an explicit `--hostname`, never the CLI's implicit repo
context. Pagination is nax's own loop over explicit `page` numbers or GraphQL cursors, never the CLI's
`--paginate` flag, so a mocked `ForgeDeps` sees every page request.

### G4: the narrow step context

New file `packages/nax/src/workflow/branch-step-context.ts`:

```ts
/** What the branch steps read: inside a run FeatureContext provides it, outside a run buildPrStepContext. */
export interface BranchStepContext {
  readonly callCtx: CallContext;
  readonly config: NaxConfig;
  readonly workflow: WorkflowConfig;
  /** The feature name inside a run; `bot-pr-<number>` for a PR. Used in report headings and logs. */
  readonly feature: string;
  /** Repo root (git cwd). */
  readonly projectDir: string;
  /** Where review packages, step artifacts and the report go. */
  readonly runDir: string;
  readonly reportPath: string;
  /** Absent outside a run: the change has no PRD. */
  readonly prdPath?: string;
  /** Repo-relative package dirs for the repo gates; empty = root gates only. */
  readonly packageDirs: readonly string[];
  readonly runSignal?: AbortSignal;
  readonly dryRun: boolean;
}

export interface PrStepRef {
  readonly forge: ForgeKind;
  readonly number: number;
  /** The base commit or ref the review range starts at. */
  readonly base: string;
  /** The PR head commit sha. */
  readonly head: string;
}

export interface PrStepContext extends BranchStepContext {
  readonly pr: PrStepRef;
}
```

New file `packages/nax/src/workflow/pr-step-context.ts`:

```ts
export interface PrStepContextInput {
  readonly runtime: NaxRuntime;
  /** The config the PR is reviewed under (B2 decides where it loads from). */
  readonly config: NaxConfig;
  /** Root of the checkout that holds the PR head. */
  readonly repoRoot: string;
  readonly agentName: string;
  readonly pr: PrStepRef;
  readonly abortSignal?: AbortSignal;
  readonly interactionChain?: InteractionChain | null;
}

export const _prStepContextDeps = { buildRunDispatchAskWiring };

export async function buildPrStepContext(
  input: PrStepContextInput,
): Promise<{ ctx: PrStepContext; dispose: () => Promise<void> }>;
```

`buildPrStepContext` does, in order:

1. Validate `input.pr`: `number` is a positive integer, `base` and `head` are non-empty strings after trim.
   Otherwise throw `NaxError` with code `PR_STEP_CONTEXT_INVALID` and context `{ stage: "workflow" }` before
   anything else runs.
2. `label = "bot-pr-" + number`.
3. Build the ask wiring exactly as `buildFeatureContext` does, through
   `_prStepContextDeps.buildRunDispatchAskWiring` with `config` and `rootConfig` both `input.config`,
   `projectDir` and `repoRoot` `input.repoRoot`, `packageDirs: []`, `interaction: input.interactionChain`,
   `outputDir: input.runtime.outputDir`, `runId: input.runtime.runId`, `featureName: label`,
   `abortSignal: input.abortSignal`, `stage: "merge"`. The branch fix declares Bash, so the wiring is required.
4. Build `callCtx` with the same shape `buildFeatureContext` builds: `runtime`, `packageView:
   runtime.packages.resolve(repoRoot)`, `packageDir: repoRoot`, `config`, `agentName`, `featureName: label`,
   `signal` when an abort signal is given, `askResolver` from the wiring, `commandShadow` when the wiring has
   one.
5. Return the context with `feature: label`, `projectDir: repoRoot`,
   `runDir: workflowRunDir(repoRoot, label, runtime.runId)`, `reportPath: join(runDir, "feature-report.md")`,
   no `prdPath`, `packageDirs: []`, `runSignal` when an abort signal is given, `dryRun: runtime.dryRun === true`,
   `workflow: resolveWorkflowConfig(config)`, and `pr: input.pr`. `dispose` is the wiring's `dispose`.

No branch step reads `pr`: the review range still comes from the step's `seed` input, so B2 passes
`seed = ctx.pr.base`. `pr` is carried for B2's own steps.

The run dir sits inside the checkout under the feature tree on purpose: agents' file tools read review
packages from there (nax#2479), and the feature tree's run artifacts are already git-ignored
(`NAX_GITIGNORE_ENTRIES`). B2 runs in a throwaway worktree of the PR head, so nothing lands in the user's own
checkout. Paths are built with `workflowRunDir` (which goes through `featureDir`), never by hand
(`check:feature-dir-ssot`).

### G4: prompts without a PRD

`BranchReviewPromptInput.prdPath` becomes optional. When it is set the prompt is byte-identical to today. When
it is absent, the PRD line reads:

```
- the PRD (stories and acceptance criteria): (no PRD for this change)
```

`buildWorkflowBranchFixPrompt`'s `prdPath` becomes optional. Its opening "Read ..." sentence becomes:

| specPath | prdPath | sentence |
|---|---|---|
| set | set | `Read the spec (<spec>) and the PRD (<prd>) for what the feature must do.` (today's text) |
| absent | set | `Read the PRD (<prd>) for what the feature must do.` (today's text) |
| set | absent | `Read the spec (<spec>) for what the feature must do.` |
| absent | absent | the sentence is left out; the prompt goes from the first sentence's `only re-checks what is still open.` straight to the blank line and `## Findings to fix` |

The re-review prompt (`buildWorkflowBranchReReviewPrompt`) has no PRD input and is unchanged.

### G4: Integration

Read only, verified on `main` @ `904b0dec5`:

- `buildFeatureContext(input: WorkflowFeatureInput): Promise<{ fc: FeatureContext; dispose }>`
  (`workflow/feature-context.ts`) - the pattern `buildPrStepContext` mirrors for the ask wiring and `callCtx`.
- `workflowRunDir(projectDir, feature, runId): string` (`workflow/paths.ts`).
- `underReviewLimit(sc: Pick<StepContext, "runSignal" | "workflow">, ...)` (`workflow/story-review.ts`) and
  `reviewRequiredFiles(paths, fc: Pick<FeatureContext, "config" | "projectDir" | "packageDirs">)`
  (`workflow/review-coverage.ts`) - already take slices that `BranchStepContext` satisfies; unchanged.
- `buildRunDispatchAskWiring(opts: RunDispatchAskOptions): Promise<DispatchAskWiring>`
  (`interaction/dispatch-ask.ts`).
- `createRuntime(config, workdir, opts?)` (`runtime/index.ts`) - B2's caller creates the runtime; G4 takes one.

Changed. The baseline only locates the code; the target is the interface to implement:

- `runBranchReview` (`workflow/branch-review.ts`)
  - Baseline: `runBranchReview(fc: FeatureContext, input: {...})`
  - Target: `runBranchReview(fc: BranchStepContext, input: {...})`, body unchanged; passes `fc.prdPath`
    through to the prompt only when it is set.
- `runBranchReReview` - Baseline `(fc: FeatureContext, ...)`; Target `(fc: BranchStepContext, ...)`.
- `writeFeatureArtifact` - Baseline `(fc: FeatureContext, name, value)`; Target `(fc: BranchStepContext, ...)`.
- `branchReviewModel` - Baseline `(fc: FeatureContext)`; Target `(fc: BranchStepContext)`.
- The private helpers `appendReviewRules` and `appendProjectContextOverride` (`workflow/branch-review.ts`) -
  Baseline `(fc: FeatureContext, ...)`; Target `(fc: BranchStepContext, ...)`, bodies unchanged.
- `runBranchFix` (`workflow/branch-fix.ts`) - Baseline `(fc: FeatureContext, input)`; Target
  `(fc: BranchStepContext, input)`; the private helpers `ensureReport`, `commitLeftovers`, `runFixSession`
  take `BranchStepContext` too.
- `runRepoGates` (`workflow/repo-gates.ts`) - Baseline `(fc: FeatureContext)`; Target `(fc: BranchStepContext)`.
- `BranchReviewPromptInput` (`prompts/builders/workflow-branch-builder.ts`) - Baseline `readonly prdPath:
  string`; Target `readonly prdPath?: string`.
- `buildWorkflowBranchFixPrompt` input - Baseline `prdPath: string`; Target `prdPath?: string`.
- `packages/nax/src/workflow/index.ts` (barrel) - Target adds `export type { BranchStepContext, PrStepContext,
  PrStepRef } from "./branch-step-context"` and `export type { PrStepContextInput } from "./pr-step-context"`
  and `export { buildPrStepContext } from "./pr-step-context"`.

`FeatureContext` itself does not change. `featureModelFor` and `buildFeatureEnv` keep taking `FeatureContext`.

### B1: types

New file `packages/nax/src/forge/pr-types.ts` (pure types):

```ts
/** One PR on one forge. `repo` is `owner/name` on GitHub, the full project path on GitLab. */
export interface PrRef {
  readonly forge: ForgeKind;
  /** Forge host from the origin remote, passed as --hostname on every call. */
  readonly host: string;
  readonly repo: string;
  readonly number: number;
}

export type PrState = "open" | "closed" | "merged";

export interface PrInfo {
  readonly number: number;
  readonly title: string;
  /** "" when the PR has no description. */
  readonly body: string;
  readonly url: string;
  readonly state: PrState;
  readonly draft: boolean;
  readonly author: { readonly login: string; readonly id?: number };
  readonly baseRef: string;
  readonly headRef: string;
  readonly headSha: string;
  /** True when the head branch lives outside the base repository, or the forge cannot say where. */
  readonly crossRepo: boolean;
  /** GitLab only: the shas an inline comment's position needs. */
  readonly diffRefs?: { readonly baseSha: string; readonly startSha: string; readonly headSha: string };
}

export interface PrTrust {
  readonly trusted: boolean;
  /** The PR head sha this classification was made for (`info.headSha`). A later push needs a new one. */
  readonly headSha: string;
  /** Why, in order of the rules applied. Never empty. */
  readonly reasons: readonly string[];
}

export type PrCommentKind = "thread" | "comment" | "review";

export interface PrComment {
  /** GitHub comment / review id, GitLab note id, as a string. */
  readonly id: string;
  readonly kind: PrCommentKind;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface PrThread {
  /** GitHub review thread node id, GitLab discussion id: what resolveThread takes. */
  readonly id: string;
  /** GitHub first comment's database id, GitLab discussion id: what replyToThread takes. */
  readonly replyTo: string;
  readonly path?: string;
  readonly line?: number;
  readonly resolved: boolean;
  /** GitHub isOutdated; always false on GitLab. */
  readonly outdated: boolean;
  readonly comments: readonly PrComment[];
}

export interface PostedComment {
  readonly id: string;
  /** GitLab inline comment: the discussion it opened. */
  readonly threadId?: string;
  readonly url?: string;
}

export interface CurrentUser {
  readonly login: string;
  readonly id?: number;
}

export interface OwnComment {
  readonly comment: PrComment;
  /** Set when the comment sits in a review thread. */
  readonly threadId?: string;
  readonly key: string;
}
```

### B1: PR reference, details and trust (`forge/pr-read.ts`, `forge/trust.ts`)

- `repoSlugFromRemoteUrl(remoteUrl: string): string | null` - the path of an origin URL in both git forms
  (`git@host:owner/repo.git`, `scheme://[user@]host[:port]/group/sub/proj.git`), with a trailing `.git` and
  slashes removed; null when no path remains. A port is dropped with the host, as `remoteHost` does.
- `resolvePrRef(number: number, deps: ForgeDeps, cwd: string): Promise<PrRef>` - `detectForge(deps, cwd)`,
  then `git remote get-url origin`, `remoteHost(url)` for `host` and `repoSlugFromRemoteUrl(url)` for `repo`.
  A null forge (`detectForge` returned null), a failed remote read, or a null slug throws `NaxError`
  `FORGE_PR_REF_UNRESOLVED`. A non-positive
  or non-integer `number` throws the same code before any call.
- `encodeProjectPath(repo: string): string` - `encodeURIComponent(repo)` (`group/proj` -> `group%2Fproj`), the
  GitLab project id every GitLab endpoint in this feature uses. Every other value interpolated into an
  endpoint path (logins, ids) also goes through `encodeURIComponent`, so `dependabot[bot]` stays one segment.
- `readPrInfo(ref: PrRef, deps, cwd): Promise<PrInfo>`
  - GitHub: `gh api --hostname <host> repos/<repo>/pulls/<number>`. Maps `title`, `body ?? ""`, `html_url`,
    `draft`, `user.login`, `user.id`, `base.ref`, `head.ref`, `head.sha`. `state` is `merged` when
    `merged_at` is non-null, else `state`. `crossRepo` is false only when `head.repo.full_name` and
    `base.repo.full_name` are both non-empty strings and equal; anything else (a deleted fork has
    `head.repo: null`, a missing field) is true.
  - GitLab: `glab api --hostname <host> projects/<encodeURIComponent(repo)>/merge_requests/<number>`. Maps
    `title`, `description ?? ""`, `web_url`, `draft`, `author.username`, `author.id`, `target_branch`,
    `source_branch`, `sha`, `diff_refs.{base_sha,start_sha,head_sha}`. `state`: `opened` -> open, `merged` ->
    merged, anything else -> closed. `crossRepo` is false only when `source_project_id` and
    `target_project_id` are both numbers and equal; anything else is true (fail closed).
  - A non-zero exit throws `NaxError` `FORGE_PR_READ_FAILED`; stdout that does not parse, or lacks
    `head.sha` / `sha`, throws `FORGE_RESPONSE_UNPARSEABLE`.
- `classifyPrTrust(ref: PrRef, info: PrInfo, deps, cwd): Promise<PrTrust>` - never throws. Rules, in order;
  the first that decides wins:
  1. `info.crossRepo` -> untrusted, reason `head branch is not in the base repository`.
  2. The author is the current user -> trusted, reason `author is the current user`. The current user comes
     from `readCurrentUser` (below). When both `info.author.id` and the current user's `id` are known they are
     compared; otherwise the logins are compared.
  3. The author has write access -> trusted, reason `author has write access`.
     GitHub `gh api --hostname <host> repos/<repo>/collaborators/<login>/permission` -> `.permission` is
     `admin` or `write` (the legacy field maps `maintain` to `write`).
     GitLab `glab api --hostname <host> projects/<enc>/members/all/<author.id>` -> `.access_level >= 30`; a
     lookup that exits non-zero with `404` in its stderr means the author is not a member: rule 4.
  4. Otherwise -> untrusted, reason `author has no write access`.
  Rule 1 runs first on purpose, so the current user's own PR from a fork is untrusted too (fail closed; B3's
  `--trust` is the way through). Every result carries `headSha: info.headSha`.
  Any non-zero exit or unparseable reply in rules 2-3 -> untrusted with reason `could not read <what>:
  <stderr, trimmed, first 200 chars>`; a GitLab author with no `id` cannot be looked up and is untrusted the
  same way.
- `readCurrentUser(ref, deps, cwd): Promise<CurrentUser>` - GitHub `gh api --hostname <host> user` ->
  `{ login: .login, id: .id }`; GitLab `glab api --hostname <host> user` -> `{ login: .username, id: .id }`. A
  non-zero exit throws `FORGE_USER_READ_FAILED`; an unparseable reply or a missing login throws
  `FORGE_RESPONSE_UNPARSEABLE`. `classifyPrTrust` catches both and turns them into a `could not read` reason.
- Nothing here reads the PR's title, body, diff or comments: trust comes from forge metadata only
  (§5a), and nothing is cached or stored.

### B1: reading threads and comments (`forge/threads.ts`)

- `listReviewThreads(ref, deps, cwd): Promise<PrThread[]>`
  - GitHub: GraphQL through `gh api --hostname <host> graphql -f query=<Q> -f owner=<owner> -f name=<name>
    -F number=<number>` plus `-f endCursor=<cursor>` after the first page, where `<owner>/<name>` is `ref.repo`
    split at the first `/`. `Q` selects `repository.pullRequest.reviewThreads(first: 100, after: $endCursor)`
    with `pageInfo { hasNextPage endCursor }` and per node `id isResolved isOutdated path line originalLine
    comments(first: 100) { nodes { databaseId author { login } body createdAt } }`. Loops while
    `hasNextPage`. A thread maps to `id`, `replyTo = String(comments[0].databaseId)`, `path`,
    `line = line ?? originalLine` (absent when both are null), `resolved = isResolved`,
    `outdated = isOutdated`, comments of kind `thread` with `id = String(databaseId)`, `author =
    author.login` (a deleted author reads as `ghost`), `body`, `createdAt` (the `id` is what `editComment`
    takes).
  - GitLab: `glab api --hostname <host> projects/<enc>/merge_requests/<number>/discussions?per_page=100&page=<p>`
    for `p = 1, 2, ...` until a page returns fewer than 100 items. Discussions with `individual_note: false`
    are threads: `id = replyTo = discussion.id`, `path = notes[0].position?.new_path ?? old_path`,
    `line = notes[0].position?.new_line ?? old_line`, `resolved = notes[0].resolved === true`,
    `outdated: false`, comments = the non-system notes, kind `thread`, `id = String(note.id)`,
    `author = note.author.username`, `createdAt = note.created_at`.
- `listPrComments(ref, deps, cwd): Promise<PrComment[]>` - top-level comments, not in any thread.
  - GitHub: `gh api --hostname <host> repos/<repo>/issues/<number>/comments?per_page=100&page=<p>` (kind
    `comment`: `id = String(id)`, `author = user.login`, `body`, `createdAt = created_at`), then
    `.../pulls/<number>/reviews?per_page=100&page=<p>` keeping reviews with a non-empty `body` (kind `review`:
    `id = String(id)`, `author = user.login`, `createdAt = submitted_at`). Same page loop rule. A `user` of
    null (deleted account) reads as author `ghost`.
  - GitLab: the discussions endpoint above; discussions with `individual_note: true` give their one note
    when it is not `system: true`, kind `comment`.
- Both: a page loop stops with `NaxError` `FORGE_PAGINATION_LIMIT` when a 51st page would be needed (GitHub
  `hasNextPage` still true after page 50, or a full 100-item REST/GitLab page 50), with
  `MAX_FORGE_PAGES = 50` exported; a
  non-zero exit throws `FORGE_THREADS_READ_FAILED` (threads) or `FORGE_COMMENTS_READ_FAILED` (comments); an
  unparseable page throws `FORGE_RESPONSE_UNPARSEABLE`. Items keep the forge's order.

### B1: writing (`forge/comments.ts`) and the marker (`forge/marker.ts`)

Every string field goes on the argv as `-f key=value` (raw field), never `-F`: `gh`/`glab` read `-F
key=@path` as a file, so a body or path starting with `@` would post a local file. Integers use `-F`.

`glab api` does not nest bracketed field names: `-f position[new_line]=5` is sent as the flat JSON key
`"position[new_line]"`, which GitLab does not read as a position (checked with glab 1.100.0 against a stub
server, 2026-10-20). So the GitLab inline comment puts its `position` in the endpoint's query string, built
with `URLSearchParams` (GitLab merges query and body params), and sends only `-f body=` as a field. `--form`
is never used: it uploads any value starting with `@` as a file.

| Function | GitHub argv (after `gh api --hostname <host>`) | GitLab argv (after `glab api --hostname <host>`) | Returns |
|---|---|---|---|
| `postInlineComment(ref, { path, line, body, headSha, diffRefs? })` | `-X POST repos/<repo>/pulls/<n>/comments -f body= -f commit_id=<headSha> -f path= -F line= -f side=RIGHT` | `-X POST projects/<enc>/merge_requests/<n>/discussions?<query> -f body=`, where `<query>` is `URLSearchParams` of `position[position_type]=text`, `position[base_sha]`, `position[start_sha]`, `position[head_sha]` (from `diffRefs`), `position[old_path]=<path>`, `position[new_path]=<path>`, `position[new_line]=<line>` | GitHub `{ id: String(id), url: html_url }`; GitLab `{ id: String(notes[0].id), threadId: id }` |
| `postPrComment(ref, body)` | `-X POST repos/<repo>/issues/<n>/comments -f body=` | `-X POST projects/<enc>/merge_requests/<n>/notes -f body=` | `{ id, url? }` |
| `replyToThread(ref, thread: Pick<PrThread, "replyTo">, body)` | `-X POST repos/<repo>/pulls/<n>/comments/<replyTo>/replies -f body=` | `-X POST projects/<enc>/merge_requests/<n>/discussions/<replyTo>/notes -f body=` | `{ id, url? }` |
| `resolveThread(ref, thread: Pick<PrThread, "id">)` | `graphql -f query=<resolveReviewThread mutation> -f id=<id>` | `-X PUT projects/<enc>/merge_requests/<n>/discussions/<id> -f resolved=true` | `void` |
| `editComment(ref, comment: Pick<PrComment, "id" \| "kind">, body)` | kind `comment`: `-X PATCH repos/<repo>/issues/comments/<id> -f body=`; kind `thread`: `-X PATCH repos/<repo>/pulls/comments/<id> -f body=` | `-X PUT projects/<enc>/merge_requests/<n>/notes/<id> -f body=` | `void` |

Checks before any call: an empty or whitespace-only body throws `FORGE_COMMENT_EMPTY`; a body longer than
`MAX_FORGE_COMMENT_CHARS = 65_536` throws `FORGE_COMMENT_TOO_LONG`; a GitLab inline comment without
`diffRefs` throws `FORGE_DIFF_REFS_REQUIRED`; editing a GitHub comment of kind `review` throws
`FORGE_EDIT_UNSUPPORTED`; an inline `line` that is not a positive integer, or an empty `path`, throws
`FORGE_COMMENT_TARGET_INVALID`; an id interpolated into a URL path that fails its pattern throws
`FORGE_ID_INVALID`: GitHub `replyTo` and comment `id` must be all digits, a GitLab discussion id (`replyTo`,
thread `id`) must match `^[A-Za-z0-9_-]{1,64}$`, and a GitLab note `id` must be all digits. B2 may pass ids
that came from agent output, so `d1/../x` must never reach a path. The body length is `body.length` (UTF-16 code units,
which never undercounts characters). A non-zero exit throws `FORGE_COMMENT_WRITE_FAILED` with `stage: "forge"`,
`forge`, `exitCode` and the trimmed stderr in the context. Writes are never retried: a retried POST can post
twice. All of this lives in two shared helpers in `forge/comments.ts`: `assertCommentBody(body)` (the empty and
length checks) and `runForgeWrite(ref, argv, deps, cwd)` (one `deps.run`, the non-zero-exit error, JSON reply
parsing), which every write function goes through.

Every `NaxError` this feature's forge functions throw carries `stage: "forge"` in its context
(`.nax/rules/error-handling.md`).

Marker (`forge/marker.ts`):

- `NAX_BOT_HEADER = "**nax bot**"`.
- `withNaxBotMarker(body: string, key: string): string` returns
  `` `${NAX_BOT_HEADER}\n\n${body}\n\n<!-- nax-bot:v1 key=${key} -->` ``. `key` must match
  `^[A-Za-z0-9._:-]{1,128}$`, else `NaxError` `FORGE_MARKER_KEY_INVALID` (so a key can never close the HTML
  comment early).
- `parseNaxBotMarker(body: string): { key: string } | null` - the key of the last
  `<!-- nax-bot:v1 key=<key> -->` in the body whose key matches the same pattern, else null.
- `findOwnComments(ref, deps, cwd): Promise<OwnComment[]>` - `readCurrentUser`, then `listReviewThreads`, then
  `listPrComments`; every comment whose body parses to a marker **and whose author is the current user's
  login**, with the thread's `id` as `threadId` for thread comments. Thread comments come first, in thread
  order. Anyone can paste a marker into a comment; only the author check makes it nax bot's own (R7: nax bot
  posts as the user's login). A failure of any of the three reads propagates.

`forge/index.ts` (the barrel; `check:alias-internals` forbids reaching past it) exports every function,
constant and type above.

### Failure Handling

| Case | Behaviour |
|---|---|
| `buildPrStepContext` with a bad `pr` (number not a positive integer, empty base or head) | throws `PR_STEP_CONTEXT_INVALID`; ask wiring not built |
| `buildPrStepContext`: the ask wiring throws | the error propagates; no context returned |
| Branch steps called with a context that has no `prdPath` | prompts use the no-PRD text (Design); steps otherwise behave as inside a run |
| `resolvePrRef`: no forge, no origin, no slug, bad number | throws `FORGE_PR_REF_UNRESOLVED` |
| `readPrInfo`: CLI exits non-zero | throws `FORGE_PR_READ_FAILED` |
| `readPrInfo`: reply not JSON or missing the head sha | throws `FORGE_RESPONSE_UNPARSEABLE` |
| `classifyPrTrust`: any lookup fails | untrusted with a `could not read ...` reason; never throws |
| GitLab member lookup exits non-zero with `404` | untrusted, reason `author has no write access` |
| `readCurrentUser`: CLI exits non-zero / reply unparseable | throws `FORGE_USER_READ_FAILED` / `FORGE_RESPONSE_UNPARSEABLE` |
| GitHub REST comment or review with `user: null` | author `ghost` |
| Thread / comment reads: CLI exits non-zero | throws `FORGE_THREADS_READ_FAILED` / `FORGE_COMMENTS_READ_FAILED` |
| Thread / comment reads: page not JSON | throws `FORGE_RESPONSE_UNPARSEABLE` |
| Thread / comment reads: more than 50 pages | throws `FORGE_PAGINATION_LIMIT` |
| Writes: empty body / body over 65,536 chars | throws `FORGE_COMMENT_EMPTY` / `FORGE_COMMENT_TOO_LONG`, no CLI call |
| GitLab inline comment without `diffRefs` | throws `FORGE_DIFF_REFS_REQUIRED`, no CLI call |
| GitHub edit of a `review` comment | throws `FORGE_EDIT_UNSUPPORTED`, no CLI call |
| Inline `line` not a positive integer, or empty `path` | throws `FORGE_COMMENT_TARGET_INVALID`, no CLI call |
| A GitHub or GitLab id that fails its pattern | throws `FORGE_ID_INVALID`, no CLI call |
| GitLab MR reply without both project ids | `crossRepo: true` (fail closed) |
| Writes: CLI exits non-zero | throws `FORGE_COMMENT_WRITE_FAILED`; no retry |
| Marker key outside `^[A-Za-z0-9._:-]{1,128}$` | throws `FORGE_MARKER_KEY_INVALID` |

## Out of Scope

- The `nax bot review` and `nax bot fix` commands, their graphs, CLI wiring and command name (Q2) are B2 and B3; this feature adds no CLI command and no production caller of `buildPrStepContext` or of any new forge function.
- Deciding which config a PR is reviewed under (loading config, rules, plugins and hooks from the base branch, master plan §5a) is B2; `buildPrStepContext` takes the config it is given.
- The static review mode for untrusted PRs (no Bash, no gates, no network) is B2, and `--trust` with sandboxed gates is B3; `classifyPrTrust` only returns the classification.
- Allowing `n/a` in the branch review verdict's `spec` field, and judging intent from the PR description and linked issues (R9), are B2; the verdict schema and `workflowBranchReviewOp` do not change here.
- Checking out the PR head into a throwaway worktree, and persisting bot run state under the nax output dir, are B2.
- Rendering and escaping comment text from agent output, and any length cap stricter than the forge limit, are B2; the forge write functions post the body they are given.
- Whether `nax bot fix` resolves threads (Q1) is B3; `resolveThread` is only the capability.
- The story-loop steps keep `StepContext`; giving them a narrow context is not needed by the bot and is not done here.
- The publish and final-gate steps (`publish`, `finalize.ts`) keep `FeatureContext`; the bot posts through the new forge functions instead.
- `FeatureContext`, `buildFeatureContext`, `buildFeatureEnv` and `featureModelFor` do not change.
- A repo whose `origin` is a fork of the PR's base repo resolves to the fork's slug; detecting the upstream remote is not done.
- Review thread comments past the first 100 in one thread are not read (GitHub GraphQL `comments(first: 100)`).
- GitLab threads always report `outdated: false`; detecting outdated GitLab positions is not done.
- Multi-line inline comments (`start_line`, GitLab line ranges) are not supported; an inline comment targets one new-side line, and a GitLab comment on an unchanged context line (which needs `old_line`) is not supported.
- Forge hosts with a port (`git.corp:8443`) are not supported: `remoteHost` drops the port and `glab api --hostname` rejects `host:port`.
- US-005 only: a trust result is never cached or stored; each call reads the forge again (§5a forbids a standing setting). Re-checking trust after a push is the caller's job, using `PrTrust.headSha`.
- US-005 only: GitHub organisation team permissions beyond the collaborator permission endpoint are not read.
- US-008 only: rate-limit back-off and retrying a failed write are not done; a retried POST can post twice.
- Pipeline mode is frozen: no pipeline-only code is touched.
- One live check of the forge functions against a throwaway PR is a manual step after merge, with the user's go; no test posts to a real forge.
- No release is part of this feature.

## Stories

Eleven stories: two for G4 and nine for B1, which is one capability (forge PR access). The bundle of the two is
the user's ruling (2026-10-20). The stories are cut so each stays at or under the 24-AC cap after `nax plan`
splits compound ACs into one assertion each.

### US-001: Branch steps take a narrow context and accept a missing PRD
No dependencies. Workdir: packages/nax.

Adds `BranchStepContext`, `PrStepRef` and `PrStepContext` in `src/workflow/branch-step-context.ts`. Changes the
parameter type of `runBranchReview`, `runBranchReReview`, `writeFeatureArtifact`, `branchReviewModel`,
`appendReviewRules`, `appendProjectContextOverride`, `runBranchFix` (and its private helpers) and
`runRepoGates` to `BranchStepContext`, with no change to their bodies beyond passing `prdPath` to a prompt only
when it is set. Makes `prdPath` optional in `BranchReviewPromptInput` and in `buildWorkflowBranchFixPrompt`,
with the no-PRD text in Design. Inside `nax run` every call passes the same `FeatureContext` as today. This
story's tests build a `BranchStepContext` literal by hand, with no `prdPath`.

### US-002: Build a step context for a PR outside a run
Depends on US-001. Workdir: packages/nax.

Adds `buildPrStepContext`, `PrStepContextInput` and `_prStepContextDeps` in `src/workflow/pr-step-context.ts`,
per Design, and exports `buildPrStepContext` and the US-001 and US-002 types from the `@/workflow` barrel.

### US-003: PR reference
No dependencies. Workdir: packages/nax.

Adds the B1 types in `src/forge/pr-types.ts`, and `repoSlugFromRemoteUrl`, `encodeProjectPath` and
`resolvePrRef` in `src/forge/pr-read.ts`, per Design, exported from `@/forge`.

### US-004: PR details
Depends on US-003. Workdir: packages/nax.

Adds `readPrInfo` to `src/forge/pr-read.ts` (created by US-003), for GitHub and GitLab, with the fail-closed
`crossRepo` rule, per Design, exported from `@/forge`.

### US-005: Current user and PR trust classification
Depends on US-004. Workdir: packages/nax.

Adds `readCurrentUser` and `classifyPrTrust` in `src/forge/trust.ts`, for GitHub and GitLab, with the ordered
rules and the fail-closed behaviour in Design, exported from `@/forge`.

### US-006: Read review threads
Depends on US-003. Workdir: packages/nax.

Adds `listReviewThreads`, `MAX_FORGE_PAGES` and the shared page loop in `src/forge/threads.ts`, for GitHub
(GraphQL cursor loop) and GitLab (discussions page loop), per Design, exported from `@/forge`.

### US-007: Read top-level comments
Depends on US-006. Workdir: packages/nax.

Adds `listPrComments` to `src/forge/threads.ts` (created by US-006), for GitHub (issue comments, then review
bodies) and GitLab (individual-note discussions), reusing US-006's page loop, per Design, exported from
`@/forge`. Its tests also pin the GitLab discussions page loop that both readers share.

### US-008: Write guards and the summary comment
Depends on US-003. Workdir: packages/nax.

Adds `src/forge/comments.ts` with `MAX_FORGE_COMMENT_CHARS`, the shared `assertCommentBody` and `runForgeWrite`
helpers, and `postPrComment`, for GitHub and GitLab, per Design, exported from `@/forge`. Every later write goes
through these two helpers.

### US-009: Post an inline comment
Depends on US-008. Workdir: packages/nax.

Adds `postInlineComment` to `src/forge/comments.ts` (created by US-008), for GitHub and GitLab (GitLab position
in the query string), going through US-008's helpers, per Design, exported from `@/forge`.

### US-010: Reply in a thread, resolve a thread, edit a comment
Depends on US-008. Workdir: packages/nax.

Adds `replyToThread`, `resolveThread` and `editComment` to `src/forge/comments.ts` (created by US-008), with the
id patterns in Design, going through US-008's helpers, exported from `@/forge`.

### US-011: The nax bot marker and finding nax bot's own comments
Depends on US-005, US-006, US-007. Workdir: packages/nax.

Adds `NAX_BOT_HEADER`, `withNaxBotMarker`, `parseNaxBotMarker` and `findOwnComments` in `src/forge/marker.ts`,
per Design, exported from `@/forge`. `findOwnComments` reads through US-005's `readCurrentUser` and US-006 and
US-007's `listReviewThreads` and `listPrComments`, and keeps only marked comments by the current user.

### Context Files

**US-001**
- `packages/nax/src/workflow/feature-context.ts`
- `packages/nax/src/workflow/branch-review.ts`
- `packages/nax/src/workflow/branch-fix.ts`
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts`
- `packages/nax/test/unit/workflow/branch-review.test.ts`

**US-002**
- `packages/nax/src/workflow/branch-step-context.ts` — created by US-001, used here
- `packages/nax/src/workflow/feature-context.ts`
- `packages/nax/src/workflow/branch-review.ts`
- `packages/nax/src/workflow/step-context.ts`
- `packages/nax/src/interaction/dispatch-ask.ts`

**US-003**
- `packages/nax/src/forge/detect.ts`
- `packages/nax/src/forge/pr.ts`
- `packages/nax/src/forge/types.ts`
- `packages/nax/src/forge/index.ts`
- `packages/nax/test/unit/forge/detect.test.ts`

**US-004**
- `packages/nax/src/forge/pr-types.ts` — created by US-003, used here
- `packages/nax/src/forge/pr-read.ts` — created by US-003, extended here
- `packages/nax/test/unit/forge/pr-read.test.ts` — created by US-003, extended here
- `packages/nax/src/forge/pr.ts`

**US-005**
- `packages/nax/src/forge/pr-types.ts` — created by US-003, used here
- `packages/nax/src/forge/pr-read.ts` — created by US-003, used here
- `packages/nax/src/forge/index.ts`
- `packages/nax/test/unit/forge/pr.test.ts`

**US-006**
- `packages/nax/src/forge/pr-types.ts` — created by US-003, used here
- `packages/nax/src/forge/pr-read.ts` — created by US-003, used here
- `packages/nax/src/forge/index.ts`
- `packages/nax/test/unit/forge/pr.test.ts`

**US-007**
- `packages/nax/src/forge/pr-types.ts` — created by US-003, used here
- `packages/nax/src/forge/threads.ts` — created by US-006, extended here
- `packages/nax/test/unit/forge/threads.test.ts` — created by US-006, used here
- `packages/nax/src/forge/index.ts`

**US-008**
- `packages/nax/src/forge/pr-types.ts` — created by US-003, used here
- `packages/nax/src/forge/pr-read.ts` — created by US-003, used here
- `packages/nax/src/forge/index.ts`
- `packages/nax/test/unit/forge/pr.test.ts`

**US-009**
- `packages/nax/src/forge/pr-types.ts` — created by US-003, used here
- `packages/nax/src/forge/comments.ts` — created by US-008, extended here
- `packages/nax/test/unit/forge/comments.test.ts` — created by US-008, used here
- `packages/nax/src/forge/index.ts`

**US-010**
- `packages/nax/src/forge/pr-types.ts` — created by US-003, used here
- `packages/nax/src/forge/comments.ts` — created by US-008, extended here
- `packages/nax/test/unit/forge/comments.test.ts` — created by US-008, used here
- `packages/nax/src/forge/index.ts`

**US-011**
- `packages/nax/src/forge/pr-types.ts` — created by US-003, used here
- `packages/nax/src/forge/trust.ts` — created by US-005, used here
- `packages/nax/src/forge/threads.ts` — created by US-006, used here
- `packages/nax/test/unit/forge/threads.test.ts` — created by US-006, used here
- `packages/nax/src/forge/index.ts`

### Creates

**US-001**
- `packages/nax/src/workflow/branch-step-context.ts`
- `packages/nax/test/unit/workflow/branch-steps-no-prd.test.ts`
- `packages/nax/test/unit/prompts/workflow-branch-builder-no-prd.test.ts`

**US-002**
- `packages/nax/src/workflow/pr-step-context.ts`
- `packages/nax/test/unit/workflow/pr-step-context.test.ts`

**US-003**
- `packages/nax/src/forge/pr-types.ts`
- `packages/nax/src/forge/pr-read.ts`
- `packages/nax/test/unit/forge/pr-read.test.ts`

**US-004**
- `packages/nax/test/unit/forge/pr-read-info.test.ts`

**US-005**
- `packages/nax/src/forge/trust.ts`
- `packages/nax/test/unit/forge/trust.test.ts`

**US-006**
- `packages/nax/src/forge/threads.ts`
- `packages/nax/test/unit/forge/threads.test.ts`

**US-007**
- `packages/nax/test/unit/forge/threads-comments.test.ts`

**US-008**
- `packages/nax/src/forge/comments.ts`
- `packages/nax/test/unit/forge/comments.test.ts`

**US-009**
- `packages/nax/test/unit/forge/comments-inline.test.ts`

**US-010**
- `packages/nax/test/unit/forge/comments-threads.test.ts`

**US-011**
- `packages/nax/src/forge/marker.ts`
- `packages/nax/test/unit/forge/marker.test.ts`

The no-PRD tests sit in new files beside the existing `branch-review`, `branch-fix` and prompt-builder tests on
purpose: those files are the unchanged-behaviour proof and stay byte-identical. A story that extends a file an
earlier story of this feature creates says so in its own description; that file is not listed under Modifies,
which names only files that exist before the run.

### Modifies

**US-001**
- `packages/nax/src/workflow/branch-review.ts` — parameter type of `runBranchReview`, `runBranchReReview`, `writeFeatureArtifact`, `branchReviewModel` and the private helpers `appendReviewRules` and `appendProjectContextOverride` becomes `BranchStepContext`; `prdPath` is passed to the prompt only when set; bodies otherwise unchanged. No existing test changes: with `prdPath` set the step is identical.
- `packages/nax/src/workflow/branch-fix.ts` — parameter type of `runBranchFix` and its private helpers becomes `BranchStepContext`; `prdPath` is passed to the prompt only when set; bodies otherwise unchanged. No existing test changes: with `prdPath` set the step is identical.
- `packages/nax/src/workflow/repo-gates.ts` — parameter type of `runRepoGates` becomes `BranchStepContext`; body unchanged. No existing test changes.
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts` — `prdPath` becomes optional in `BranchReviewPromptInput` and in `buildWorkflowBranchFixPrompt`'s input, with the no-PRD text from Design; output with `prdPath` set stays byte-identical, so no existing prompt-builder test changes.

**US-002**
- `packages/nax/src/workflow/index.ts` — barrel exports `BranchStepContext`, `PrStepContext`, `PrStepRef`, `PrStepContextInput` and `buildPrStepContext`.

**US-003**
- `packages/nax/src/forge/index.ts` — barrel exports the US-003 types, `repoSlugFromRemoteUrl`, `encodeProjectPath` and `resolvePrRef`.

**US-004**
- `packages/nax/src/forge/index.ts` — barrel exports `readPrInfo`.

**US-005**
- `packages/nax/src/forge/index.ts` — barrel exports `readCurrentUser` and `classifyPrTrust`.

**US-006**
- `packages/nax/src/forge/index.ts` — barrel exports `listReviewThreads` and `MAX_FORGE_PAGES`.

**US-007**
- `packages/nax/src/forge/index.ts` — barrel exports `listPrComments`.

**US-008**
- `packages/nax/src/forge/index.ts` — barrel exports `postPrComment` and `MAX_FORGE_COMMENT_CHARS`.

**US-009**
- `packages/nax/src/forge/index.ts` — barrel exports `postInlineComment`.

**US-010**
- `packages/nax/src/forge/index.ts` — barrel exports `replyToThread`, `resolveThread` and `editComment`.

**US-011**
- `packages/nax/src/forge/index.ts` — barrel exports `NAX_BOT_HEADER`, `withNaxBotMarker`, `parseNaxBotMarker` and `findOwnComments`.

### Seams

- US-002's `buildPrStepContext` produces the `BranchStepContext` US-001 defines; US-002's integration AC drives
  the real `runBranchReview` with a context it built, faking only `_workflowDeps.callOp`.
- `buildPrStepContext` has no production caller in this feature; B2 is its first.
- US-004 to US-011 consume US-003's `PrRef`; their tests build a `PrRef` by hand and assert the argv each
  function hands to `ForgeDeps.run`, which is the production boundary of the forge layer.
- US-009 and US-010 go through US-008's `runForgeWrite`; their write-failure ACs prove it (one call, the
  `FORGE_COMMENT_WRITE_FAILED` error).
- US-011's `findOwnComments` calls US-005's `readCurrentUser` and US-006/US-007's `listReviewThreads` and
  `listPrComments`; its ACs drive it with a mocked `ForgeDeps` that answers all three endpoints and assert
  each was read.

## Acceptance Criteria

Verification note for every story: tests import each new symbol through its barrel (`@/workflow` or
`@/forge`), so a missing export fails the story's own tests; `bun run typecheck` and `bun run check:all` (which
runs `check:alias-internals`) are the static gates.

### US-001

Verification note: the G0 equivalence suites (`test/unit/workflow/feature-machine-equivalence.test.ts`,
`test/unit/workflow/story-loop-equivalence.test.ts`) and the existing branch-review, branch-fix, repo-gates and
prompt-builder tests run with no edit; `bun run typecheck` proves a `FeatureContext` is still accepted by every
changed step.

- [unit] `buildWorkflowBranchReviewPrompt` called with no `prdPath` returns a prompt containing the line `- the PRD (stories and acceptance criteria): (no PRD for this change)`.
- [unit] `buildWorkflowBranchReviewPrompt` called with `prdPath: "/r/.nax/features/f/prd.json"` returns a prompt containing the line `- the PRD (stories and acceptance criteria): /r/.nax/features/f/prd.json`.
- [unit] `buildWorkflowBranchFixPrompt` called with `specPath: "docs/s.md"` and no `prdPath` returns a prompt whose first paragraph ends with `Read the spec (docs/s.md) for what the feature must do.`
- [unit] `buildWorkflowBranchFixPrompt` called with neither `specPath` nor `prdPath` returns a prompt whose first paragraph ends with `only re-checks what is still open.`
- [unit] `buildWorkflowBranchFixPrompt` called with `specPath: "docs/s.md"` and `prdPath: "p.json"` returns a prompt whose first paragraph ends with `Read the spec (docs/s.md) and the PRD (p.json) for what the feature must do.`
- [unit] `buildWorkflowBranchFixPrompt` called with no `specPath` and `prdPath: "p.json"` returns a prompt whose first paragraph ends with `Read the PRD (p.json) for what the feature must do.`
- [integration] `runBranchReview` called with a hand-built `BranchStepContext` that has no `prdPath` (and `_workflowDeps.callOp` faked) passes `workflowBranchReviewOp` a prompt containing `(no PRD for this change)`.
- [integration] the same `runBranchReview` call writes `package-branch.diff` inside the context's `runDir`.
- [integration] `runBranchReview` called with a `FeatureContext` from `buildFeatureContext` passes `workflowBranchReviewOp` a prompt containing that context's `prdPath`.
- [integration] `runBranchReReview` called with a hand-built `BranchStepContext` with no `prdPath` writes `package-branch-fix.diff` inside the context's `runDir`.
- [integration] the same `runBranchReReview` call invokes `_workflowDeps.callOp` with `workflowReReviewOp`.
- [integration] `runBranchFix` called with a hand-built `BranchStepContext` with no `prdPath` passes `workflowBranchFixOp` an input whose `reportPath` is the context's `reportPath`.
- [integration] the same `runBranchFix` call passes `workflowBranchFixOp` a prompt in which the text `the PRD (` is absent.
- [integration] the same `runBranchFix` call, with feature `bot-pr-42` and no report file yet, creates the report file whose first line is `# Feature report — bot-pr-42`.
- [integration] `runRepoGates` called with a hand-built `BranchStepContext` whose `packageDirs` is empty calls `_featureDeps.resolveGateCommands` with the context's `projectDir` and an empty package list.

### US-002

- [unit] `buildPrStepContext` with `pr: { forge: "github", number: 42, base: "abc", head: "def" }` returns a context whose `feature` is `bot-pr-42`.
- [unit] the same call returns `runDir` equal to `workflowRunDir(repoRoot, "bot-pr-42", runtime.runId)`.
- [unit] the same call returns `reportPath` equal to the returned `runDir` joined with `feature-report.md`.
- [unit] the same call returns a context whose `prdPath` is undefined.
- [unit] the same call returns a context whose `packageDirs` is an empty array.
- [unit] the same call returns a context whose `pr` equals the input `pr`.
- [unit] `buildPrStepContext` passes `_prStepContextDeps.buildRunDispatchAskWiring` an options object whose `stage` is `merge`.
- [unit] the options object passed to `buildRunDispatchAskWiring` has `featureName` equal to `bot-pr-42`.
- [unit] the options object passed to `buildRunDispatchAskWiring` has `projectDir` and `repoRoot` both equal to the input `repoRoot`.
- [unit] the options object passed to `buildRunDispatchAskWiring` has `runId` equal to `runtime.runId`.
- [unit] the returned `callCtx.askResolver` is the wiring's `askResolver`.
- [unit] when the wiring returns a `commandShadow`, the returned `callCtx.commandShadow` is that `commandShadow`.
- [unit] calling the returned `dispose` calls the wiring's `dispose` once.
- [unit] `buildPrStepContext` with an `abortSignal` returns that signal as `runSignal`.
- [unit] `buildPrStepContext` with an `abortSignal` returns that signal as `callCtx.signal`.
- [unit] `buildPrStepContext` with a runtime whose `dryRun` is true returns `dryRun: true`.
- [unit] `buildPrStepContext` with `pr.number` of `0` rejects with a `NaxError` whose code is `PR_STEP_CONTEXT_INVALID`.
- [unit] the same call with `pr.number` of `0` never calls `buildRunDispatchAskWiring`.
- [unit] `buildPrStepContext` with `pr.number` of `1.5` rejects with a `NaxError` whose code is `PR_STEP_CONTEXT_INVALID`.
- [unit] `buildPrStepContext` with `pr.head` of `"  "` rejects with a `NaxError` whose code is `PR_STEP_CONTEXT_INVALID`.
- [unit] `buildPrStepContext` with `pr.base` of `""` rejects with a `NaxError` whose code is `PR_STEP_CONTEXT_INVALID`.
- [unit] when `buildRunDispatchAskWiring` rejects with an error, `buildPrStepContext` rejects with that same error.
- [integration] `runBranchReview` called with a context from `buildPrStepContext` (with `_workflowDeps.callOp` faked) writes `package-branch.diff` under the checkout at `.nax/features/bot-pr-42/workflow/<runId>/`.

### US-003

- [unit] `repoSlugFromRemoteUrl("git@github.com:acme/widgets.git")` returns `acme/widgets`.
- [unit] `repoSlugFromRemoteUrl("https://gitlab.example.com/group/sub/proj.git/")` returns `group/sub/proj`.
- [unit] `repoSlugFromRemoteUrl("ssh://git@gitlab.example.com:2222/group/proj.git")` returns `group/proj`.
- [unit] `repoSlugFromRemoteUrl("https://github.com/")` returns null.
- [unit] `encodeProjectPath("group/sub/proj")` returns `group%2Fsub%2Fproj`.
- [unit] `resolvePrRef(7, deps, cwd)` with a mocked `ForgeDeps` whose `git remote get-url origin` returns `git@gitlab.example.com:group/proj.git` returns `{ forge: "gitlab", host: "gitlab.example.com", repo: "group/proj", number: 7 }`.
- [unit] `resolvePrRef` with an origin of `https://github.com/acme/widgets.git` returns `forge: "github"`, `host: "github.com"` and `repo: "acme/widgets"`.
- [unit] `resolvePrRef` rejects with a `NaxError` whose code is `FORGE_PR_REF_UNRESOLVED` when `detectForge` resolves the forge to null.
- [unit] `resolvePrRef` rejects with `FORGE_PR_REF_UNRESOLVED` when the origin read exits non-zero.
- [unit] `resolvePrRef` rejects with `FORGE_PR_REF_UNRESOLVED` when the origin URL yields no slug.
- [unit] `resolvePrRef(0, deps, cwd)` rejects with `FORGE_PR_REF_UNRESOLVED`.
- [unit] `resolvePrRef(0, deps, cwd)` makes no `ForgeDeps.run` call.
- [unit] the `FORGE_PR_REF_UNRESOLVED` error's context holds `stage: "forge"`.

### US-004

- [unit] `readPrInfo` for a GitHub `PrRef` runs `gh api --hostname <host> repos/<repo>/pulls/<number>`.
- [unit] `readPrInfo` for GitHub maps a reply with `merged_at` set to `state: "merged"`.
- [unit] `readPrInfo` for GitHub maps a reply with `body: null` to `body: ""`.
- [unit] `readPrInfo` for GitHub maps `head.sha` to `headSha`.
- [unit] `readPrInfo` for GitHub maps `user.login` to `author.login`.
- [unit] `readPrInfo` for GitHub returns `crossRepo: true` when `head.repo` is null.
- [unit] `readPrInfo` for GitHub returns `crossRepo: true` when `head.repo.full_name` differs from `base.repo.full_name`.
- [unit] `readPrInfo` for GitHub returns `crossRepo: false` when `head.repo.full_name` equals `base.repo.full_name`.
- [unit] `readPrInfo` for GitHub returns `crossRepo: true` when `base.repo` is missing from the reply.
- [unit] `readPrInfo` for a GitLab `PrRef` with repo `group/proj` runs `glab api --hostname <host> projects/group%2Fproj/merge_requests/<number>`.
- [unit] `readPrInfo` for GitLab maps `state: "opened"` to `state: "open"`.
- [unit] `readPrInfo` for GitLab maps `sha` to `headSha`.
- [unit] `readPrInfo` for GitLab maps `diff_refs.base_sha` to `diffRefs.baseSha`.
- [unit] `readPrInfo` for GitLab maps `diff_refs.start_sha` to `diffRefs.startSha`.
- [unit] `readPrInfo` for GitLab returns `crossRepo: true` when `source_project_id` differs from `target_project_id`.
- [unit] `readPrInfo` for GitLab returns `crossRepo: false` when `source_project_id` equals `target_project_id`.
- [unit] `readPrInfo` for GitLab returns `crossRepo: true` when the reply has neither `source_project_id` nor `target_project_id`.
- [unit] `readPrInfo` rejects with `FORGE_PR_READ_FAILED` when the command exits non-zero.
- [unit] `readPrInfo` rejects with `FORGE_RESPONSE_UNPARSEABLE` when stdout is not JSON.
- [unit] `readPrInfo` for GitHub rejects with `FORGE_RESPONSE_UNPARSEABLE` when the reply has no `head.sha`.

### US-005

- [unit] `readCurrentUser` for GitHub runs `gh api --hostname <host> user` and returns `login` from the reply's `login`.
- [unit] `readCurrentUser` for GitHub returns `id` from the reply's `id`.
- [unit] `readCurrentUser` for GitLab runs `glab api --hostname <host> user` and returns `login` from the reply's `username`.
- [unit] `readCurrentUser` rejects with `FORGE_USER_READ_FAILED` when the command exits non-zero.
- [unit] `readCurrentUser` rejects with `FORGE_RESPONSE_UNPARSEABLE` when the reply has no login.
- [unit] `classifyPrTrust` with `info.crossRepo: true` returns `trusted: false` with reason `head branch is not in the base repository`.
- [unit] `classifyPrTrust` with `info.crossRepo: true` makes no `ForgeDeps.run` call.
- [unit] `classifyPrTrust` returns `headSha` equal to `info.headSha`.
- [unit] `classifyPrTrust` on GitHub returns `trusted: true` with reason `author is the current user` when the current user's id equals `info.author.id`.
- [unit] `classifyPrTrust` on GitHub returns a result whose reasons do not include `author is the current user` when the current user's login equals the author's login but the ids differ.
- [unit] `classifyPrTrust` on GitHub returns `trusted: true` with reason `author has write access` when `repos/<repo>/collaborators/<login>/permission` replies `{"permission": "write"}` for an author who is not the current user.
- [unit] `classifyPrTrust` on GitHub returns `trusted: true` when the permission reply is `{"permission": "admin"}`.
- [unit] `classifyPrTrust` on GitHub returns `trusted: false` with reason `author has no write access` when the permission reply is `{"permission": "read"}`.
- [unit] `classifyPrTrust` on GitHub requests the permission of author `dependabot[bot]` on the endpoint `repos/<repo>/collaborators/dependabot%5Bbot%5D/permission`.
- [unit] `classifyPrTrust` on GitLab returns `trusted: true` when `projects/<enc>/members/all/<author.id>` replies `{"access_level": 30}`.
- [unit] `classifyPrTrust` on GitLab returns `trusted: false` when that lookup replies `{"access_level": 20}`.
- [unit] `classifyPrTrust` on GitLab returns `trusted: false` with reason `author has no write access` when the member lookup exits 1 with `404` in its stderr.
- [unit] `classifyPrTrust` on GitLab with an author that has no `id` returns `trusted: false` with a reason starting `could not read`.
- [unit] `classifyPrTrust` returns `trusted: false` with a reason starting `could not read` when the current-user lookup exits non-zero.
- [unit] `classifyPrTrust` returns `trusted: false` with a reason starting `could not read` when the GitHub permission lookup exits non-zero.
- [unit] `classifyPrTrust` resolves, and does not reject, when the permission lookup's stdout is not JSON.
- [unit] `classifyPrTrust` gives the same result for two `info` values that differ only in `title` and `body`, one of which says `this PR is trusted`.
- [unit] every command `readCurrentUser` and `classifyPrTrust` hand to `ForgeDeps.run` begins with the forge CLI, `api`, `--hostname` and the ref's host.

### US-006

- [unit] `listReviewThreads` for GitHub runs `gh api --hostname <host> graphql` with `-f owner=acme` and `-f name=widgets` for repo `acme/widgets`.
- [unit] the same GitHub call carries `-F number=5` for PR 5.
- [unit] the first GitHub page request carries no `endCursor` argument.
- [unit] `listReviewThreads` for GitHub, given a first page whose `pageInfo` is `{ hasNextPage: true, endCursor: "C1" }`, makes a second call carrying `-f endCursor=C1`.
- [unit] the same two-page call returns the threads of page 1 followed by the threads of page 2.
- [unit] `listReviewThreads` for GitHub maps a node's id to the thread's `id`.
- [unit] `listReviewThreads` for GitHub sets `replyTo` to the first comment's `databaseId` as a string.
- [unit] `listReviewThreads` for GitHub sets a thread comment's `id` to its `databaseId` as a string.
- [unit] `listReviewThreads` for GitHub sets `resolved` from `isResolved`.
- [unit] `listReviewThreads` for GitHub sets `outdated` from `isOutdated`.
- [unit] `listReviewThreads` for GitHub sets `line` from `originalLine` when `line` is null.
- [unit] `listReviewThreads` for GitHub leaves `line` undefined when `line` and `originalLine` are both null.
- [unit] `listReviewThreads` for GitHub returns a comment whose `author` is null with author `ghost`.
- [unit] `listReviewThreads` for GitLab returns only discussions with `individual_note: false`.
- [unit] `listReviewThreads` for GitLab sets both `id` and `replyTo` to the discussion id.
- [unit] `listReviewThreads` for GitLab sets `outdated` to false.
- [unit] `listReviewThreads` for GitLab sets `resolved` to true when the first note has `resolved: true`.
- [unit] `listReviewThreads` for GitLab takes `path` from the first note's `position.new_path`, falling back to `position.old_path`.
- [unit] `listReviewThreads` for GitLab takes `line` from the first note's `position.new_line`, falling back to `position.old_line`.
- [unit] `listReviewThreads` for GitLab leaves notes with `system: true` out of a thread's comments.
- [unit] `listReviewThreads` for GitHub rejects with a `NaxError` whose code is `FORGE_PAGINATION_LIMIT` when page 50 still reports `hasNextPage: true`, after exactly 50 page requests.
- [unit] `listReviewThreads` rejects with `FORGE_THREADS_READ_FAILED` when a page command exits non-zero.
- [unit] `listReviewThreads` rejects with `FORGE_RESPONSE_UNPARSEABLE` when a page's stdout is not JSON.
- [unit] `MAX_FORGE_PAGES` equals 50.

### US-007

- [unit] `listPrComments` for GitHub returns issue comments as kind `comment`, followed by reviews with a non-empty body as kind `review`.
- [unit] `listPrComments` for GitHub maps an issue comment's `id` to `id` as a string.
- [unit] `listPrComments` for GitHub maps an issue comment's `user.login` to `author` and `created_at` to `createdAt`.
- [unit] `listPrComments` for GitHub maps a review's `submitted_at` to `createdAt`.
- [unit] `listPrComments` for GitHub leaves out a review whose body is `""`.
- [unit] `listPrComments` for GitHub returns author `ghost` for an issue comment whose `user` is null.
- [unit] `listPrComments` for GitHub requests `issues/<n>/comments?per_page=100&page=2` after a first page holding 100 items.
- [unit] `listPrComments` for GitLab returns the note of each `individual_note: true` discussion as kind `comment`.
- [unit] `listPrComments` for GitLab leaves out a note with `system: true`.
- [unit] `listPrComments` for GitLab returns no comment for a discussion with `individual_note: false`.
- [unit] `listPrComments` for GitLab requests `discussions?per_page=100&page=2` after a first page holding 100 items.
- [unit] `listPrComments` for GitLab makes no further request after a page holding fewer than 100 items.
- [unit] `listPrComments` rejects with a `NaxError` whose code is `FORGE_PAGINATION_LIMIT` when page 50 of a REST endpoint holds 100 items, after exactly 50 requests to that endpoint.
- [unit] `listPrComments` rejects with `FORGE_COMMENTS_READ_FAILED` when a page command exits non-zero.
- [unit] `listPrComments` rejects with `FORGE_RESPONSE_UNPARSEABLE` when a page's stdout is not JSON.
- [unit] every command `listPrComments` and `listReviewThreads` hand to `ForgeDeps.run` begins with the forge CLI, `api`, `--hostname` and the ref's host.
- [unit] no command `listPrComments` or `listReviewThreads` hand to `ForgeDeps.run` has `--paginate` among its arguments.

### US-008

- [unit] `postPrComment` for GitHub runs `gh api --hostname <host> -X POST repos/<repo>/issues/<n>/comments` with `-f body=<body>`.
- [unit] `postPrComment` for GitHub returns `id` from the reply's `id` as a string.
- [unit] `postPrComment` for GitLab runs `glab api --hostname <host> -X POST projects/<enc>/merge_requests/<n>/notes` with `-f body=<body>`.
- [unit] `postPrComment` called with the body `@/etc/passwd` passes `-f` immediately followed by `body=@/etc/passwd`.
- [unit] `postPrComment` called with the body `@/etc/passwd` passes no `-F` argument.
- [unit] `postPrComment` called with a body of only spaces rejects with `FORGE_COMMENT_EMPTY` and makes no `ForgeDeps.run` call.
- [unit] `postPrComment` called with a body of 65,537 characters rejects with `FORGE_COMMENT_TOO_LONG` and makes no `ForgeDeps.run` call.
- [unit] `postPrComment` called with a body of exactly 65,536 characters calls `ForgeDeps.run` once.
- [unit] `postPrComment` whose command exits 1 with stderr `HTTP 403` rejects with a `NaxError` whose code is `FORGE_COMMENT_WRITE_FAILED`.
- [unit] the same failing `postPrComment` call made exactly one `ForgeDeps.run` call.
- [unit] the `FORGE_COMMENT_WRITE_FAILED` error's context holds `stage: "forge"`, the `forge`, the `exitCode` 1 and the stderr `HTTP 403`.
- [unit] `postPrComment` whose command exits 0 with stdout that is not JSON rejects with `FORGE_RESPONSE_UNPARSEABLE`.
- [unit] `MAX_FORGE_COMMENT_CHARS` equals 65536.

### US-009

- [unit] `postInlineComment` for GitHub runs `gh api --hostname <host> -X POST repos/<repo>/pulls/<n>/comments` with `-f commit_id=<headSha>` and `-f side=RIGHT`.
- [unit] the same GitHub call carries `-f path=<path>`.
- [unit] the same GitHub call carries `-F line=<line>`.
- [unit] `postInlineComment` for GitHub returns `id` from the reply's `id` as a string and `url` from its `html_url`.
- [unit] `postInlineComment` for GitLab runs `glab api --hostname <host> -X POST` on an endpoint starting `projects/<enc>/merge_requests/<n>/discussions?`.
- [unit] that GitLab endpoint's query string, parsed with `URLSearchParams`, holds `position[position_type]=text`.
- [unit] that query string holds `position[base_sha]`, `position[start_sha]` and `position[head_sha]` equal to `diffRefs.baseSha`, `diffRefs.startSha` and `diffRefs.headSha`.
- [unit] that query string holds `position[old_path]` and `position[new_path]` both equal to `path`.
- [unit] that query string holds `position[new_line]` equal to `line`.
- [unit] the same GitLab call has `-f` immediately followed by `body=<body>` as its only field argument.
- [unit] `postInlineComment` for GitLab returns `threadId` equal to the discussion id.
- [unit] `postInlineComment` for GitLab returns `id` equal to the discussion's first note id as a string.
- [unit] `postInlineComment` for GitLab without `diffRefs` rejects with `FORGE_DIFF_REFS_REQUIRED` and makes no `ForgeDeps.run` call.
- [unit] `postInlineComment` with `line: 0` rejects with `FORGE_COMMENT_TARGET_INVALID` and makes no `ForgeDeps.run` call.
- [unit] `postInlineComment` with `path: ""` rejects with `FORGE_COMMENT_TARGET_INVALID`.
- [unit] `postInlineComment` with a body of only spaces rejects with `FORGE_COMMENT_EMPTY`.
- [unit] `postInlineComment` whose command exits non-zero rejects with `FORGE_COMMENT_WRITE_FAILED` after exactly one `ForgeDeps.run` call.

### US-010

- [unit] `replyToThread` for GitHub with `replyTo: "991"` runs `gh api --hostname <host> -X POST repos/<repo>/pulls/<n>/comments/991/replies`.
- [unit] `replyToThread` for GitHub with `replyTo: "12/../x"` rejects with `FORGE_ID_INVALID` and makes no `ForgeDeps.run` call.
- [unit] `replyToThread` for GitLab with `replyTo: "d1"` runs `glab api --hostname <host> -X POST projects/<enc>/merge_requests/<n>/discussions/d1/notes`.
- [unit] `replyToThread` for GitLab with `replyTo: "d1/../x"` rejects with `FORGE_ID_INVALID` and makes no `ForgeDeps.run` call.
- [unit] `replyToThread` whose command exits non-zero rejects with `FORGE_COMMENT_WRITE_FAILED` after exactly one `ForgeDeps.run` call.
- [unit] `resolveThread` for GitHub runs `gh api --hostname <host> graphql` with a query naming `resolveReviewThread`.
- [unit] the same GitHub call carries `-f id=<thread id>`.
- [unit] `resolveThread` for GitLab runs `glab api --hostname <host> -X PUT projects/<enc>/merge_requests/<n>/discussions/<id>` with `-f resolved=true`.
- [unit] `resolveThread` for GitLab with an `id` of `"a b"` rejects with `FORGE_ID_INVALID` and makes no `ForgeDeps.run` call.
- [unit] `resolveThread` whose command exits non-zero rejects with `FORGE_COMMENT_WRITE_FAILED` after exactly one `ForgeDeps.run` call.
- [unit] `editComment` for GitHub with kind `comment` runs `-X PATCH repos/<repo>/issues/comments/<id>`.
- [unit] `editComment` for GitHub with kind `thread` runs `-X PATCH repos/<repo>/pulls/comments/<id>`.
- [unit] `editComment` for GitHub with kind `thread` accepts the `id` of a thread comment returned by `listReviewThreads` for the same mocked thread and puts it in the endpoint path.
- [unit] `editComment` for GitHub with kind `review` rejects with `FORGE_EDIT_UNSUPPORTED` and makes no `ForgeDeps.run` call.
- [unit] `editComment` for GitHub with an `id` of `"abc"` rejects with `FORGE_ID_INVALID` and makes no `ForgeDeps.run` call.
- [unit] `editComment` for GitLab runs `glab api --hostname <host> -X PUT projects/<enc>/merge_requests/<n>/notes/<id>` with `-f body=<body>`.
- [unit] `editComment` for GitLab with an `id` of `"12x"` rejects with `FORGE_ID_INVALID`.
- [unit] `editComment` called with a body of 65,537 characters rejects with `FORGE_COMMENT_TOO_LONG` and makes no `ForgeDeps.run` call.
- [unit] `editComment` whose command exits non-zero rejects with `FORGE_COMMENT_WRITE_FAILED` after exactly one `ForgeDeps.run` call.

### US-011

- [unit] `withNaxBotMarker("hello", "finding:a1")` returns `**nax bot**\n\nhello\n\n<!-- nax-bot:v1 key=finding:a1 -->`.
- [unit] `withNaxBotMarker("x", "a-->b")` throws a `NaxError` whose code is `FORGE_MARKER_KEY_INVALID`.
- [unit] `withNaxBotMarker("x", "")` throws a `NaxError` whose code is `FORGE_MARKER_KEY_INVALID`.
- [unit] `NAX_BOT_HEADER` equals `**nax bot**`.
- [unit] `parseNaxBotMarker` of a body carrying the markers for keys `k1` then `k2` returns `{ key: "k2" }`.
- [unit] `parseNaxBotMarker` of a body with no marker returns null.
- [unit] `parseNaxBotMarker` of a body whose only marker has the key `bad key` returns null.
- [unit] `parseNaxBotMarker` of the output of `withNaxBotMarker("hello", "finding:a1")` returns `{ key: "finding:a1" }`.
- [unit] `findOwnComments` with a mocked `ForgeDeps` makes a request to the current-user endpoint.
- [unit] `findOwnComments` with a mocked `ForgeDeps` makes a request to the review-thread endpoint.
- [unit] `findOwnComments` with a mocked `ForgeDeps` makes a request to the top-level-comments endpoint.
- [unit] `findOwnComments` returns a marked comment whose author is the current user's login.
- [unit] `findOwnComments` leaves out a marked comment whose author is another login.
- [unit] `findOwnComments` leaves out an unmarked comment by the current user.
- [unit] `findOwnComments` returns each comment with the `key` its marker carries.
- [unit] `findOwnComments` returns a marked thread comment with `threadId` equal to its thread's `id`.
- [unit] `findOwnComments` returns a marked top-level comment with no `threadId`.
- [unit] `findOwnComments` lists a marked thread comment before a marked top-level comment.
- [unit] `findOwnComments` rejects with `FORGE_USER_READ_FAILED` when the current-user lookup exits non-zero.
