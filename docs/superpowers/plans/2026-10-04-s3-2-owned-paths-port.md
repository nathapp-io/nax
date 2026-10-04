# S3-2 — `OwnedPathsPolicy` port and credential read-deny — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move nax's owned-path knowledge (`tools/nax-owned-writes.ts`) out of nax-agent and into nax, behind a neutral `OwnedPathsPolicy` port. Make three `ProtectedPathsPolicy` fields optional. Make Read, Glob and Grep refuse the credential directory and the trust-store file. nax's refusals must stay byte-identical throughout.

**Architecture:** nax-agent gains a port (`tools/owned-paths.ts`) and an empty default. Every place that consults the owned-paths module today reads the port instead:
- the compiled tool policy (write refusal, opt-ins, config refusal and its reason text);
- `resolveWithin`, which now requires the policy as a third argument so no call site can silently drop the config refusal;
- the raw Bash screen;
- the sandbox policy builder.

The port travels next to the existing `protectedPaths` port: through `buildCodingToolSupport`, into the runtime and onto every `ToolRunContext`, and into `resolveSessionSandbox`. nax builds today's policy from the moved module and injects it at its single dispatch site.

**Tech Stack:** TypeScript 7.0.2, Bun 1.4 (bun:test), vitest on Node 22/24 for the Node contract suite.

**Spec:** `docs/superpowers/specs/2026-10-03-s3-conversational-session-api-design.md`. The relevant sections are §6.5 (owned-writes policy, arc decision D16), §6.2 (`ProtectedPathsPolicy` change), §6.3 (credential read-deny) and §9 row S3-2.

