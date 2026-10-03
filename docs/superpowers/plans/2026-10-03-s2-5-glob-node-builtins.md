# S2–5 Glob Runtime and Node Built-ins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish removing Bun APIs from nax-agent source by implementing glob through the runtime slot, replacing filesystem and hash calls with Node built-ins, and enforcing the boundary in CI.

**Architecture:** Extend the S2–4 process-wide runtime with asynchronous and synchronous glob operations. A focused Node glob module normalizes enumeration to shared behaviour cases; nax installs its existing Bun runtime with matching glob methods. File I/O and crypto use Node built-ins directly, retaining existing test seams and tool output formats.

**Tech Stack:** TypeScript, Bun workspaces and bun:test, node:fs, node:fs/promises, node:crypto, node:assert/strict, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-02-s2-nax-agent-node-ready-publish-design.md`, §§4.1–4.5, 7.3, 9 (S2–5 row). Arc SSOT: `/Users/williamkhoo/workspace/subrina-coder/projects/nax/nax-agent-master-plan.md`, D17–D21. Read both before execution.

## Global Constraints

- Node floor: `>=22.19.0`; TypeScript target pin: `7.0.2` (exact pin/build changes belong to S2–6).
- “nax-agent ships no Bun code.” No exceptions in its source gate; bun:test suites remain on Bun.
- “Results are files only and exclude dotfiles.” D21 additionally excludes explicitly named dotfiles and all dot-directory paths in both runtimes. This is the one approved CLI behaviour change.
- “A missing cwd throws ENOENT”; preserve ENOTDIR for a cwd that is a file.
- “The runtime slot is module-level and process-wide. S3 decides whether it becomes per-session.” Retain S2–4's `setAgentRuntime(runtime: AgentRuntime | null): void` reset contract.
- “Windows is unsupported, as for nax.” Do not introduce a glob dependency.
- Coverage: `80% lines and functions overall`, `80% per file`, empty baseline; never add exceptions to accommodate new source files.
- Runtime dependencies stay unchanged: `@nathapp/nax-ai`, `@anthropic-ai/sandbox-runtime`, `zod`. test-kit and repo-tooling remain private leaf packages.
- Workspace exports continue resolving `.ts` source. ESM codemod/build is S2–6; curated API is S2–7; vitest/packed-tarball matrix is S2–8; publishing is S2–9.
- Never run bare `bun test` or `bun run nax`. Prefix shell commands with `rtk`; run package commands in the named package.
- `nax run` / `nax plan` smokes need explicit approval at launch; no release is authorized here.

## Review Focus

1. Explicit hidden patterns and a cwd whose own name starts with a dot: hide result-relative dot segments, while still listing visible files inside `.nax/scratchpad` (Tasks 1–2).
2. Directory symlinks encountered through wildcards: do not follow them; an explicitly named directory symlink prefix remains traversable, as Bun currently permits (Task 1).
3. Empty results versus filesystem failures: nonexistent/non-directory cwd must throw; approval read EACCES/EIO must propagate rather than become a missing or malformed store (Tasks 1, 3).
4. A runtime installed after tool modules load: both glob methods must resolve the slot at call time, and resets must restore the Node default (Task 2).
5. UTF-8 byte lengths and hash identity: size probes and spill seams preserve byte counts; native override digests preserve exact bytes, and spin deduplication preserves normalization and long-input distinctions (Tasks 3–4).

## Evidence and scope

Planning base: main `0585ce1b1` (S2–3d merged). S2–4 already supplies `AgentSpawnOptions`, `AgentSpawnResult`, `AgentRuntime.spawn`, `nodeRuntime`, `runtimeSpawn`, `which`, and nax's startup installation. Use these actual names rather than the spec's older `SpawnOptions` spelling. `internal/bun-deps.ts` already moved to nax; no sleep/which Bun replacement remains in agent source.

Remaining executable Bun sites: `_globDeps.scan`, ScratchpadList, approval-file reading, two file-size probes, `_gitGuardDeps.readText`, `_spillDeps.writeFile`, two spin-breaker hashes, native override hashing. Comment-only Bun mentions also require cleanup where the strengthened gate flags them.

Scratch probes on Bun 1.4.2 and Node 22.22.2 found: Bun omits file symlinks and wildcard directory-symlink descendants; `linked-dir/**/*` traverses a named symlink prefix; `[` and `{` yield no matches; Bun throws for bad cwd while native Node glob returns an empty list. Pin these behaviours in cases, including async/sync agreement. CI uses Bun 1.4.0, so its leg is the final compatibility check.

[Node 22.19.0's versioned filesystem documentation](https://nodejs.org/download/release/v22.19.0/docs/api/fs.html#fspromisesglobpattern-options) records glob as stable since 22.17.0. The local Node is 22.22.2; Task 6 supplies executable proof at exactly 22.19.0, rather than treating this local probe as floor verification.

## File Map

| Files | Responsibility |
|---|---|
| `packages/nax-agent/src/runtime/{types,index,node-runtime}.ts` | Extend/export runtime glob contract and attach Node methods |
| `packages/nax-agent/src/runtime/node-glob.ts` (new) | Normalize Node fs glob paths, files, hidden entries, symlinks, cwd errors |
| `packages/test-kit/src/cases/{runtime-types,glob-cases}.ts` (second new) | Independent structural glob contract and runner-neutral assertions |
| `packages/nax/src/agent-runtime/bun-runtime.ts` | Bun glob adapter with D21 result filtering |
| `packages/nax-agent/src/tools/{glob,scratchpad,read-file,spill}.ts` | Call-time runtime delegation and Node I/O swaps |
| `packages/nax-agent/src/internal/file-size.ts` (new) | Synchronous stat-size helper mapping only ENOENT to zero |
| `packages/nax-agent/src/{permissions/approvals-store,sandbox/git-guards}.ts` | UTF-8 reads preserving failure behaviour |
| `packages/nax-agent/src/infra/spin-breaker/{index,hash}.ts` (second new), `src/native/client.ts` | 64-bit in-memory keys and unchanged SHA-256 override digests |
| `packages/repo-tooling/scripts/check-no-bun-apis.ts`, agent package manifest | Enforce all specified Bun API forms over agent src |
| `packages/nax/scripts/check-package-boundaries.ts` | Deny Bun imports in agent production code; allow retained Bun tests |
| `packages/nax-agent/test/node/glob-floor.mjs` (new), `.github/workflows/ci.yml` | Native Node floor proof, without prematurely introducing the S2–8 suite |

Tests are named in their owning tasks below. Keep each new source file below existing size/complexity gates. Do not export file-size or hash helpers through package barrels.

---

### Task 1: Implement and prove glob on both runtimes

**Files:**
- Create: `packages/nax-agent/src/runtime/node-glob.ts`
- Create: `packages/test-kit/src/cases/glob-cases.ts`
- Modify: `packages/nax-agent/src/runtime/types.ts`, `index.ts`, `node-runtime.ts`
- Modify: `packages/test-kit/src/cases/runtime-types.ts`
- Modify: `packages/nax/src/agent-runtime/bun-runtime.ts`
- Modify: `packages/nax-agent/src/index.ts` (named runtime type export only)
- Test/Create: `packages/nax-agent/test/unit/runtime/node-glob.test.ts`
- Test/Create: `packages/nax/test/unit/agent-runtime/glob-runtime.test.ts`
- Modify test fakes: `packages/nax-agent/test/unit/runtime/slot.test.ts`, `seam-delegation.test.ts`

**Interfaces:**
- Consumes: existing `AgentRuntime.spawn`, `nodeRuntime`, `bunAgentRuntime`, `setAgentRuntime(AgentRuntime | null)`.
- Produces: `AgentGlobOptions { cwd: string; absolute: boolean }`; required `AgentRuntime.glob(pattern: string, opts: AgentGlobOptions): AsyncIterable<string>` and `globSync(pattern: string, opts: AgentGlobOptions): Iterable<string>`.
- Produces: `nodeGlob(pattern: string, opts: AgentGlobOptions): AsyncIterable<string>` and `nodeGlobSync(pattern: string, opts: AgentGlobOptions): Iterable<string>` in `node-glob.ts`.
- Produces: leaf-package `CaseGlobRuntime`, with the two glob signatures and structurally identical options; `GLOB_CASES: readonly { name: string; run(runtime: CaseGlobRuntime): Promise<void> }[]`. Keep existing `CaseRuntime` spawn-only so spawn cases have no unnecessary coupling.

- [x] **Step 1: Write runner-neutral cases and Bun/Node test wrappers.** Use node:assert/strict and node:fs temporary directories, cleaned in finally. Each case exercises both methods and compares sorted sets; sorting belongs to tests/callers, not adapters. Representative assertions:

```ts
// Fixture: a.ts, b.js, dir/c.ts, .secret, .hidden/h.ts,
// link.ts -> a.ts, linked-dir -> dir, broken -> absent.
assert.deepEqual(await hits(rt, "**/*", root), ["a.ts", "b.js", "dir/c.ts"]);
assert.deepEqual(await hits(rt, "{a,b}.{ts,js}", root), ["a.ts", "b.js"]);
assert.deepEqual(await hits(rt, "[ab].*", root), ["a.ts", "b.js"]);
assert.deepEqual(await hits(rt, "linked-dir/**/*", root), ["linked-dir/c.ts"]);
assert.deepEqual(await hits(rt, ".secret", root), []);
assert.deepEqual(await hits(rt, "**/.*", root), []);
assert.deepEqual(await hits(rt, ".hidden/**/*", root), []);
assert.deepEqual(await hits(rt, "[", root), []);
assert.deepEqual(await hits(rt, "{", root), []);
assert.deepEqual(await hits(rt, "not-present", root), []);
```

Define local `hits(rt: CaseGlobRuntime, pattern: string, cwd: string): Promise<string[]>`: collect/sort async results, collect/sort sync results, assert equality, return async results. Add absolute-mode assertions equal to `relativeHits.map(p => resolve(root, p)).sort()`. A fixture named `.scratch-root` with `visible.txt` must return `["visible.txt"]`: exclude relative dot segments, never the cwd's own ancestors. Test missing cwd with error `code === "ENOENT"` in both methods; a regular-file cwd with `"ENOTDIR"`. Add duplicate brace alternatives and nested directory symlink coverage, asserting no duplicate or wildcard-followed results.

Wrap `GLOB_CASES` in bun:test under each package, supplying `nodeRuntime` or `bunAgentRuntime`. Runtime fakes gain empty async/sync glob methods (or spread `nodeRuntime` and override spawn). Do not make the production glob methods optional to avoid updating tests.

- [x] **Step 2: Run the two wrappers to prove the missing glob methods fail.**

From agent: `rtk proxy bun test ./test/unit/runtime/node-glob.test.ts --timeout=60000`; from nax: `rtk proxy bun test ./test/unit/agent-runtime/glob-runtime.test.ts --timeout=60000`. Expected: failure because glob methods are absent; hidden-pattern tests also expose today's Bun behaviour.

- [x] **Step 3: Implement the contract and adapters.** Add methods/types above. `node-glob.ts` uses only node: runtime imports plus erased type imports, so Node can import it directly in Task 6. Use fs.promises.glob/fs.globSync with withFileTypes; assemble each path from `Dirent.parentPath` and `name`, then relativize against the resolved cwd. Check cwd with statSync before scanning. Include only actual regular-file Dirents, excluding symlink entries. Prune directory symlinks beyond the pattern's literal directory prefix through the glob exclusion callback; permit symlink directories explicitly named before the first glob metacharacter. Filter every result-relative segment beginning `.`. Deduplicate yielded paths; emit absolute paths only when requested. Preserve malformed-pattern empty results proven above; do not catch all errors and return an empty set.

The Bun methods use `new Bun.Glob(pattern).scan` / `scanSync` with `onlyFiles: true`, `dot: false`, `followSymlinks: false`, then filter hidden result-relative segments explicitly (dot:false alone does not enforce D21). Resolve cwd once for absolute-to-relative filtering. Do not filter based on the absolute path's dot ancestors.

Export `AgentGlobOptions` through runtime/index and the existing named runtime block in `src/index.ts`. Attach `nodeGlob`/`nodeGlobSync` to `nodeRuntime`. Keep `node-runtime.ts` focused on spawn; do not move or rewrite spawn.

- [x] **Step 4: Run both wrappers and affected runtime checks.** In agent: `rtk proxy bun test ./test/unit/runtime/ --timeout=60000`, `rtk bun run typecheck`; in nax: `rtk proxy bun test ./test/unit/agent-runtime/ --timeout=60000`, `rtk bun run typecheck`; in test-kit: `rtk bun run typecheck`, `rtk bun run check:all`. Expected: all pass, including existing spawn cases.

- [x] **Step 5: Commit only Task 1 files.** `rtk git add <the exact files above>`; `rtk git commit -m "feat: add glob to the agent runtime contract"`.

### Task 2: Route Glob and ScratchpadList through the live runtime

**Files:**
- Modify: `packages/nax-agent/src/tools/glob.ts`, `scratchpad.ts`
- Test/Modify: `packages/nax-agent/test/unit/runtime/seam-delegation.test.ts`
- Test/Modify: `packages/nax-agent/test/unit/tools/glob.test.ts`, `scratchpad.test.ts`

**Interfaces:** Consumes Task 1's two runtime methods through `getAgentRuntime(): AgentRuntime`. Produces unchanged `_globDeps.scan(pattern, { cwd, absolute }): AsyncIterable<string>`, `globTool.run` and `scratchpadListTool.run` outputs.

- [ ] **Step 1: Add failing tests for call-time delegation.** Load tool modules before installing a recording runtime; override `glob` to return `["b.ts", "a.ts"]` and `globSync` to return `["b.txt", "a.txt"]`. Create the scratchpad directory so its existing missing-directory guard permits scanning. Run existing tools using their current context fixtures, then assert:

```ts
expect(globResult.content).toBe("./ a.ts b.ts");
expect(globCalls).toEqual([{ pattern: "*.ts", opts: { cwd: root, absolute: false } }]);
expect(listResult.content).toBe("a.txt\nb.txt");
expect(syncCalls).toEqual([{ pattern: "**/*", opts: { cwd: join(root, SCRATCHPAD_DIR), absolute: false } }]);
```

Define recording runtime locally by spreading nodeRuntime and replacing these methods; restore the prior runtime in finally/afterEach. Add filesystem tool tests: explicitly named hidden file yields `no matches for ".secret"`; scratchpad containing hidden files/directories lists only visible notes; missing scratchpad still returns `(no entries)`; retain 500-match limits, grouped escaping, and confinement tests.

- [ ] **Step 2: Run `rtk proxy bun test ./test/unit/runtime/seam-delegation.test.ts ./test/unit/tools/glob.test.ts ./test/unit/tools/scratchpad.test.ts --timeout=60000` in agent.** Expected: delegation assertions fail on direct Bun scans.

- [ ] **Step 3: Delegate per invocation.** `_globDeps.scan` calls `getAgentRuntime().glob(pattern, opts)`; ScratchpadList calls `getAgentRuntime().globSync("**/*", { cwd: scratchpad, absolute: false })`. Keep `_globDeps` object identity and override shape. Keep sorting, capping, policy checks, missing-directory handling and formatting at their existing sites. Rewrite comments describing the old direct Bun implementation.

- [ ] **Step 4: Repeat Step 2 and run agent typecheck.** Expected: passing tool outputs and delegation tests.

- [ ] **Step 5: Commit Task 2 files.** Message: `refactor: delegate agent glob tools through the runtime slot`.

### Task 3: Replace Bun filesystem calls while preserving failures and bytes

**Files:**
- Create: `packages/nax-agent/src/internal/file-size.ts`
- Modify: `packages/nax-agent/src/tools/read-file.ts`, `scratchpad.ts`, `spill.ts`
- Modify: `packages/nax-agent/src/permissions/approvals-store.ts`, `sandbox/git-guards.ts`
- Test/Create: `packages/nax-agent/test/unit/internal/file-size.test.ts`
- Test/Modify: `packages/nax-agent/test/unit/permissions/approvals-store.test.ts`, `tools/read-file.test.ts`, `tools/scratchpad-read-paging.test.ts`, `tools/spill-recovery.test.ts`, `sandbox/git-guards.test.ts`

**Interfaces:** Produces `fileSizeOrZero(path: string): number` in file-size.ts; only ENOENT maps to zero. Retains `readFileSlice(target: string, opts?: ReadFileSliceOptions): Promise<ReadFileSliceResult>`, `readApprovalsFileDetailed(path: string): Promise<ApprovalsFileRead>`, `_gitGuardDeps.readText(p: string): Promise<string>`, `_spillDeps.writeFile(path: string, data: string): Promise<number>`.

- [ ] **Step 1: Add byte/error tests.** In new file-size tests assert `fileSizeOrZero` returns 6 for UTF-8 `héllo`, 0 for missing path, and throws ENOTDIR for `regularFile/child`. In read-file tests pin missing-file rejection to ENOENT (the zero size probe must not mask the subsequent open error), empty content/zero lines, and existing UTF-8 ceiling behaviour. Scratchpad tests assert `resultBytesPreTruncation === 6` for `héllo` with existing header expectations. For approvals assert missing state, parse failure state, preserved taint/entries, and directory-path read rejection. Add EACCES with a chmod(000) fixture and finally restoration; skip that one test only if running as root. A read failure must not become `missing` or `unparseable`. In git-guards tests call the real readText seam on UTF-8 text and on a missing file. For spill call the real writeFile seam, assert returned byte count 6 and stored bytes equal `héllo`; a missing parent must reject ENOENT rather than creating it.

```ts
expect(await _spillDeps.writeFile(target, "héllo")).toBe(6);
expect(await readFile(target, "utf8")).toBe("héllo");
expect(await readApprovalsFileDetailed(missing)).toEqual({
  state: "missing", file: { entries: [], taint: undefined }, droppedMalformed: 0,
});
```

- [ ] **Step 2: Run the six test files explicitly in agent.** Expected: new file-size helper import fails; tests documenting old semantics may already pass. Do not force unchanged-behaviour tests to fail artificially.

- [ ] **Step 3: Implement Node I/O swaps.** `fileSizeOrZero` wraps statSync(path).size and catches only errors with code ENOENT; use it for both size probes. Approval reading uses readFile(path, "utf8"), catches only ENOENT before JSON parsing, and propagates other errors. `_gitGuardDeps.readText` uses readFile(p, "utf8"). `_spillDeps.writeFile` awaits writeFile(path, data, "utf8") then returns Buffer.byteLength(data), preserving Promise<number> for existing consumers/stubs. Parent creation stays in the existing spill caller. No Bun-backed sleep/which remains to move; retain S2–4's `runtime/which.ts` and existing Node timers.

- [ ] **Step 4: Repeat the six explicit test paths and run `rtk bun run typecheck` in agent.** Expected: passing UTF-8, missing/error and existing paging/spill/guard tests.

- [ ] **Step 5: Commit Task 3 files.** Message: `refactor: use Node filesystem APIs in nax-agent`.

### Task 4: Replace hash implementations without changing deduplication rules

**Files:**
- Create: `packages/nax-agent/src/infra/spin-breaker/hash.ts`
- Modify: `packages/nax-agent/src/infra/spin-breaker/index.ts`, `native/client.ts`
- Test/Create: `packages/nax-agent/test/unit/infra/spin-breaker-hash.test.ts`
- Test/Modify: `packages/nax-agent/test/unit/native/client.test.ts`

**Interfaces:** Produces `digest64(text: string): string`, SHA-256's first 16 hexadecimal characters. Retains `createSpinBreaker(settings: ResolvedSpinBreakerSettings, deps?: { readonly now?: () => number }): SpinBreaker` and private `summariseOverrides` shape `{ providers: string[]; headerKeys: string[]; digest: string }` (12 hexadecimal characters).

- [ ] **Step 1: Add digest and behaviour assertions.** Golden vectors:

```ts
expect(digest64("")).toBe("e3b0c44298fc1c14");
expect(digest64("abc")).toBe("ba7816bf8f01cfea");
expect(digest64("héllo")).toBe(createHash("sha256").update("héllo").digest("hex").slice(0, 16));
```

Use createSpinBreaker with a fixed clock and existing default settings to assert: equal long inputs (>512 characters) repeat; long inputs differing only after character 512 are new calls; tool names distinguish identical bodies; result whitespace/control/duration normalization still merges equivalent results; materially different normalized results reset the result-repeat run. Copy the existing session-lifetime-spin result-repeat fixtures without adding new public seams for private resultDigest/callKey. For long-key discrimination, use these assertions:

```ts
const breaker = createSpinBreaker(DEFAULT_SPIN_BREAKER_SETTINGS, { now: () => 0 });
const long = "x".repeat(600);
breaker.observe("Read", { path: long });
breaker.observe("Read", { path: long });
expect(breaker.summary().newKeyEvents).toBe(1);
breaker.observe("Read", { path: `${long}y` });
expect(breaker.summary().newKeyEvents).toBe(2);
breaker.observe("Grep", { path: long });
expect(breaker.summary().newKeyEvents).toBe(3);
```

Strengthen native/client.test.ts's existing “a header VALUE change still trips the guard” test, using its existing `overrideWithHeaders` fixtures, with `expect(builtFor.digest).toBe("c2995e7e854d")` and `expect(requested.digest).toBe("b15f20421d0d")`. Planning verified both values against Bun.CryptoHasher and Node createHash on the canonicalized fixture. Preserve secret-redaction assertions and header-key-order equivalence.

- [ ] **Step 2: Run `rtk proxy bun test ./test/unit/infra/spin-breaker-hash.test.ts ./test/unit/native/client.test.ts --timeout=60000` in agent.** Expected: missing digest64 import fails; native compatibility golden assertions already pass before the swap.

- [ ] **Step 3: Implement digest64 and switch its two spin-breaker callers.** Keep result normalization, stableStringify, MAX_KEY_BYTES=512 and key separator unchanged. In native/client.ts replace the hasher with `createHash("sha256").update(canonicalOverrideKey(overrides)).digest("hex").slice(0, DIGEST_LENGTH)`; DIGEST_LENGTH remains 12. These two hash widths have different purposes; do not use digest64 for the native summary.

- [ ] **Step 4: Repeat Step 2 plus `rtk proxy bun test ./test/unit/native/session/session-lifetime-spin.test.ts --timeout=60000`.** Expected: native digest goldens unchanged; repeat detection and stop/nudge semantics preserved.

- [ ] **Step 5: Commit Task 4 files.** Message: `refactor: replace agent Bun hashing with Node crypto`.

### Task 5: Enforce zero Bun APIs in production source

**Files:**
- Modify: `packages/repo-tooling/scripts/check-no-bun-apis.ts`
- Test/Modify: `packages/repo-tooling/test/unit/scripts/check-no-bun-apis.test.ts`
- Modify: `packages/nax-agent/package.json`
- Modify: `packages/nax/scripts/check-package-boundaries.ts`
- Test/Modify: `packages/nax/test/unit/scripts/check-package-boundaries.test.ts`
- Modify comment-only sites if flagged: `packages/nax-agent/src/{runtime/types,runtime/node-runtime,command-safety/shadow,tools/tool-audit,internal/argv-exec,internal/git-exec,tools/run-command-exec,native/session/loop-events/external-handler}.ts`

**Interfaces:** Retains `findBunApiUses(srcDir: string, packageRoot: string): Promise<BunApiViolation[]>` and `findBoundaryViolations(repoRoot: string): BoundaryViolation[]`. Adds agent `check:no-bun-apis = "bun ../repo-tooling/scripts/check-no-bun-apis.ts --package=."`, called by lint:checks/check:all.

- [ ] **Step 1: Extend gate fixture assertions.** Require violations for `globalThis.Bun`, `globalThis.Bun.file(...)`, `typeof Bun`, `import.meta.dir`, direct Bun member access, bun: static/dynamic imports, and bare `bun` imports. Keep comment lines, myBun identifiers and node: imports accepted. Assert relative filename/line accuracy. In boundary fixtures reject `src/x.ts` imports from `bun` and `bun:test` for nax-agent, while `test/x.test.ts` importing bun:test remains accepted. nax's Bun runtime must remain accepted.

- [ ] **Step 2: Run repo-tooling `rtk proxy bun test ./test/unit/scripts/check-no-bun-apis.test.ts --timeout=60000` and nax `rtk proxy bun test ./test/unit/scripts/check-package-boundaries.test.ts --timeout=60000`.** Expected: new forbidden forms are missed/accepted by the current gates.

- [ ] **Step 3: Strengthen and wire gates.** Expand the source detector to the forms above without introducing exceptions. Retain its existing comment-line model; reword single-line source docblocks that mention Bun member syntax instead of allowlisting them. In agentViolation reject Bun builtins outside test/ before the generic isBuiltin allowance; retaining bun:test tests is R1, not a shipped-source exception. Update the boundary module's documentation accordingly. Add/call check:no-bun-apis in agent's manifest; leave dependencies and version unchanged.

- [ ] **Step 4: Repeat gate tests; run agent `rtk bun run check:no-bun-apis` and `rtk bun run check:all`; nax `rtk bun run check:package-boundaries`; nax-ai `rtk bun run check:no-bun-apis`.** Expected: clean source detector and all boundaries hold. A source gate failure identifies a site to replace/reword, never a new baseline entry.

- [ ] **Step 5: Commit Task 5 files.** Message: `chore: enforce Bun-free nax-agent source`.

### Task 6: Prove the Node floor and finish the slice

**Files:**
- Create: `packages/nax-agent/test/node/glob-floor.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: this plan's checkboxes as work completes
- Update: master-plan §5 with plan link, PR and eventual merge commit (external workspace document)

**Interfaces:** Consumes Task 1's self-contained nodeGlob/nodeGlobSync module and runner-neutral GLOB_CASES. Produces a real-Node smoke executable: `node test/node/glob-floor.mjs 22.19.0`; successful output `glob floor ok: 22.19.0` after all cases and warning checks pass.

- [ ] **Step 1: Add the floor runner.** Import `../../src/runtime/node-glob.ts` and `../../../test-kit/src/cases/glob-cases.ts` via direct paths in this test-only MJS runner. Node's type stripping must encounter only erasable TypeScript; both modules' local type imports are erased. Check `process.versions.bun === undefined`, optional argv version equals `process.versions.node`, and native fs.globSync/promises.glob exist. Listen for ExperimentalWarning mentioning glob and fail if one occurs. Run all GLOB_CASES against `{ glob: nodeGlob, globSync: nodeGlobSync }`, allowing pending warnings to dispatch before the final assertion. No aliases, build output, test preload, network or provider access is involved.

- [ ] **Step 2: Execute with local Node.** From agent: `rtk proxy node test/node/glob-floor.mjs`. Expected: all cases pass and output names the actual local version (22.22.2 in planning). Then `rtk proxy node test/node/glob-floor.mjs 0.0.0` must fail the version assertion; this proves the floor check cannot silently run whichever Node is installed.

- [ ] **Step 3: Wire a focused CI job `nax-agent-glob-floor`.** Matrix OS `[ubuntu-latest, macos-latest]`; setup-node exactly `22.19.0`; use existing checkout/setup action conventions. Run `node --version` then `node packages/nax-agent/test/node/glob-floor.mjs 22.19.0`. This runner requires no workspace install because it imports only built-ins and type-stripped local files. Existing Bun jobs already exercise actual runtime/tool integration and source coverage; the later S2–8 matrix will add full Node contracts and tarball smokes. Require both floor legs to pass with no glob experimental warning. The documentation says the floor is sufficient; if CI disagrees, report the specific failure and obtain a master-plan ruling before raising the floor or adding a dependency.

- [ ] **Step 4: Run final repository gates.** From root: `rtk bun run typecheck`, `rtk bun run check:all`, `rtk bun run test`, `rtk bun run build`. From agent and nax respectively: `rtk bun run test:coverage`. Confirm agent coverage baseline remains `{}` and every new source file meets 80% lines/functions. Add missing behavioural tests if coverage identifies a gap; do not lower thresholds. Confirm nax runtime installation remains first in bin/preload and nax-agent remains bundled. Compare `packages/nax/package.json` dependencies against the execution base; byte-identical is required. Record actual results, including sandbox skips, separately from claimed floor verification.

- [ ] **Step 5: Commit and hand off the completed implementation for review.** Message: `ci: verify agent glob at the Node floor`. Follow the selected execution skill's review/branch workflow; creating a release or launching billed smokes is outside this slice. Record S2–5's plan/PR/merge in master-plan §5 only. S2–6 can then add the ESM codemod and Node build.

## Self-review and requirement map

| Requirement | Owner |
|---|---|
| §4.1 read/size/write replacements, errors and byte counts | Task 3 |
| §4.1 spin-breaker SHA-256 first 16 hex; unchanged native SHA-256 | Task 4 |
| §4.1 sleep/which | Already landed in S2–4; verify no residual Bun sites in Task 5 |
| §4.2 glob runtime, Node default and Bun host implementation | Task 1 |
| §4.3 shared glob cases under both Bun suites | Task 1 |
| §4.2 install/call-time selection | Existing install retained; delegation pinned in Task 2 |
| §4.5 strengthened no-Bun gate and import boundary | Task 5 |
| §9 Node 22.19.0 glob confirmation | Task 6, real Node on Linux/macOS |
| D21 unconditional hidden-path exclusion | Tasks 1–2 |
| S2–3 empty coverage baseline preserved | Task 6 |
| Full Node built-in contracts / packed tarball / build types | S2–6 and S2–8, explicitly outside this slice |

Self-review checks: all S2–5 requirements have owners; new method/type names agree across adapters/cases; all five Review Focus conditions have explicit assertions; new helpers stay private; no speculative session/API redesign or package release is included.