**Base:** `main` @ `7381e26d2` (S3-1 merged, #2343). Branch `feat/s3-2-owned-paths`. One PR.

## Global Constraints

- nax-visible behaviour is unchanged. Every refusal text (typed tools, the raw Bash screen, `outOfRootReason`), every sandbox `denyWrite` and `denyRead` entry, and the opt-in rules are byte-identical for nax.
- The credential read-deny changes nothing for nax unless a workdir contains the credential directory (`globalConfigDir()`) or the trust-store file. In that case it refuses.
- Dependency direction is `nax-ai` → `nax-agent` → `nax`. nax-agent never imports nax. After this PR, `packages/nax-agent/src` contains no nax-owned path RULES, meaning code that decides a refusal from a `.queue.txt`, feature-PRD or `.nax/config.json` path. Model-facing prose that names those paths stays unchanged for byte-identity, and is out of scope: the raw Bash tool description (`tools/bash.ts:175-176`), `tools/denial-redirect.ts` and `sandbox/messages.ts:27`.
- nax-agent ships zero Bun APIs (`check:no-bun-apis`); `src/` uses `node:` built-ins only.
- Every thrown error is a `NaxError` (`check-nax-error`).
- No `_` names on `.`; `/internal` is unstable. Run `bun run check:api` and `bun run api:update` when a surface changes.
- nax-agent coverage: 80% overall and per file, empty baseline (`bun run test:coverage`).
- Never run bare `bun test` or `bun run nax`. Run package scripts from the package directory (`cd packages/nax-agent`, `cd packages/nax`).
- No emojis. Source files stay under 600 lines and test files under 800 (`check-file-sizes`); functions stay under the complexity gate. In `nax`, `check:feature-dir-ssot` covers literal feature-directory spellings.
- Test escape-hatch ratchet: the regex `\bas\s+[A-Z]\w*` counts test text, test names included, as a loose cast. Use typed declarations, and keep test names clear of "as <Capitalised>".
- Complexity ratchet (`check-complexity`, in `lint:checks`): a baselined function may not score higher, and `--update-baseline` only ever lowers. Hot spots in this PR are `buildCodingToolSupport` (38), `screenRawBashCommand` (26), `read.ts run` (24) and `grep.ts run` (21). `glob.ts run` is unbaselined, so it is capped at 20. Do not add conditional spreads for `ownedPaths`: `exactOptionalPropertyTypes` is off, so pass optional values directly. When a function's score drops, run `bun ../repo-tooling/scripts/check-complexity.ts --package=. --update-baseline` and commit the lowered baseline.
- macOS (BSD) tools: `sed -i ''`, and `xargs` with no input still runs the command once. Use a `for` loop over `grep -rl` output instead of piping into `xargs`.
- Conventional commit messages (`refactor:`, `feat:`, `test:`).

## Review Focus

1. **The credential directory spelled with different letter case on a case-insensitive filesystem**, for example Read of `<root>/.NAX/credentials.json` on macOS when the directory on disk is `.nax`. Node's `realpathSync` keeps the caller's casing, so a naive prefix compare lets this through. This is the class of the 2026-09-10 `.ENV` bypass. Expected: refused. Pinned in Task 6 (darwin-gated test).
2. **A symlink inside the workdir pointing at the credential directory** (`<root>/link -> <credentialDir>`), reached through Read, Glob or Grep. Expected: Read and Grep refuse, and Glob drops the hit. Pinned in Task 6.
3. **A nax dispatch path that does not inject the policy, or injects it into the policy but not the run context.** The nax-agent default is the empty policy, so nax's config, PRD and queue would become writable with no error. Glob, the scratchpad tools and Exec read only `ToolRunContext.ownedPaths`. Expected: nax's real `resolveCodingToolSupport` path refuses each typed write and read with today's exact text, raw Bash refuses as today, Glob does not list `.nax/config.json`, Exec refuses a positional `.nax/config.json`, and the sandbox denies today's entries. Pinned by a characterization test written in Task 1, before anything changes, and **green after every task**: nax injects the policy in the same commit that makes nax-agent read the port.
4. **An embedder session with the empty policy.** Expected: containment and the `.git/` metadata refusal still hold, and only the owned refusals disappear. Pinned in Task 2.
5. **The raw Bash screen's two-pass order.** The lexical config check runs before the resolver, per working-directory frame. A name that is only a PRD stays allowed when sandbox-wrapped, and a redirect into it is refused. Expected: the same first-match-then-exemption result as today. Pinned in Task 1 (adapter) and Task 3 (screen).

## Deviations from the spec (decided while planning)

- **`bashRefusal` takes per-frame candidates, not a flat list of strings.** The spec writes `bashRefusal(tool, candidates: readonly string[], ctx)`. Today's screen runs two different checks per working-directory frame: an absolute lexical path for the config check, and the resolver's root-relative path for the PRD and queue check. The first match then picks the text. A flat list cannot express which check applies to which string. The port therefore takes `token` plus `candidates: readonly OwnedBashCandidate[]`, where each candidate is `{ lexical, rel }` in frame order, and `ctx` is the spec's `{ root, verb, sandboxWrapped }`. The policy reproduces today's first-match-then-exemption logic exactly.
- **`undefined`, not `null`, for "no refusal"**, matching the module's existing idiom (`naxOwnedWriteRefusal`).
- **`optIns` is a `ReadonlySet<string>`**, as `naxWriteOptIns` returns today. The spec writes `readonly string[]`.
- **The port travels next to `protectedPaths`, not inside it.** `ProtectedPathsPolicy` is data only (S1 port 6), and this port has functions.
- **Grep refuses a search whose target contains the credential directory or the trust-store file**, telling the agent to narrow the target. The alternative, excluding those paths through `rg`/`grep` argv, would be backend-specific. The refusal can only fire when the workdir contains the credential directory.
- **`resolveWithin` requires the policy as a third argument.** That makes the compiler find every call site, so none can silently fall back to "no config refusal". `normalizeExec`'s input takes it as an optional field (62 test call sites), defaulting to the empty policy; its one production caller passes it.
- **Credential paths are compared with `realpathSync.native`, not `realOrRaw`.** Spec §6.3 says "resolving symlinks the way `nax-owned-writes.ts` does (`realOrRaw`)". `realOrRaw` (JS `realpathSync`) keeps the caller's letter casing, so on a case-insensitive filesystem `.NAX` would pass a `.nax` prefix check. A reviewer confirmed on macOS that `realpathSync.native` returns the on-disk casing. `realOrRaw` remains the fallback for paths that do not exist, which cannot be read anyway.
- **One value feeds both injection points.** `compileToolPolicy({ ownedPaths })` and `createCodingToolRuntime({ ownedPaths })` are separate inputs. Glob, scratchpad and Exec read only the run context. `buildCodingToolSupport`, the single production constructor of both, passes the same `args.ownedPaths` to each, and Task 1's Glob and Exec pins catch a split. `ToolPolicy` does not gain a field, which would churn every hand-built `ToolPolicy` fake in the tests.
- **A test-helper copy of nax's module.** nax-agent's engine tests need a realistic owned-paths policy, and nax-agent cannot import nax. Following the S2-3c precedent (`test/helpers/protected-paths.ts`, "values copied from nax"), Task 5 moves the module to nax with `git mv` and leaves a verbatim copy at `packages/nax-agent/test/helpers/nax-owned-paths.ts`. nax's tests pin the real one, and a nax drift test compares the two files' text.
- **Temporary `/internal` exports.** Until the move, nax (source and tests) needs `naxOwnedPathsPolicy` and the port types. Task 1 exports `#src/tools/nax-owned-writes` and `#src/tools/owned-paths` from `src/internal.ts`. Task 5 drops the first; the second stays, and Task 7 also puts the port on `.`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/nax-agent/src/tools/owned-paths.ts` | Create | The port: `OwnedPathsPolicy`, `OwnedBashCandidate`, `EMPTY_OWNED_PATHS_POLICY`. |
| `packages/nax-agent/src/tools/nax-owned-writes.ts` | Modify (T1), then move to nax (T5) | Today's rules, plus the `naxOwnedPathsPolicy` adapter added in T1. |
| `packages/nax-agent/src/tools/policy.ts`, `policy-paths-branch.ts`, `policy-command-branch.ts`, `policy-bash-raw.ts` | Modify | Consume the port. |
| `packages/nax-agent/src/tools/glob.ts`, `scratchpad.ts`, `package-managers.ts`, `run-command-exec.ts`, `registry.ts`, `runtime.ts` | Modify | Pass the port to `resolveWithin`, and carry it on `ToolRunContext`. |
| `packages/nax-agent/src/coding-tools/coding-tool-support.ts`, `coding-tool-sandbox.ts` | Modify | Accept and forward `ownedPaths`; skip absent protected paths. |
| `packages/nax-agent/src/sandbox/policy-builder.ts` | Modify | Owned-path denies from the port; optional `projectStateDir`. |
| `packages/nax-agent/src/tools/protected-paths.ts` | Modify | Three fields become optional. |
| `packages/nax-agent/src/tools/credential-read-deny.ts` | Create | `credentialReadRefusal`, `containsCredentialPath`. |
| `packages/nax-agent/src/tools/read.ts`, `glob.ts`, `grep.ts` | Modify | Apply the credential read-deny. |
| `packages/nax/src/agents/nax-owned-writes.ts` | Create (moved with `git mv`) | nax's owned-path rules and `naxOwnedPathsPolicy`. |
| `packages/nax/src/agents/coding-tool-support-resolve.ts` | Modify | Inject `ownedPaths` into support and the sandbox. |
| `packages/nax-agent/test/helpers/nax-owned-paths.ts` | Create (T5) | Verbatim test copy of nax's module. |
| Tests | Create/Modify | Listed per task. |

---

### Task 1: Pin nax's owned refusals end to end, and add the port and nax adapter

Characterization first. The nax-side test passes on the unchanged code and must stay green until the end of the PR. Then the port types and the adapter land as pure additions.

**Files:**
- Create: `packages/nax/test/unit/agents/coding-tool-support-owned-paths.test.ts`
- Create: `packages/nax-agent/src/tools/owned-paths.ts`
- Modify: `packages/nax-agent/src/tools/nax-owned-writes.ts` (append the adapter)
- Modify: `packages/nax-agent/test/unit/tools/nax-owned-writes.test.ts` (append adapter tests)
- Modify: `packages/nax-agent/src/internal.ts` (temporary exports)
- Test: `packages/nax-agent/test/unit/tools/owned-paths.test.ts` (new)

**Interfaces:**
- Produces:

```ts
// packages/nax-agent/src/tools/owned-paths.ts
export interface OwnedBashCandidate {
  /** The token resolved lexically against one working directory, symlinks resolved (`realOrRaw`). */
  readonly lexical: string;
  /** The typed-seam resolver's root-relative, `/`-joined path for that frame; null when it refused or the path is outside the root. */
  readonly rel: string | null;
}
export interface OwnedPathsPolicy {
  writeRefusal(tool: string, rel: string, ctx: { readonly exemptRel?: string; readonly optIns: ReadonlySet<string> }): string | undefined;
  configRefusal(root: string, resolved: string): string | undefined;
  bashRefusal(
    tool: string,
    token: string,
    candidates: readonly OwnedBashCandidate[],
    ctx: { readonly root: string; readonly verb: "names" | "redirects into"; readonly sandboxWrapped: boolean },
  ): string | undefined;
  readonly deniedEntries: readonly string[];
  readonly rootWriteDenies: readonly string[];
  readonly scratchpadEntry?: string;
  writeOptIns(root: string, allowWrite: readonly string[]): ReadonlySet<string>;
}
export const EMPTY_OWNED_PATHS_POLICY: OwnedPathsPolicy;
// packages/nax-agent/src/tools/nax-owned-writes.ts (moves to nax in Task 5)
export const naxOwnedPathsPolicy: OwnedPathsPolicy;
```

- [ ] **Step 1: Write the nax characterization test**

This test asserts nax's real refusal texts through `resolveCodingToolSupport`. Copy the setup shape from `test/unit/agents/coding-tool-support-scratchpad.test.ts`: `makeTempDir`, `makeNaxConfig`, `support.runtime.callTool`, `_resetSandboxRegistryForTests` in `afterEach`.

```ts
/**
 * S3-2 characterization: nax's owned-path refusals, end to end through the real
 * dispatch entry. Written on main before the port exists and kept green through
 * the move: if nax ever stops injecting its OwnedPathsPolicy, the nax-agent
 * default (no owned paths) makes every one of these writable and this fails.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _resetSandboxRegistryForTests } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";

let root: string;
beforeEach(() => {
  root = makeTempDir("nax-owned-paths-");
  mkdirSync(join(root, ".nax", "features", "f"), { recursive: true });
  writeFileSync(join(root, ".nax", "config.json"), "{}");
  writeFileSync(join(root, ".nax", "features", "f", "prd.json"), "{}");
  writeFileSync(join(root, ".queue.txt"), "");
});
afterEach(() => {
  cleanupTempDir(root);
  _resetSandboxRegistryForTests();
});

async function denialFor(tool: string, input: Record<string, unknown>, bashApproval?: "raw"): Promise<string> {
  const support = await resolveCodingToolSupport({
    declaredTools: ["Read", "Write", "Bash", "Glob", "Exec"],
    codingToolRoot: root,
    pipelineStage: "run",
    config: makeNaxConfig({
      execution: {
        permissionProfile: "unrestricted",
        sandbox: { enabled: false },
        ...(bashApproval !== undefined ? { bashApproval } : {}),
      },
    }),
  });
  const outcome = await support?.runtime.callTool(tool, input);
  if (outcome?.kind !== "denied") throw new Error(`expected ${tool} to be denied, got ${outcome?.kind}`);
  return outcome.reason;
}

async function okContent(tool: string, input: Record<string, unknown>): Promise<string> {
  const support = await resolveCodingToolSupport({
    declaredTools: ["Read", "Write", "Bash", "Glob", "Exec"],
    codingToolRoot: root,
    pipelineStage: "run",
    config: makeNaxConfig({ execution: { permissionProfile: "unrestricted", sandbox: { enabled: false } } }),
  });
  const outcome = await support?.runtime.callTool(tool, input);
  if (outcome?.kind !== "ok") throw new Error(`expected ${tool} to run, got ${outcome?.kind}`);
  return JSON.stringify(outcome);
}

const CONFIG_REASON =
  'path ".nax/config.json" is one of nax\'s own config files, which every tool is refused regardless of grant -- ' +
  "`quality.commands` and `acceptance.command` are run through a shell WITHOUT passing the permission gate " +
  "because a human wrote them, so editing this file is a route to running an ungated command on the next run";

describe("nax owned paths through resolveCodingToolSupport (S3-2 byte-identity pin)", () => {
  test("Write to the PRD", async () => {
    expect(await denialFor("Write", { path: ".nax/features/f/prd.json", content: "x" })).toBe(
      'Write may not modify ".nax/features/f/prd.json" is nax\'s own run state: it holds the acceptance criteria this story is judged against, so no tool may modify it. Change the code, not the criteria.',
    );
  });

  test("Write to the queue file", async () => {
    expect(await denialFor("Write", { path: ".queue.txt", content: "ABORT" })).toBe(
      'Write may not modify ".queue.txt" is nax\'s own run state: it carries the PAUSE/ABORT/SKIP commands that control this run, so no tool may modify it. Change the run through the queue command, not by writing its file.',
    );
  });

  test("Write to other .nax state", async () => {
    expect(await denialFor("Write", { path: ".nax/features/f/context.md", content: "x" })).toBe(
      'Write may not modify ".nax/features/f/context.md" is nax\'s own state, which agents do not modify. Under .nax/, write only to your scratchpad (.nax/scratchpad/) or to a feature\'s acceptance test file. A human can open a path for a story by listing it in execution.sandbox.filesystem.allowWrite in the project config.',
    );
  });

  test("Read of nax config is refused like a write", async () => {
    expect(await denialFor("Read", { path: ".nax/config.json" })).toBe(CONFIG_REASON);
  });

  test("raw Bash naming the queue file", async () => {
    // `cat` maps to the READ intent, so the runtime appends a redirect to Read
    // (runtime-calltool.ts resolveDenialOutcome, denial-redirect.ts).
    expect(await denialFor("Bash", { command: "cat .queue.txt" }, "raw")).toBe(
      'Bash command names ".queue.txt", which is nax\'s run-control queue. Bash commands naming it are refused, reads included -- change the run through the queue command.' +
        " -- this session already has `Read` -- Read returns file contents, by line range with offset/limit",
    );
  });

  test("raw Bash redirecting into nax config", async () => {
    expect(await denialFor("Bash", { command: "echo x > .nax/config.json" }, "raw")).toBe(
      'Bash command redirects into ".nax/config.json", which is nax configuration. Bash commands naming it are refused, reads included -- nax configuration is not changed from inside a run.',
    );
  });

  test("Glob does not list nax config (ToolRunContext.ownedPaths)", async () => {
    writeFileSync(join(root, ".nax", "notes.json"), "{}");
    const listed = await okContent("Glob", { pattern: ".nax/*.json" });
    expect(listed).toContain("notes.json");
    expect(listed).not.toContain("config.json");
  });

  test("Exec refuses a positional path to nax config (ToolRunContext.ownedPaths)", async () => {
    expect(await denialFor("Exec", { argv: ["bun", "add", ".nax/config.json"] })).toContain(
      'argv contains a path-shaped argument ".nax/config.json" that resolves outside the permitted root',
    );
  });
});
```

Add a sandbox case to `test/unit/agents/coding-tool-support-resolve.test.ts`, inside the existing `describe("resolveDispatchLauncher — US-002 ...")`, after the "port 6" test. It reuses that describe's `runDispatched()` and `root`:

```ts
  test("S3-2 pin: the sandbox denies nax's owned entries and run-control files", async () => {
    const { policy } = await runDispatched();

    for (const entry of ["config.json", "mono", "rules", "context.md", "hooks.json", "plugins", "templates", "prompts"]) {
      expect(policy.denyWrite).toContain(realOrRaw(join(root, ".nax", entry)));
    }
    expect(policy.denyWrite).toContain(realOrRaw(join(root, ".queue.txt")));
    expect(policy.denyWrite).toContain(realOrRaw(join(root, ".queue.txt.processing")));
    expect(policy.denyWrite).not.toContain(realOrRaw(join(root, ".nax", "scratchpad")));
  });
```

- [ ] **Step 2: Run the characterization tests on unchanged code. They must PASS.**

Run: `cd packages/nax && bun test test/unit/agents/coding-tool-support-owned-paths.test.ts test/unit/agents/coding-tool-support-resolve.test.ts --timeout=60000`
Expected: PASS. These tests pin today's behaviour.
- If an expected string differs from what the run prints (for example the runtime prefixes the reason, or a config key is named differently), correct the test to the observed text and record a ledger `Ruling:`. This is a characterization test: never change source here.
- If `bashApproval` is not a valid key at that config position, find where `resolved.bashApproval` comes from in `coding-tool-support-resolve.ts` and set it there instead.
- If the Glob or Exec cases are not reachable this way (for example Exec is not granted under `unrestricted`, or its result shape differs from `{ kind: "ok" }`), adjust the declared tools, config or outcome check until each case exercises the real tool on unchanged code, and record a `Ruling:`. Do not drop the case: it is the only pin on `ToolRunContext.ownedPaths`.

- [ ] **Step 3: Write the failing port and adapter tests**

`packages/nax-agent/test/unit/tools/owned-paths.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { EMPTY_OWNED_PATHS_POLICY } from "#src/tools/owned-paths";

describe("EMPTY_OWNED_PATHS_POLICY", () => {
  test("refuses nothing and denies nothing", () => {
    const p = EMPTY_OWNED_PATHS_POLICY;
    expect(p.writeRefusal("Write", ".nax/config.json", { optIns: new Set() })).toBeUndefined();
    expect(p.configRefusal("/r", "/r/.nax/config.json")).toBeUndefined();
    expect(
      p.bashRefusal("Bash", ".queue.txt", [{ lexical: "/r/.queue.txt", rel: ".queue.txt" }], {
        root: "/r",
        verb: "redirects into",
        sandboxWrapped: false,
      }),
    ).toBeUndefined();
    expect(p.deniedEntries).toEqual([]);
    expect(p.rootWriteDenies).toEqual([]);
    expect(p.scratchpadEntry).toBeUndefined();
    expect([...p.writeOptIns("/r", [".nax/rules"])]).toEqual([]);
  });
});
```

Append to `packages/nax-agent/test/unit/tools/nax-owned-writes.test.ts`. Add `naxOwnedPathsPolicy`, `NAX_ALWAYS_DENIED_ENTRIES` and `QUEUE_CONTROL_FILES` to its existing import from `#src/tools/nax-owned-writes` (keep whichever names it already imports), and import `mkdtempSync`, `realpathSync` and `tmpdir` if they are missing:

```ts
describe("naxOwnedPathsPolicy (the OwnedPathsPolicy adapter over this module)", () => {
  const p = naxOwnedPathsPolicy;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nax-owned-adapter-")));

  test("writeRefusal is naxOwnedWriteRefusal", () => {
    const optIns = new Set<string>();
    for (const rel of [".nax/features/f/prd.json", ".queue.txt", ".nax/features/f/context.md", "src/a.ts"]) {
      expect(p.writeRefusal("Write", rel, { optIns })).toBe(naxOwnedWriteRefusal("Write", rel, undefined, optIns));
    }
    expect(p.writeRefusal("Write", ".nax/features/f/prd.json", { exemptRel: ".nax/features/f/prd.json", optIns })).toBeUndefined();
    expect(p.writeRefusal("Read", ".queue.txt", { optIns })).toBeUndefined();
  });

  test("configRefusal returns today's reason text for a config file and undefined otherwise", () => {
    expect(p.configRefusal(root, join(root, ".nax", "config.json"))).toBe(
      "is one of nax's own config files, which every tool is refused regardless of grant -- " +
        "`quality.commands` and `acceptance.command` are run through a shell WITHOUT passing the " +
        "permission gate because a human wrote them, so editing this file is a route to running " +
        "an ungated command on the next run",
    );
    expect(p.configRefusal(root, join(root, ".nax", "mono", "packages", "api", "config.json"))).toBeDefined();
    expect(p.configRefusal(root, join(root, "docs", "nax", "config.json"))).toBeUndefined();
  });

  test("bashRefusal: the first matching frame decides, config by lexical path, PRD/queue by rel", () => {
    const configFirst = [
      { lexical: join(root, ".nax", "config.json"), rel: null },
      { lexical: join(root, "x"), rel: ".queue.txt" },
    ];
    expect(p.bashRefusal("Bash", "t", configFirst, { root, verb: "names", sandboxWrapped: false })).toBe(
      naxOwnedBashRefusal("Bash", "config", "t", "names"),
    );
    const queue = [{ lexical: join(root, ".queue.txt"), rel: ".queue.txt" }];
    expect(p.bashRefusal("Bash", ".queue.txt", queue, { root, verb: "redirects into", sandboxWrapped: true })).toBe(
      naxOwnedBashRefusal("Bash", "queue", ".queue.txt", "redirects into", { sandboxWrapped: true }),
    );
  });

  test("bashRefusal: a sandbox-wrapped command that only names a PRD is allowed; a redirect into it is not", () => {
    const prd = [{ lexical: join(root, ".nax", "features", "f", "prd.json"), rel: ".nax/features/f/prd.json" }];
    expect(p.bashRefusal("Bash", "prd.json", prd, { root, verb: "names", sandboxWrapped: true })).toBeUndefined();
    expect(p.bashRefusal("Bash", "prd.json", prd, { root, verb: "names", sandboxWrapped: false })).toBe(
      naxOwnedBashRefusal("Bash", "prd", "prd.json", "names"),
    );
    expect(p.bashRefusal("Bash", "prd.json", prd, { root, verb: "redirects into", sandboxWrapped: true })).toBe(
      naxOwnedBashRefusal("Bash", "prd", "prd.json", "redirects into", { sandboxWrapped: true }),
    );
  });

  test("bashRefusal: a PRD in an earlier frame wins over config in a later one (today's first-hit order)", () => {
    const prdThenConfig = [
      { lexical: join(root, "a"), rel: ".nax/features/f/prd.json" },
      { lexical: join(root, ".nax", "config.json"), rel: null },
    ];
    expect(p.bashRefusal("Bash", "t", prdThenConfig, { root, verb: "names", sandboxWrapped: true })).toBeUndefined();
  });

  test("sandbox data is today's constants", () => {
    expect(p.deniedEntries).toEqual(NAX_ALWAYS_DENIED_ENTRIES);
    expect(p.rootWriteDenies).toEqual([...QUEUE_CONTROL_FILES]);
    expect(p.scratchpadEntry).toBe(NAX_SCRATCHPAD_ENTRY);
    expect([...p.writeOptIns(root, [".nax/rules"])]).toEqual([...naxWriteOptIns(root, [".nax/rules"])]);
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cd packages/nax-agent && bun test ./test/unit/tools/owned-paths.test.ts ./test/unit/tools/nax-owned-writes.test.ts --timeout=60000`
Expected: FAIL. `#src/tools/owned-paths` is not found, and `naxOwnedPathsPolicy` is not exported.

- [ ] **Step 5: Create `src/tools/owned-paths.ts`**

```ts
/**
 * The owned-paths port (S3 spec 6.5, arc decision D16): which paths the HOST
 * owns the writes to, and how its refusals read. nax-agent holds no such
 * knowledge itself; nax injects its policy through `buildCodingToolSupport`
 * and `resolveSessionSandbox`, and an embedder that injects nothing gets
 * `EMPTY_OWNED_PATHS_POLICY`: containment and the `.git/` refusal still apply,
 * owned-path refusals do not.
 */

/** One working-directory frame of a raw Bash token, in frame order. */
export interface OwnedBashCandidate {
  /** The token resolved lexically against one working directory, symlinks resolved (`realOrRaw`). */
  readonly lexical: string;
  /** The typed-seam resolver's root-relative, `/`-joined path for that frame; null when it refused or the path is outside the root. */
  readonly rel: string | null;
}

export interface OwnedPathsPolicy {
  /** Refusal for a mutating path tool on a root-relative, `/`-joined path; undefined = not owned. */
  writeRefusal(tool: string, rel: string, ctx: { readonly exemptRel?: string; readonly optIns: ReadonlySet<string> }): string | undefined;
  /**
   * Refusal for ANY tool, reads included, on a symlink-resolved absolute path;
   * undefined = not refused. Non-undefined makes `resolveWithin` refuse the path,
   * and the text completes `outOfRootReason`'s `path "x" <text>` sentence.
   */
  configRefusal(root: string, resolved: string): string | undefined;
  /** Raw Bash screen: full refusal for `token` given its per-frame candidates; undefined = allowed. */
  bashRefusal(
    tool: string,
    token: string,
    candidates: readonly OwnedBashCandidate[],
    ctx: { readonly root: string; readonly verb: "names" | "redirects into"; readonly sandboxWrapped: boolean },
  ): string | undefined;
  /** Top-level project-state entries the sandbox denies writes to, even when absent. */
  readonly deniedEntries: readonly string[];
  /** Root-level file names the sandbox denies writes to. */
  readonly rootWriteDenies: readonly string[];
  /** The one project-state entry agents may always write; never sandbox-denied. */
  readonly scratchpadEntry?: string;
  /** Project-state entries opened for writes by `allowWrite`. */
  writeOptIns(root: string, allowWrite: readonly string[]): ReadonlySet<string>;
}

const NO_OPT_INS: ReadonlySet<string> = new Set();

export const EMPTY_OWNED_PATHS_POLICY: OwnedPathsPolicy = {
  writeRefusal: () => undefined,
  configRefusal: () => undefined,
  bashRefusal: () => undefined,
  deniedEntries: [],
  rootWriteDenies: [],
  writeOptIns: () => NO_OPT_INS,
};
```

- [ ] **Step 6: Append the adapter to `src/tools/nax-owned-writes.ts`, and export temporarily from `/internal`**

Put the new `import type` line with the module's other imports at the top (biome orders imports); the rest is appended at the end. The config reason text moves out of `outOfRootReason` in `policy-paths-branch.ts` into this module as a constant, so the adapter owns it. Leave `outOfRootReason` itself unchanged in this task; Task 2 switches it to the port.

```ts
import type { OwnedBashCandidate, OwnedPathsPolicy } from "./owned-paths.ts";

/** `outOfRootReason`'s text for a nax config file (completes `path "x" <text>`). */
export const NAX_CONFIG_REFUSAL =
  "is one of nax's own config files, which every tool is refused regardless of grant -- " +
  "`quality.commands` and `acceptance.command` are run through a shell WITHOUT passing the " +
  "permission gate because a human wrote them, so editing this file is a route to running " +
  "an ungated command on the next run";

/**
 * The first frame that hits, in today's two-pass order per frame (see the raw
 * Bash screen in policy-bash-raw.ts): the lexical config check, then the
 * resolver's PRD/queue check.
 */
function firstOwnedHit(root: string, candidates: readonly OwnedBashCandidate[]): NaxOwnedKind | undefined {
  for (const candidate of candidates) {
    if (isNaxConfigFile(root, candidate.lexical)) return "config";
    const kind = candidate.rel === null ? undefined : naxOwnedKind(candidate.rel);
    if (kind !== undefined) return kind;
  }
  return undefined;
}

/** nax's OwnedPathsPolicy: this module's rules behind the S3-2 port. */
export const naxOwnedPathsPolicy: OwnedPathsPolicy = {
  writeRefusal: (tool, rel, ctx) => naxOwnedWriteRefusal(tool, rel, ctx.exemptRel, ctx.optIns),
  configRefusal: (root, resolved) => (isNaxConfigFile(root, resolved) ? NAX_CONFIG_REFUSAL : undefined),
  bashRefusal: (tool, token, candidates, ctx) => {
    const kind = firstOwnedHit(ctx.root, candidates);
    if (kind === undefined) return undefined;
    // US-002: sandbox-wrapped, a token that only NAMES a PRD is allowed.
    if (ctx.verb === "names" && ctx.sandboxWrapped && kind === "prd") return undefined;
    return naxOwnedBashRefusal(tool, kind, token, ctx.verb, { sandboxWrapped: ctx.sandboxWrapped });
  },
  deniedEntries: NAX_ALWAYS_DENIED_ENTRIES,
  rootWriteDenies: [...QUEUE_CONTROL_FILES],
  scratchpadEntry: NAX_SCRATCHPAD_ENTRY,
  writeOptIns: naxWriteOptIns,
};
```

Today the "names" path passes no `opts` to `naxOwnedBashRefusal`. Passing `{ sandboxWrapped }` for "names" gives the same text in every reachable case: names, PRD and sandbox-wrapped returns early above, and the other kinds ignore `sandboxWrapped`. The adapter tests compare against `naxOwnedBashRefusal(... "names")` with no opts to pin exactly that.

Add to `packages/nax-agent/src/internal.ts`, next to the other `#src/tools/*` lines:

```ts
// S3-2: the port, and (temporarily, until Task 5 moves it to nax) nax's adapter.
export * from "#src/tools/owned-paths";
export * from "#src/tools/nax-owned-writes";
```

- [ ] **Step 7: Run them to verify they pass, then typecheck**

Run: `cd packages/nax-agent && bun test ./test/unit/tools/owned-paths.test.ts ./test/unit/tools/nax-owned-writes.test.ts --timeout=60000 && bun run typecheck && bun run api:update`
Expected: PASS, no type errors. `api:update` adds the new `/internal` names (additions only); the API snapshot test would otherwise fail.

- [ ] **Step 8: Commit**

```bash
git add packages/nax/test/unit/agents/coding-tool-support-owned-paths.test.ts packages/nax/test/unit/agents/coding-tool-support-resolve.test.ts packages/nax-agent/src/tools/owned-paths.ts packages/nax-agent/src/tools/nax-owned-writes.ts packages/nax-agent/src/internal.ts packages/nax-agent/test/unit/tools/owned-paths.test.ts packages/nax-agent/test/unit/tools/nax-owned-writes.test.ts packages/nax-agent/api/nax-agent.api.txt
git commit -m "feat(nax-agent): OwnedPathsPolicy port and nax adapter; pin nax owned refusals end to end"
```

---

### Task 2: The typed policy, `resolveWithin` and the run context consume the port

**Files:**
- Modify: `packages/nax-agent/src/tools/policy.ts` (`ToolPolicyOptions`, `compileToolPolicy`, `applyPathRules`, the `resolvePath` closure)
- Modify: `packages/nax-agent/src/tools/policy-paths-branch.ts` (`resolveWithin`, `outOfRootReason`, `PathsBranchContext`, `checkPathSegment`)
- Modify: `packages/nax-agent/src/tools/registry.ts` (`ToolRunContext.ownedPaths`)
- Modify: `packages/nax-agent/src/tools/runtime.ts` (`contextPorts`, `createCodingToolRuntime` opts)
- Modify: `packages/nax-agent/src/tools/glob.ts:150`, `scratchpad.ts:197`, `package-managers.ts` (`NormalizeInput`, `findPositionalPathConflict`), `run-command-exec.ts:130`
- Modify: `packages/nax-agent/src/coding-tools/coding-tool-support.ts` (args `ownedPaths`, forwarded to `compileToolPolicy` and `createCodingToolRuntime`)
- Modify: `packages/nax/src/agents/coding-tool-support-resolve.ts` (`_codingToolSupportDeps.ownedPaths`, passed to `buildCodingToolSupport`)
- Modify: every nax-agent and nax test that now fails because the default is empty (Step 6)
- Test: `packages/nax-agent/test/unit/tools/policy-owned-paths.test.ts` (new); `packages/nax/test/unit/agents/coding-tool-support-resolve.test.ts` (append)

**Interfaces:**
- Consumes: `OwnedPathsPolicy`, `EMPTY_OWNED_PATHS_POLICY` (Task 1); `naxOwnedPathsPolicy` (Task 1, tests only).
- Produces:
  - `ToolPolicyOptions.ownedPaths?: OwnedPathsPolicy` (default `EMPTY_OWNED_PATHS_POLICY`)
  - `resolveWithin(root: string, candidate: string, owned: OwnedPathsPolicy): string | null` (third parameter required)
  - `PathsBranchContext.ownedPaths: OwnedPathsPolicy`
  - `ToolRunContext.ownedPaths?: OwnedPathsPolicy`; `createCodingToolRuntime({ ..., ownedPaths?: OwnedPathsPolicy })`
  - `CodingToolSupportArgs.ownedPaths?: OwnedPathsPolicy` (forwarded to `compileToolPolicy` options and `createCodingToolRuntime`)
  - `NormalizeInput.ownedPaths?: OwnedPathsPolicy` (default empty)
  - nax: `_codingToolSupportDeps.ownedPaths: OwnedPathsPolicy` (default `naxOwnedPathsPolicy`, from `@nathapp/nax-agent/internal` until Task 5)

- [ ] **Step 1: Write the failing engine tests**

Create `test/unit/tools/policy-owned-paths.test.ts`. Model the grants, root setup and `policy.check(...)` call shape on the top of `test/unit/tools/policy.test.ts`: read its first 60 lines first and reuse its grant constants and its call to `check`.

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { naxOwnedPathsPolicy } from "#src/tools/nax-owned-writes";
import { type OwnedPathsPolicy, EMPTY_OWNED_PATHS_POLICY } from "#src/tools/owned-paths";
import { compileToolPolicy, resolveWithin } from "#src/tools/policy";
import type { PolicyVerdict, ToolScope } from "#src/tools/types";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "policy-owned-")));
  mkdirSync(join(root, ".nax"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".nax", "config.json"), "{}");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ALL = [
  { tool: "Write", patterns: ["*"] },
  { tool: "Read", patterns: ["*"] },
];
/** `check(tool, scope, input)` takes the tool's scope (types.ts ToolPolicy.check); Read and Write scope one `path` field. */
const PATH_SCOPE: ToolScope = { pathFields: ["path"] };

function reasonOf(verdict: PolicyVerdict): string {
  if (verdict.allowed) throw new Error("expected a denial");
  return verdict.reason;
}

describe("compileToolPolicy and resolveWithin consume the OwnedPathsPolicy port", () => {
  test("with no ownedPaths (the embedder default) nax config is an ordinary file", () => {
    const policy = compileToolPolicy(ALL, root);
    expect(policy.check("Read", PATH_SCOPE, { path: ".nax/config.json" }).allowed).toBe(true);
    expect(resolveWithin(root, ".nax/config.json", EMPTY_OWNED_PATHS_POLICY)).toBe(join(root, ".nax", "config.json"));
  });

  test("with no ownedPaths, containment and the .git refusal still hold", () => {
    const policy = compileToolPolicy(ALL, root);
    expect(policy.check("Read", PATH_SCOPE, { path: "../outside" }).allowed).toBe(false);
    expect(policy.check("Write", PATH_SCOPE, { path: ".git/config", content: "x" }).allowed).toBe(false);
    expect(resolveWithin(root, ".git/config", EMPTY_OWNED_PATHS_POLICY)).toBeNull();
  });

  test("nax's policy restores today's config refusal and reason", () => {
    const policy = compileToolPolicy(ALL, root, { ownedPaths: naxOwnedPathsPolicy });
    const verdict = policy.check("Read", PATH_SCOPE, { path: ".nax/config.json" });
    expect(reasonOf(verdict)).toBe(`path ".nax/config.json" ${naxOwnedPathsPolicy.configRefusal(root, join(root, ".nax", "config.json"))}`);
    expect(resolveWithin(root, ".nax/config.json", naxOwnedPathsPolicy)).toBeNull();
  });

  test("any injected policy is honoured: a custom writeRefusal and configRefusal fire", () => {
    const custom: OwnedPathsPolicy = {
      ...EMPTY_OWNED_PATHS_POLICY,
      writeRefusal: (_tool, rel) => (rel === "owned.txt" ? `"${rel}" belongs to the host` : undefined),
      configRefusal: (_root, resolved) => (resolved.endsWith("host.cfg") ? "is the host's config" : undefined),
    };
    const policy = compileToolPolicy(ALL, root, { ownedPaths: custom });
    expect(reasonOf(policy.check("Write", PATH_SCOPE, { path: "owned.txt", content: "x" }))).toBe(
      'Write may not modify "owned.txt" belongs to the host',
    );
    expect(reasonOf(policy.check("Read", PATH_SCOPE, { path: "host.cfg" }))).toBe('path "host.cfg" is the host\'s config');
  });
});
```

`PolicyVerdict` and `ToolScope` live in `#src/tools/types` (confirm the path; `policy.test.ts:9` declares the same `PATH_SCOPE`).

Append to `packages/nax/test/unit/agents/coding-tool-support-resolve.test.ts`, in the "resolveCodingToolSupport — nax-side entry" describe:

```ts
  test("S3-2: nax's owned-paths policy is the default port", () => {
    expect(_codingToolSupportDeps.ownedPaths).toBe(naxOwnedPathsPolicy);
  });
```

importing `naxOwnedPathsPolicy` from `@nathapp/nax-agent/internal` (Task 5 switches it to `@/agents/nax-owned-writes`).

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/nax-agent && bun test ./test/unit/tools/policy-owned-paths.test.ts --timeout=60000`
Expected: FAIL. There are type errors on the third argument of `resolveWithin` and the `ownedPaths` option, and the empty-policy test sees the config refused. The nax deps test fails too (`cd packages/nax && bun test test/unit/agents/coding-tool-support-resolve.test.ts --timeout=60000`): `_codingToolSupportDeps.ownedPaths` is undefined.

- [ ] **Step 3: Wire the port**

1. `policy-paths-branch.ts`:
   - Drop the `isNaxConfigFile` import, and add `import type { OwnedPathsPolicy } from "./owned-paths.ts";`.
   - `resolveWithin(root, candidate, owned)`: replace `isNaxConfigFile(root, resolved)` with `owned.configRefusal(root, resolved) !== undefined`. Update its doc comment: the owned-config refusal now comes from the injected port.
   - `outOfRootReason(root, candidate, owned)`: compute `const configReason = isInside(root, absolute) ? owned.configRefusal(root, realOrRaw(absolute)) : undefined;` and, if it is defined, return it in place of the inline nax text. Keep the `.git` branch and the final message unchanged.
   - Add `readonly ownedPaths: OwnedPathsPolicy;` to `PathsBranchContext`. In `checkPathSegment`, pass `frame.ctx.ownedPaths` to both `resolveWithin` and `outOfRootReason`.
2. `policy.ts`:
   - Drop the `naxOwnedWriteRefusal, naxWriteOptIns` import, and import `EMPTY_OWNED_PATHS_POLICY, type OwnedPathsPolicy` from `./owned-paths.ts`.
   - In `ToolPolicyOptions`, add:

     ```ts
     /** S3-2: host-owned path rules (OwnedPathsPolicy port). Absent: none, the embedder default. */
     readonly ownedPaths?: OwnedPathsPolicy;
     ```

     Reword the `ownedWriteExemption` and `naxAllowWrite` doc comments to name the port's `writeRefusal` and `writeOptIns`.
   - In `compileToolPolicy`: `const owned = options?.ownedPaths ?? EMPTY_OWNED_PATHS_POLICY;` and `const naxOptIns = owned.writeOptIns(root, options?.naxAllowWrite ?? []);`.
   - In `applyPathRules`: `const naxOwned = owned.writeRefusal(tool, rel, { exemptRel: ownedWriteExemption, optIns: naxOptIns });`.
   - Add `ownedPaths: owned` to the `pathsBranchContext` object literal. The `resolvePath` closure becomes `(candidate, cwd) => resolveWithin(resolvedRoot, resolve(cwd, candidate), owned)`.
3. `registry.ts`: add `readonly ownedPaths?: OwnedPathsPolicy;` to `ToolRunContext`, next to `protectedPaths`, with the doc comment `/** Host-owned path rules (S3-2 port). Absent: no owned-path refusals. */`.
4. `runtime.ts`:
   - `contextPorts` takes `ownedPaths?: OwnedPathsPolicy`, returns `Pick<ToolRunContext, "interceptor" | "protectedPaths" | "ownedPaths">` and adds `ownedPaths: opts.ownedPaths`.
   - `createCodingToolRuntime`'s opts gain `ownedPaths?: OwnedPathsPolicy` (doc comment `/** S3-2 port: placed on every ToolRunContext this runtime builds. */`), passed through wherever `contextPorts` is called.
5. `glob.ts:150` and `scratchpad.ts:197`: `resolveWithin(ctx.root, hit, ctx.ownedPaths ?? EMPTY_OWNED_PATHS_POLICY)`.
6. `package-managers.ts`:
   - Add `readonly ownedPaths?: OwnedPathsPolicy;` to `NormalizeInput`.
   - `findPositionalPathConflict` gains a fifth parameter `owned: OwnedPathsPolicy` and calls `resolveWithin(repoRoot, absolute, owned)`.
   - Its call site (`:436`) passes `input.ownedPaths ?? EMPTY_OWNED_PATHS_POLICY`.
7. `run-command-exec.ts:130`: add `ownedPaths: ctx.ownedPaths,` to the `normalizeExec({...})` argument.
8. `coding-tool-support.ts`:
   - Add an arg next to `naxAllowWrite`:

     ```ts
     /** S3-2: host-owned path rules; forwarded to compileToolPolicy and onto every ToolRunContext. nax passes naxOwnedPathsPolicy. */
     ownedPaths?: OwnedPathsPolicy;
     ```

   - Add `ownedPaths: args.ownedPaths,` to the `compileToolPolicy` options and to the `createCodingToolRuntime` argument: one value for both (see Deviations). Plain properties, not conditional spreads, so `buildCodingToolSupport` stays at or under its complexity baseline of 38.
9. Comment-only: `tools/bash-cwd.ts:11-12` and `permissions/approvals-link.ts:5` name `nax-owned-writes.ts`. Reword them to name the `OwnedPathsPolicy` port (`tools/owned-paths.ts`).
10. nax, `coding-tool-support-resolve.ts`: import `naxOwnedPathsPolicy` and `type OwnedPathsPolicy` from `@nathapp/nax-agent/internal` (temporary, Task 1). Add `ownedPaths: OwnedPathsPolicy;` to the `_codingToolSupportDeps` type, with the doc comment `/** S3-2 port: the paths nax owns the writes to; injected into the tools (and, from Task 4, the sandbox). */`. Add `ownedPaths: naxOwnedPathsPolicy,` to its value, and `ownedPaths: _codingToolSupportDeps.ownedPaths,` to the `buildCodingToolSupport({...})` call next to `protectedPaths`.

- [ ] **Step 4: Run the new tests**

Run: `cd packages/nax-agent && bun test ./test/unit/tools/policy-owned-paths.test.ts --timeout=60000`, then `cd ../nax && bun test test/unit/agents/coding-tool-support-resolve.test.ts test/unit/agents/coding-tool-support-owned-paths.test.ts --timeout=60000`
Expected: PASS for both, including Task 1's end-to-end pin: nax now injects the policy.

- [ ] **Step 5: Typecheck and fix every `resolveWithin` call**

Run: `cd packages/nax-agent && bun run typecheck`
Expected: errors only at `resolveWithin` calls in nax-agent tests (the typecheck lists them; reviewers counted 3 to 6 files). Also run `cd ../nax && bun run typecheck`: nax tests that call `resolveWithin` directly (`test/unit/tools/run-command.test.ts`, `test/integration/permissions/bash-deny-suite.test.ts`) need the third argument too. For each, pass `naxOwnedPathsPolicy` (nax-agent tests: from `#src/tools/nax-owned-writes`; nax tests: from `@nathapp/nax-agent/internal`) when the test is about nax config or `.git`/containment behaviour as it is today, and `EMPTY_OWNED_PATHS_POLICY` when it only checks containment. If unsure, use `naxOwnedPathsPolicy`: it reproduces today's behaviour exactly.

- [ ] **Step 6: Run both suites and migrate failing tests mechanically**

Run: `cd packages/nax-agent && bun run test > /tmp/s3-2-t2.txt 2>&1; grep -E "^\(fail\)" /tmp/s3-2-t2.txt`

Each failure is a test that relied on the implicit nax policy. The fix is mechanical, and **assertions never change**:
- add `ownedPaths: naxOwnedPathsPolicy` to its `compileToolPolicy(...)` options;
- or to its `buildCodingToolSupport({...})` / `createCodingToolRuntime({...})` arguments;
- or to the `ToolRunContext` literal it builds.

For uniformity, add it to every such call in a file that has at least one failure. Re-run until clean.

Then run: `cd packages/nax && bun run test`
Expected: PASS. Tests that go through `resolveCodingToolSupport` get the policy from `_codingToolSupportDeps`. A nax test that calls `buildCodingToolSupport`, `compileToolPolicy` or `createCodingToolRuntime` directly and asserts an owned refusal fails; fix it the same mechanical way, with `ownedPaths: naxOwnedPathsPolicy` from `@nathapp/nax-agent/internal`. Task 1's end-to-end pin must be green.

- [ ] **Step 7: Lint, then commit**

Run: `cd packages/nax-agent && bun run lint`
Expected: clean. If `check-complexity` fails on `buildCodingToolSupport`, a conditional spread crept in; use the plain `ownedPaths: args.ownedPaths` property.

```bash
git add packages/nax-agent packages/nax
git commit -m "refactor(nax-agent): typed tool policy and resolveWithin read owned paths from the port; nax injects it"
```

---

### Task 3: The raw Bash screen consumes the port

**Files:**
- Modify: `packages/nax-agent/src/tools/policy-bash-raw.ts` (`RawScreenArgs`, `protectedHit`, `screenRawBashCommand`)
- Modify: `packages/nax-agent/src/tools/policy-command-branch.ts` (pass `ownedPaths`)
- Modify: `packages/nax-agent/src/tools/policy.ts` (add `ownedPaths: owned` to the `commandBranch({...})` args)
- Test: `packages/nax-agent/test/unit/tools/policy-bash-raw.test.ts` (append), plus the mechanical migration

**Interfaces:**
- Consumes: `OwnedPathsPolicy.bashRefusal`, `OwnedBashCandidate` (Task 1); `resolveWithin(..., owned)` (Task 2).
- Produces: `RawScreenArgs.ownedPaths: OwnedPathsPolicy` (required); the `commandBranch` args gain `ownedPaths: OwnedPathsPolicy`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/tools/policy-bash-raw.test.ts`. Reuse that file's helper that builds `RawScreenArgs`. Read its top first; if it has no helper, build the args inline as shown here.

```ts
describe("screenRawBashCommand reads owned paths from the port (S3-2)", () => {
  const args = (command: string, ownedPaths: OwnedPathsPolicy, sandboxWrapped = false): RawScreenArgs => ({
    tool: "Bash",
    command,
    initialPath: rawRoot,
    root: rawRoot,
    resolvePath: (candidate, cwd) => resolveWithin(rawRoot, resolve(cwd, candidate), ownedPaths),
    ownedPaths,
    sandboxWrapped,
  });

  test("with the empty policy a redirect into nax config is allowed", () => {
    expect(screenRawBashCommand(args("echo x > .nax/config.json", EMPTY_OWNED_PATHS_POLICY)).kind).toBe("allow");
  });

  test("with nax's policy the texts are today's", () => {
    const named = screenRawBashCommand(args("cat .queue.txt", naxOwnedPathsPolicy));
    expect(named).toMatchObject({ kind: "deny", reason: naxOwnedBashRefusal("Bash", "queue", ".queue.txt", "names") });
    const redirect = screenRawBashCommand(args("echo x > .nax/config.json", naxOwnedPathsPolicy));
    expect(redirect).toMatchObject({
      kind: "deny",
      reason: naxOwnedBashRefusal("Bash", "config", ".nax/config.json", "redirects into", { sandboxWrapped: false }),
    });
  });

  test("sandbox-wrapped: naming a PRD is allowed, redirecting into it is not", () => {
    expect(screenRawBashCommand(args("cat .nax/features/f/prd.json", naxOwnedPathsPolicy, true)).kind).toBe("allow");
    expect(screenRawBashCommand(args("echo x > .nax/features/f/prd.json", naxOwnedPathsPolicy, true)).kind).toBe("deny");
  });

  test("the port receives one candidate per live frame, in frame order", () => {
    // Every token is screened, the command word included, so record by token.
    const seen = new Map<string, readonly OwnedBashCandidate[]>();
    const spy: OwnedPathsPolicy = {
      ...EMPTY_OWNED_PATHS_POLICY,
      bashRefusal: (_tool, token, candidates) => {
        seen.set(token, candidates);
        return undefined;
      },
    };
    screenRawBashCommand(args("cat a.txt", spy));
    expect(seen.get("a.txt")).toEqual([{ lexical: join(rawRoot, "a.txt"), rel: "a.txt" }]);
  });
});
```

`rawRoot` is a realpath'd temp dir with `.nax/features/f/` created, set up in a `beforeEach` of this `describe`. Import `EMPTY_OWNED_PATHS_POLICY`, `type OwnedBashCandidate` and `type OwnedPathsPolicy` from `#src/tools/owned-paths`, `naxOwnedBashRefusal` and `naxOwnedPathsPolicy` from `#src/tools/nax-owned-writes`, `resolveWithin` from `#src/tools/policy`, and `type RawScreenArgs` from `#src/tools/policy-bash-raw`, if not already imported.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/nax-agent && bun test ./test/unit/tools/policy-bash-raw.test.ts --timeout=60000`
Expected: FAIL. The `ownedPaths` field has a type error, and the empty-policy redirect is still refused.

- [ ] **Step 3: Implement**

In `policy-bash-raw.ts`:
- Drop the `nax-owned-writes.ts` imports.
- Import `type OwnedBashCandidate, type OwnedPathsPolicy` from `./owned-paths.ts`.
- Add `readonly ownedPaths: OwnedPathsPolicy;` to `RawScreenArgs`, with the doc comment `/** S3-2: host-owned path rules; decides which tokens and redirects are refused and how. */`.
- Replace `protectedHit` with a candidate builder. Keep the existing doc comment, reworded: the two passes are now the policy's, and this function supplies one candidate per frame.

```ts
function ownedCandidates(args: RawScreenArgs, candidate: string, cwd: readonly string[]): OwnedBashCandidate[] {
  return cwd.map((directory) => {
    const resolved = args.resolvePath(candidate, directory);
    const rel = resolved === null ? null : relative(args.root, resolved).split(sep).join("/");
    return {
      lexical: realOrRaw(resolve(directory, candidate)),
      rel: rel === null || rel.startsWith("..") ? null : rel,
    };
  });
}
```

In `screenRawBashCommand`, the token loop becomes:

```ts
    for (const token of segment.tokens) {
      if (token.opaque) continue;
      const reason = args.ownedPaths.bashRefusal(tool, token.text, ownedCandidates(args, token.text, cwd), {
        root: args.root,
        verb: "names",
        sandboxWrapped,
      });
      if (reason !== undefined) return deny(reason);
    }
    for (const redirect of segment.redirects) {
      if (redirect.opaque) continue;
      const reason = args.ownedPaths.bashRefusal(tool, redirect.target, ownedCandidates(args, redirect.target, cwd), {
        root: args.root,
        verb: "redirects into",
        sandboxWrapped,
      });
      if (reason !== undefined) return deny(reason);
    }
```

Keep the US-002 comments next to these loops, saying the policy now applies the exemption. In `policy-command-branch.ts`, take `ownedPaths: OwnedPathsPolicy` in the args and pass it into `screenRawBashCommand({...})`. In `policy.ts`, add `ownedPaths: owned` to the `commandBranch({...})` call.

- [ ] **Step 4: Run, migrate, verify**

Run: `cd packages/nax-agent && bun test ./test/unit/tools/policy-bash-raw.test.ts --timeout=60000`
Expected: PASS. Then run `bun run typecheck`. Every `screenRawBashCommand(...)` / `RawScreenArgs` literal in tests without `ownedPaths` errors. Add `ownedPaths: naxOwnedPathsPolicy`, and change no assertions. Then run `bun run test` and migrate any remaining failures the same way as Task 2 Step 6.

- [ ] **Step 5: Complexity baseline, lint, then commit**

The rewrite lowers `screenRawBashCommand` (baseline 26). The ratchet fails on an improved but un-lowered function, so run:
`cd packages/nax-agent && bun ../repo-tooling/scripts/check-complexity.ts --package=. --update-baseline && bun run lint`
Expected: the baseline file shows the lowered score(s) only, and lint is clean.

```bash
git add packages/nax-agent
git commit -m "refactor(nax-agent): raw Bash screen reads owned paths from the port"
```

---

### Task 4: The sandbox reads owned paths from the port; protected-path fields become optional

**Files:**
- Modify: `packages/nax-agent/src/tools/protected-paths.ts` (`projectStateDir`, `credentialDir`, `trustStoreFile` optional)
- Modify: `packages/nax-agent/src/sandbox/policy-builder.ts` (`SandboxPolicyInput.ownedPaths`, `SandboxPolicyInput.projectStateDir`, `naxDenies`, `denyWrite`)
- Modify: `packages/nax-agent/src/coding-tools/coding-tool-sandbox.ts` (`resolveSessionSandbox` args `ownedPaths`; skip absent protected paths)
- Modify: `packages/nax/src/agents/coding-tool-support-resolve.ts` (pass `ownedPaths` to `resolveSessionSandbox` in `resolveDispatchLauncher`)
- Test: `packages/nax-agent/test/unit/sandbox/policy-builder.test.ts` (append, plus migration), `packages/nax-agent/test/unit/coding-tools/coding-tool-sandbox.test.ts` (append), `packages/nax/test/integration/sandbox/sandbox-live.test.ts` (migration)

**Interfaces:**
- Consumes: `OwnedPathsPolicy` (Task 1).
- Produces:
  - `ProtectedPathsPolicy.projectStateDir?`, `.credentialDir?`, `.trustStoreFile?`
  - `SandboxPolicyInput.ownedPaths: OwnedPathsPolicy` (required); `SandboxPolicyInput.projectStateDir?: string`
  - `resolveSessionSandbox({ ..., ownedPaths: OwnedPathsPolicy })`: **required**, like `protectedPaths`, so no caller silently gets an empty policy

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/sandbox/policy-builder.test.ts`. Reuse its input factory and add the two fields:

```ts
describe("buildSandboxPolicy reads owned paths from the port (S3-2)", () => {
  test("nax's policy and a project-state dir give today's denies", () => {
    const policy = buildSandboxPolicy({ ...input(), ownedPaths: naxOwnedPathsPolicy, projectStateDir: ".nax", naxEntries: [] });
    expect(policy.denyWrite).toContain(join(root, ".nax", "config.json"));
    expect(policy.denyWrite).toContain(join(root, ".queue.txt"));
    expect(policy.denyWrite).not.toContain(join(root, ".nax", "scratchpad"));
  });

  test("the empty policy denies no owned entries and no root files", () => {
    const policy = buildSandboxPolicy({ ...input(), ownedPaths: EMPTY_OWNED_PATHS_POLICY, projectStateDir: ".nax", naxEntries: ["features"] });
    expect(policy.denyWrite).toContain(join(root, ".nax", "features"));
    expect(policy.denyWrite).not.toContain(join(root, ".nax", "config.json"));
    expect(policy.denyWrite).not.toContain(join(root, ".queue.txt"));
  });

  test("no project-state dir: no project-state denies at all", () => {
    const policy = buildSandboxPolicy({ ...input(), ownedPaths: naxOwnedPathsPolicy, naxEntries: ["features"] });
    expect(policy.denyWrite.some((p) => p.includes(`${join(root, ".nax")}`))).toBe(false);
    expect(policy.denyWrite).toContain(join(root, ".queue.txt"));
  });
});
```

`input(over)` and `root` are the file's existing `SandboxPolicyInput` factory and realpath'd root. Add `ownedPaths: naxOwnedPathsPolicy, projectStateDir: ".nax"` to `input()`'s defaults once (that is the whole literal migration for this file); the overrides above then only vary what each case needs.

Append to `test/unit/coding-tools/coding-tool-sandbox.test.ts`. Copy the setup of its two `#17` tests (around lines 220-250) verbatim: the describe's `withDepsRestore(_sessionSandboxDeps)`, `_sessionSandboxDeps.backendFor = () => makeFakeSandboxBackend()`, `probe = async () => ({ available: true })`, `gitLayout`, and the file's `enabled` config const. Then record the two lookups:

```ts
  test("S3-2: absent credentialDir, projectStateDir and trustStoreFile are skipped, not errors", async () => {
    // ...the #17 setup lines, verbatim...
    const lookups: string[] = [];
    _sessionSandboxDeps.credentialFiles = async (dir) => {
      lookups.push(`credentialFiles:${dir}`);
      return [];
    };
    _sessionSandboxDeps.naxEntries = async (root, dir) => {
      lookups.push(`naxEntries:${root}:${dir}`);
      return [];
    };
    const launcher = await resolveSessionSandbox({
      config: enabled,
      root,
      needsLauncher: true,
      protectedPaths: { gitExcludePathspecs: [], gitIgnorePatterns: [] },
      ownedPaths: EMPTY_OWNED_PATHS_POLICY,
    });
    expect(launcher).toBeDefined();
    expect(lookups).toEqual([]);
  });
```

Match the `naxEntries` and `credentialFiles` parameter lists to `_sessionSandboxDeps`' declared types, and `root`/`enabled` to the `#17` tests' own names.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/nax-agent && bun test ./test/unit/sandbox/policy-builder.test.ts --timeout=60000` and the `resolveSessionSandbox` test file.
Expected: FAIL with type errors on `ownedPaths` / `projectStateDir` and on the optional protected-path fields.

- [ ] **Step 3: Implement**

1. `protected-paths.ts`: mark `projectStateDir`, `credentialDir` and `trustStoreFile` optional (`readonly x?: string`). Add to each doc comment: "Absent: the sandbox skips it (S3 spec 6.2)."
2. `policy-builder.ts`:
   - Drop the `nax-owned-writes.ts` import, and add `import type { OwnedPathsPolicy } from "../tools/owned-paths.ts";`.
   - Add to `SandboxPolicyInput`:

     ```ts
     /** S3-2: host-owned path rules; supplies the always-denied project-state entries and root files. */
     readonly ownedPaths: OwnedPathsPolicy;
     /** Project-relative state directory (ProtectedPathsPolicy.projectStateDir); absent: no project-state denies. */
     readonly projectStateDir?: string;
     ```

   - Replace `naxDenies` with:

     ```ts
     function projectStateDenies(input: SandboxPolicyInput): string[] {
       const { root, projectStateDir, ownedPaths } = input;
       if (projectStateDir === undefined) return [];
       const optIns = ownedPaths.writeOptIns(root, input.config.filesystem.allowWrite);
       return [...new Set([...input.naxEntries, ...ownedPaths.deniedEntries])]
         .filter((name) => name !== ownedPaths.scratchpadEntry && !optIns.has(name))
         .map((name) => join(root, projectStateDir, name));
     }
     ```

     Keep the existing `naxDenies` doc comment above it, adjusted: the entries come from the port, the directory from `projectStateDir`.
   - In `denyWrite`, replace the first two lines with `...projectStateDenies(input),` and `...input.ownedPaths.rootWriteDenies.map((name) => join(root, name)),`.
3. `coding-tool-sandbox.ts`:
   - Import `type OwnedPathsPolicy` from `../tools/owned-paths.ts`.
   - Add a required arg next to `protectedPaths`:

     ```ts
     /** S3-2: host-owned path rules; nax passes naxOwnedPathsPolicy, an embedder EMPTY_OWNED_PATHS_POLICY. */
     readonly ownedPaths: OwnedPathsPolicy;
     ```

   - `const credentialDir = args.protectedPaths.credentialDir;` then `const credentialFiles = credentialDir === undefined ? [] : await _sessionSandboxDeps.credentialFiles(credentialDir);`.
   - In `policyFor`:

     ```ts
     naxEntries:
       args.protectedPaths.projectStateDir === undefined
         ? []
         : await _sessionSandboxDeps.naxEntries(root, args.protectedPaths.projectStateDir),
     ...(args.protectedPaths.projectStateDir !== undefined ? { projectStateDir: args.protectedPaths.projectStateDir } : {}),
     ownedPaths: args.ownedPaths,
     ```

     The `trustStoreFile:` line becomes `...(args.protectedPaths.trustStoreFile !== undefined ? { trustStoreFile: args.protectedPaths.trustStoreFile } : {}),`.

4. nax, `coding-tool-support-resolve.ts`, `resolveDispatchLauncher`: add `ownedPaths: _codingToolSupportDeps.ownedPaths,` to the `resolveSessionSandbox({...})` call next to `protectedPaths`.

- [ ] **Step 4: Run, migrate, verify**

Run: `cd packages/nax-agent && bun run typecheck`, then `cd ../nax && bun run typecheck`. Every `buildSandboxPolicy({...})` literal and every `resolveSessionSandbox({...})` call in tests now needs `ownedPaths` (and the builder `projectStateDir: ".nax"`). Pass `naxOwnedPathsPolicy` wherever the test asserts nax denies (for example `nax/test/integration/sandbox/sandbox-live.test.ts`, which asserts the `.nax/config.json` deny), and `EMPTY_OWNED_PATHS_POLICY` otherwise. Change no assertions.
Then run `cd packages/nax-agent && bun run test` and `cd ../nax && bun run test`.
Expected: both pass, including Task 1's sandbox pin (`coding-tool-support-resolve.test.ts`).

- [ ] **Step 5: Lint, then commit**

Run: `cd packages/nax-agent && bun run lint`
Expected: clean.

```bash
git add packages/nax-agent packages/nax
git commit -m "refactor(nax-agent): sandbox reads owned paths from the port; protected-path fields optional"
```

---

### Task 5: Move the module to nax and inject it

**Files:**
- Move: `packages/nax-agent/src/tools/nax-owned-writes.ts` → `packages/nax/src/agents/nax-owned-writes.ts` (`git mv`)
- Create: `packages/nax-agent/test/helpers/nax-owned-paths.ts` (verbatim copy, with imports adjusted)
- Move: `packages/nax-agent/test/unit/tools/nax-owned-writes.test.ts` → `packages/nax/test/unit/agents/nax-owned-writes.test.ts` (`git mv`)
- Modify: `packages/nax/src/agents/coding-tool-support-resolve.ts` (import from the moved module)
- Modify: `packages/nax-agent/src/internal.ts` (drop the temporary `nax-owned-writes` export)
- Create: `packages/nax/test/unit/agents/nax-owned-writes-copy.test.ts` (drift guard)
- Modify: every nax-agent test importing `#src/tools/nax-owned-writes` (switch to `#test/helpers/nax-owned-paths`), and every nax test importing it from `@nathapp/nax-agent/internal` (switch to `@/agents/nax-owned-writes`)

**Interfaces:**
- Consumes: everything above.
- Produces: `naxOwnedPathsPolicy` exported from `packages/nax/src/agents/nax-owned-writes.ts`.

- [ ] **Step 1: Write the failing drift guard**

`packages/nax/test/unit/agents/nax-owned-writes-copy.test.ts`:

```ts
/**
 * nax-agent's test helper is a verbatim copy of this module (S3-2). nax-agent
 * cannot import nax, so the copy keeps nax-agent's engine tests on nax's real
 * rules; this test fails when the two drift. Import lines and the helper's
 * one-line provenance header are the only permitted differences.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const normalise = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.startsWith("import ") && !line.startsWith("// Verbatim copy of nax"))
    .join("\n")
    .trim();

describe("nax-agent's nax-owned-paths test helper", () => {
  test("is a verbatim copy of src/agents/nax-owned-writes.ts", () => {
    const original = readFileSync(join(import.meta.dir, "../../../src/agents/nax-owned-writes.ts"), "utf8");
    const copy = readFileSync(join(import.meta.dir, "../../../../nax-agent/test/helpers/nax-owned-paths.ts"), "utf8");
    expect(normalise(copy)).toBe(normalise(original));
  });
});
```

Run: `cd packages/nax && bun test test/unit/agents/nax-owned-writes-copy.test.ts --timeout=60000`
Expected: FAIL, with ENOENT on both files.

- [ ] **Step 2: Move the module and leave the test copy**

```bash
cp packages/nax-agent/src/tools/nax-owned-writes.ts packages/nax-agent/test/helpers/nax-owned-paths.ts
git mv packages/nax-agent/src/tools/nax-owned-writes.ts packages/nax/src/agents/nax-owned-writes.ts
git mv packages/nax-agent/test/unit/tools/nax-owned-writes.test.ts packages/nax/test/unit/agents/nax-owned-writes.test.ts
```

- In `packages/nax/src/agents/nax-owned-writes.ts`:
  - Replace `import { realOrRaw } from "#src/internal/realpath";` with `import { realOrRaw } from "@nathapp/nax-agent/internal";`.
  - Replace `import type { OwnedBashCandidate, OwnedPathsPolicy } from "./owned-paths.ts";` with an import from `@nathapp/nax-agent/internal` (exported there since Task 1; Task 7 switches it to `@nathapp/nax-agent`).
  - Update the header comment: it now lives in nax, injected through the `OwnedPathsPolicy` port (S3 spec 6.5, D16).
  - Update the comment on `NAX_SCRATCHPAD_ENTRY` that names a cycle that no longer exists: say it must equal the last segment of nax-agent's `SCRATCHPAD_DIR`, pinned by a test.
- In `packages/nax-agent/test/helpers/nax-owned-paths.ts`:
  - Prepend `// Verbatim copy of nax's src/agents/nax-owned-writes.ts (S3-2), the S2-3c precedent: nax-agent's engine tests exercise the port with nax's real rules; nax's own tests pin the original.`.
  - Point the imports at `#src/internal/realpath` and `#src/tools/owned-paths`. Every non-import line stays identical to nax's file (the drift guard compares them); if nax's header comment is edited in this step, copy the edited text.
- In the moved test file: replace `#src/tools/nax-owned-writes` with `@/agents/nax-owned-writes`, `#src/tools/scratchpad` with `@nathapp/nax-agent/internal` (for `SCRATCHPAD_DIR`; confirm it is exported there, or use the export path nax already uses for scratchpad constants), and any `#test/...` helper imports with nax's `@test/helpers` equivalents.

- [ ] **Step 3: Switch imports and drop the temporary export**

```bash
cd packages/nax-agent
for f in $(grep -rl '#src/tools/nax-owned-writes' test); do sed -i '' 's|#src/tools/nax-owned-writes|#test/helpers/nax-owned-paths|g' "$f"; done
cd ../nax
grep -rln 'naxOwnedPathsPolicy\|naxOwnedBashRefusal\|NAX_ALWAYS_DENIED_ENTRIES' src test
```

For each nax file the last command lists, move those names out of their `@nathapp/nax-agent/internal` import into `import { ... } from "@/agents/nax-owned-writes";` (`coding-tool-support-resolve.ts` imports `./nax-owned-writes`). Then remove `export * from "#src/tools/nax-owned-writes";` from `packages/nax-agent/src/internal.ts`, keeping the `owned-paths` line.

- [ ] **Step 4: Typecheck both packages**

Run: `cd packages/nax-agent && bun run typecheck && cd ../nax && bun run typecheck`
Expected: clean. A remaining error names a file still importing the moved module from nax-agent.

- [ ] **Step 5: Run the pins and the drift guard**

Run: `cd packages/nax && bun test test/unit/agents/coding-tool-support-owned-paths.test.ts test/unit/agents/coding-tool-support-resolve.test.ts test/unit/agents/nax-owned-writes.test.ts test/unit/agents/nax-owned-writes-copy.test.ts --timeout=60000`
Expected: PASS, with the Task 1 strings unchanged.

- [ ] **Step 6: Prove nax-agent no longer holds nax-owned knowledge**

Run: `cd packages/nax-agent && grep -rn 'queue\.txt\|prd\.json\|NAX_ALWAYS_DENIED\|naxOwned\|isNaxConfigFile\|nax-owned-writes' src`
Expected: no match in CODE except the permitted prose: the raw Bash tool description string (`tools/bash.ts:175-176`, carries a `nax-feature-dir-allow` marker), `tools/denial-redirect.ts` and `sandbox/messages.ts`, which stay byte-identical (Global Constraints). Comments may name the port or nax as the owner; reword any comment that still describes nax's rules as nax-agent's own.

- [ ] **Step 7: Docs**

Update the mentions of `nax-owned-writes.ts` in `docs/architecture/ARCHITECTURE.md`, `subsystems.md`, `design-patterns.md` and `agent-adapters.md` (find them with `grep -rn "owned-writes\|nax-owned" docs/architecture`). Each now names nax's `src/agents/nax-owned-writes.ts` injected through nax-agent's `OwnedPathsPolicy` port.

- [ ] **Step 8: Both suites, gates, commit**

Run: `cd packages/nax-agent && bun run typecheck && bun run lint && bun run test`, then `cd ../nax && bun run test && bun run check:all`
Expected: all green. In nax, `check:feature-dir-ssot`, `check:file-sizes` and `check:package-boundaries` must accept the moved file. If `check:feature-dir-ssot` flags a literal in a moved comment, reword the comment rather than allowlisting.

```bash
git add -A packages/nax-agent packages/nax docs/architecture
git commit -m "refactor: move nax's owned-path rules into nax behind the OwnedPathsPolicy port (D16)"
```

---

### Task 6: Credential read-deny in Read, Glob and Grep

**Files:**
- Create: `packages/nax-agent/src/tools/credential-read-deny.ts`
- Modify: `packages/nax-agent/src/tools/read.ts` (`run`, after the `target` check), `glob.ts` (the hit loop), `grep.ts` (`run`, before spawning)
- Test: `packages/nax-agent/test/unit/tools/credential-read-deny.test.ts` (new)

**Interfaces:**
- Consumes: `ProtectedPathsPolicy` with optional `credentialDir` / `trustStoreFile` (Task 4); `ToolRunContext.protectedPaths`.
- Produces:
  - `credentialReadRefusal(protectedPaths: ProtectedPathsPolicy | undefined, resolved: string): string | undefined`
  - `containsCredentialPath(protectedPaths: ProtectedPathsPolicy | undefined, dir: string): boolean`
  - `credentialPathTest(protectedPaths: ProtectedPathsPolicy | undefined): (resolved: string) => boolean`

- [ ] **Step 1: Write the failing tests**

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containsCredentialPath, credentialReadRefusal } from "#src/tools/credential-read-deny";
import { testProtectedPaths } from "#test/helpers/protected-paths";

let root: string;
let credDir: string;
let trust: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cred-deny-")));
  credDir = join(root, "home", ".nax");
  mkdirSync(credDir, { recursive: true });
  writeFileSync(join(credDir, "credentials.json"), "{}");
  trust = join(root, "home", "trust.json");
  writeFileSync(trust, "{}");
  writeFileSync(join(root, "ok.txt"), "x");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const pp = () => testProtectedPaths({ credentialDir: credDir, trustStoreFile: trust });

describe("credentialReadRefusal", () => {
  test("a file inside the credential directory is refused", () => {
    expect(credentialReadRefusal(pp(), join(credDir, "credentials.json"))).toContain("credential");
  });

  test("the credential directory itself and the trust-store file are refused", () => {
    expect(credentialReadRefusal(pp(), credDir)).toBeDefined();
    expect(credentialReadRefusal(pp(), trust)).toBeDefined();
  });

  test("an ordinary file is not", () => {
    expect(credentialReadRefusal(pp(), join(root, "ok.txt"))).toBeUndefined();
  });

  test("a symlink into the credential directory is refused", () => {
    symlinkSync(credDir, join(root, "link"));
    expect(credentialReadRefusal(pp(), join(root, "link", "credentials.json"))).toBeDefined();
  });

  test.if(process.platform === "darwin")("a case-variant spelling on a case-insensitive filesystem is refused", () => {
    expect(credentialReadRefusal(pp(), join(root, "home", ".NAX", "credentials.json"))).toBeDefined();
  });

  test("no policy, or a policy without credential fields, refuses nothing", () => {
    expect(credentialReadRefusal(undefined, join(credDir, "credentials.json"))).toBeUndefined();
    expect(
      credentialReadRefusal({ gitExcludePathspecs: [], gitIgnorePatterns: [] }, join(credDir, "credentials.json")),
    ).toBeUndefined();
  });
});

describe("containsCredentialPath", () => {
  test("a directory that contains the credential directory or the trust store", () => {
    expect(containsCredentialPath(pp(), root)).toBe(true);
    expect(containsCredentialPath(pp(), join(root, "home"))).toBe(true);
  });

  test("a directory that does not", () => {
    mkdirSync(join(root, "src"));
    expect(containsCredentialPath(pp(), join(root, "src"))).toBe(false);
  });
});
```

Then add tool-level tests at the end of the same file. Build a `ToolRunContext` literal the way `test/unit/tools/read.test.ts` does; read its context helper first and reuse it:

```ts
describe("Read, Glob and Grep apply the credential read-deny", () => {
  test("Read refuses a credential file", async () => {
    const result = await readTool.run({ path: "home/.nax/credentials.json" }, ctxFor([join(credDir, "credentials.json")]));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("credential");
  });

  test("Glob drops credential hits but keeps the rest", async () => {
    // Explicit dot-dir patterns: Bun's glob does not descend dot directories by default.
    const listed = await globTool.run({ pattern: "home/.nax/*.json" }, ctxFor([]));
    expect(listed.content).not.toContain("credentials.json");
    const top = await globTool.run({ pattern: "home/*" }, ctxFor([]));
    expect(top.content).not.toContain("trust.json");
    const control = await globTool.run({ pattern: "*.txt" }, ctxFor([]));
    expect(control.content).toContain("ok.txt");
  });

  test("Glob drops hits reached through a symlink into the credential directory", async () => {
    symlinkSync(credDir, join(root, "link"));
    const listed = await globTool.run({ pattern: "link/*" }, ctxFor([]));
    expect(listed.content).not.toContain("credentials.json");
  });

  test("Grep refuses a search whose target contains the credential directory", async () => {
    const result = await grepTool.run({ pattern: "x" }, ctxFor([root]));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("narrow");
  });

  test("Grep inside an unrelated subdirectory still runs", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "needle");
    const result = await grepTool.run({ pattern: "needle", path: "src" }, ctxFor([join(root, "src")]));
    expect(result.isError).not.toBe(true);
  });
});
```

Here `ctxFor(resolvedPaths)` returns `{ root, resolvedPaths, maxBytes: 100_000, maxFileBytes: 1_000_000, protectedPaths: pp() }`, and `readTool`, `globTool` and `grepTool` are the exported tool objects. Use the names those files export: check each file's `export const`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/nax-agent && bun test ./test/unit/tools/credential-read-deny.test.ts --timeout=60000`
Expected: FAIL, module not found.

- [ ] **Step 3: Create `src/tools/credential-read-deny.ts`**

```ts
/**
 * Read-deny for the host's credential directory and trust-store file in the
 * read tools (S3 spec 6.3). Before S3-2 only the sandbox enforced these, and
 * only for Bash; Read, Glob and Grep enforced root containment alone, so a
 * workdir containing the credential directory exposed it.
 *
 * Paths are compared in canonical form: `realpathSync.native` for a path that
 * exists returns the on-disk casing on a case-insensitive filesystem, where
 * `realOrRaw` (JS `realpathSync`) keeps the caller's casing and would let
 * `.NAX/credentials.json` past a `.nax` prefix check. A path that does not
 * exist cannot be read, so its lexical form is enough.
 */

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { realOrRaw } from "#src/internal/realpath";
import type { ProtectedPathsPolicy } from "./protected-paths.ts";

function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return realOrRaw(p);
  }
}

function isWithin(base: string, target: string): boolean {
  return target === base || target.startsWith(`${base}${sep}`);
}

function credentialRoots(protectedPaths: ProtectedPathsPolicy | undefined): string[] {
  if (protectedPaths === undefined) return [];
  return [protectedPaths.credentialDir, protectedPaths.trustStoreFile]
    .filter((p): p is string => p !== undefined)
    .map(canonical);
}

const CREDENTIAL_REFUSAL = "is a host credential or trust-store path, which the read tools are refused regardless of grant";

/**
 * A predicate over resolved paths, with the credential roots canonicalised
 * once: Glob tests every hit, and a native realpath per root per hit is waste.
 */
export function credentialPathTest(protectedPaths: ProtectedPathsPolicy | undefined): (resolved: string) => boolean {
  const roots = credentialRoots(protectedPaths);
  if (roots.length === 0) return () => false;
  return (resolved) => {
    const target = canonical(resolved);
    return roots.some((base) => isWithin(base, target));
  };
}

/** Why `resolved` may not be read, or undefined when it may. */
export function credentialReadRefusal(
  protectedPaths: ProtectedPathsPolicy | undefined,
  resolved: string,
): string | undefined {
  return credentialPathTest(protectedPaths)(resolved) ? CREDENTIAL_REFUSAL : undefined;
}

/** True when searching `dir` would reach the credential directory or the trust store. */
export function containsCredentialPath(protectedPaths: ProtectedPathsPolicy | undefined, dir: string): boolean {
  const base = canonical(dir);
  return credentialRoots(protectedPaths).some((cred) => isWithin(base, cred));
}
```

- [ ] **Step 4: Apply it in the tools, within the complexity baselines**

`read.ts run` is at its baseline (24), `grep.ts run` at 21, and `glob.ts run` is capped at 20. Each refusal is one helper call plus one `if`; offset that `if` by extracting existing logic into a helper in the same file (in `read.ts`, the `offset`/`limit` parsing block is a natural candidate).

- `read.ts`, right after `if (target === undefined) ...`:

  ```ts
      const credential = credentialReadRefusal(ctx.protectedPaths, target);
      if (credential !== undefined) return { content: `path "${String(input.path)}" ${credential}`, isError: true };
  ```

- `glob.ts`: before the scan loop, `const isCredential = credentialPathTest(ctx.protectedPaths);`. In the loop, right after the `resolveWithin` filter, `if (isCredential(join(ctx.root, hit))) continue;`. Import `join` if it is missing.
- `grep.ts`: add a helper and call it once from `run`, after `const [target] = ctx.resolvedPaths;`:

  ```ts
  /** The credential read-deny for a search rooted at `searchRoot` (S3 spec 6.3), or undefined. */
  function credentialSearchRefusal(ctx: ToolRunContext, searchRoot: string, shown: string): string | undefined {
    const inside = credentialReadRefusal(ctx.protectedPaths, searchRoot);
    if (inside !== undefined) return `path "${shown}" ${inside}`;
    if (!containsCredentialPath(ctx.protectedPaths, searchRoot)) return undefined;
    return (
      "this search would reach the host's credential directory or trust store, which the read tools are refused; " +
      "narrow the search to a subdirectory that does not contain it"
    );
  }
  ```

  In `run`: `const refusal = credentialSearchRefusal(ctx, target ?? ctx.root, typeof input.path === "string" ? input.path : ".");` then `if (refusal !== undefined) return { content: refusal, isError: true };`.

After editing, run `cd packages/nax-agent && bun ../repo-tooling/scripts/check-complexity.ts --package=.`. It must pass; if a `run` rose, extract more existing logic rather than raising its baseline (the gate refuses to raise one).

- [ ] **Step 5: Run, then the read-tool suites**

Run: `cd packages/nax-agent && bun test ./test/unit/tools/credential-read-deny.test.ts ./test/unit/tools/ --timeout=60000`
Expected: PASS. A read-tool test that uses `testProtectedPaths()` with defaults is unaffected, because those paths are under `tmpdir()`, outside its temp root. A test whose root is `tmpdir()` itself would now see the refusal. If one exists, give it an explicit `credentialDir` outside its root.

- [ ] **Step 6: Lint, then commit**

Run: `cd packages/nax-agent && bun run lint`
Expected: clean.

```bash
git add packages/nax-agent
git commit -m "feat(nax-agent): Read, Glob and Grep refuse the credential directory and trust store"
```

---

### Task 7: Public surface and full gates

**Files:**
- Modify: `packages/nax-agent/src/index.ts`, `src/internal.ts`
- Regenerate: `packages/nax-agent/api/nax-agent.api.txt`
- Modify: `packages/nax/src/agents/nax-owned-writes.ts` and `coding-tool-support-resolve.ts` (switch type imports to `@nathapp/nax-agent`)
- Test: `packages/nax-agent/test/node/owned-paths.test.ts` (new)

**Interfaces:**
- Produces on `.`: `type OwnedPathsPolicy`, `type OwnedBashCandidate`, `EMPTY_OWNED_PATHS_POLICY`. `/internal` gains `export * from "#src/tools/owned-paths"` and `export * from "#src/tools/credential-read-deny"`, and loses whatever it re-exported from the moved module.

- [ ] **Step 1: Write the failing Node case**

```ts
import { describe, expect, test } from "vitest";
import { EMPTY_OWNED_PATHS_POLICY } from "#src/index";

describe("owned-paths port on Node", () => {
  test("the empty policy is exported from the public entry and refuses nothing", () => {
    expect(EMPTY_OWNED_PATHS_POLICY.configRefusal("/r", "/r/.nax/config.json")).toBeUndefined();
    expect(EMPTY_OWNED_PATHS_POLICY.deniedEntries).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/nax-agent && bun run test:node`
Expected: FAIL, `EMPTY_OWNED_PATHS_POLICY` is not exported.

- [ ] **Step 3: Export**

- Add `export { EMPTY_OWNED_PATHS_POLICY, type OwnedBashCandidate, type OwnedPathsPolicy } from "#src/tools/owned-paths";` to `src/index.ts`, next to the existing `ProtectedPathsPolicy` export.
- Add the two `export *` lines to `src/internal.ts`, next to the other `#src/tools/*` lines.
- Switch nax's two type imports from `@nathapp/nax-agent/internal` to `@nathapp/nax-agent`.

- [ ] **Step 4: API snapshot**

Run: `cd packages/nax-agent && bun run test:node && bun run check:api`
Expected: `test:node` PASS. `check:api` lists additions only: the three new `.` names, and `credential-read-deny`'s names on `/internal`. (Task 1 already added the port to `/internal`, and Task 5 removed the temporary nax-owned names, so those net out.) The snapshot records names only, so it does not show these signature changes on `.`; review them by hand and name them in the CHANGELOG: `resolveWithin` gains a required third parameter, `SandboxPolicyInput` gains `ownedPaths` (required) and `projectStateDir`, `buildSandboxPolicy` follows, and three `ProtectedPathsPolicy` fields become optional. Run `bun run api:update` and review the diff.

Add a `packages/nax-agent/CHANGELOG.md` entry under `## [Unreleased]`: the `OwnedPathsPolicy` port and `EMPTY_OWNED_PATHS_POLICY`; the signature changes above; owned-path rules now injected by the host (nax keeps today's behaviour); the credential read-deny in Read, Glob and Grep.

- [ ] **Step 5: Full gates for both packages**

Run, from `packages/nax-agent`: `bun run typecheck && bun run lint && bun run test && bun run test:node && bun run test:coverage && bun run check:api`
Then from the repo root: `bun run typecheck && bun run check:all`
Then from `packages/nax`: `bun run test`
Expected: all green. Coverage holds 80% per file for `owned-paths.ts` and `credential-read-deny.ts`.

Then check that `bun packages/nax/bin/nax.ts --help | md5` and `bun packages/nax/bin/nax.ts --version` are identical on this branch and on `main` (switch branches with a clean tree, as S3-1 did).

- [ ] **Step 6: Commit**

```bash
git add packages/nax-agent packages/nax
git commit -m "feat(nax-agent): export the OwnedPathsPolicy port on the public entry"
```

- [ ] **Step 7: Review before push, then PR (approval)**

Run the pre-push review (an independent `code-reviewer` plus your own read of the diff), fix test-first, and push and open the PR only on the user's go-ahead. The PR body follows #2343's shape and lists the five Review Focus items with the test that pins each.

---

## Self-review notes

- **Spec coverage:**
  - §6.5: the port (Task 1); `nax-owned-writes.ts` moves to nax (Task 5); nax injects through `buildCodingToolSupport` (Task 5); `compileToolPolicy` keeps its option names (Task 2); the pinning tests move or switch to an injected fixture (Tasks 2-5); refusal texts stay byte-identical (the Task 1 pin and the unchanged assertions); the facade default is empty (Tasks 1-2).
  - §6.2: the three fields become optional, and the sandbox skips absent ones (Task 4).
  - §6.3: credential read-deny in Read, Glob and Grep with symlinks resolved (Task 6); case-insensitive spelling (Task 6, Review Focus 1).
  - §9: "refusals pinned; read-deny only fires when a workdir contains the credential directory" (Tasks 1 and 6).
- **Spec consumers versus the code:** the spec lists six consumers. The code also mentions the module in `tools/bash-cwd.ts` and `permissions/approvals-link.ts`, but in comments only (Task 2 Step 3 item 9). Real consumers outside the spec's list: `resolveWithin`'s callers in `glob.ts`, `scratchpad.ts` and `package-managers.ts` reach the config rule through `resolveWithin` (Task 2).
- **Out of scope, noted for later:** `isNaxConfigFile` and the PRD/queue rules compare with `realOrRaw`, which keeps the caller's casing. A case-variant spelling (`.NAX/CONFIG.JSON`) of a nax-owned path on a case-insensitive filesystem may therefore pass today's typed-tool refusal. This is existing behaviour that the port moves unchanged, so it is not fixed in a behaviour-neutral PR. Verify it and file it as a nax issue.
- **Write tools and the credential directory:** spec §6.3 names only the read tools. A Write or Delete into the credential directory, when a workdir contains it, is still governed only by containment and grants. Edit returns the edited region, and ScratchpadRead/List follow symlinks under `.nax/scratchpad`. Hard links into the workdir need write access to create. None are changed here.
- **Known behaviour, accepted by spec §6.3:** a nax run whose workdir is `$HOME` contains `~/.nax`, which is both the global config dir and the project state dir. Every Grep without a narrower `path` is then refused, and Read of the PRD is refused. Spec §6.3 accepts this ("refuses as it should"). nax's test preload points `NAX_GLOBAL_CONFIG_DIR` at a temp dir, so the suites are unaffected.
- **Plan final review (2026-10-04):** two read-only reviewers (codebase accuracy, feasibility/security), both "ready after fixes", 3+1 BLOCKERs, about 9 MAJORs. One fix round folded in: nax injects in Tasks 2 and 4 (the pin stays green), temporary `/internal` exports, the real `check(tool, scope, input)` signature, the token-keyed candidate test, `toMatchObject`, the redirect suffix on `cat`, the real test-setup names, Glob and Exec pins, complexity baselines, required `resolveSessionSandbox.ownedPaths`, the drift guard, docs and CHANGELOG, and an additive-only `check:api` expectation.
