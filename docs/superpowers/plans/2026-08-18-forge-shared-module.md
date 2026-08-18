# Shared Forge Module (`src/forge/`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract one shared `src/forge/` module for GitHub/GitLab detection, PR/MR lookup, PR/MR creation and repo-template discovery, and move the auto-PR plugin onto it — fixing a live auto-PR defect on self-hosted forges in the process.

**Architecture:** `src/forge/` is a dependency-injected, I/O-free-by-default module: every subprocess and filesystem call goes through an injected `ForgeDeps`. It is seeded from `flows/nax-finish/steps/forge.ts`, whose implementations are strictly better than the auto-PR plugin's, then the auto-PR plugin's own `forge.ts` and `template.ts` are deleted and it imports `@/forge` instead.

**Tech Stack:** TypeScript, Bun (test runner and toolchain), Biome (format/lint), `gh` / `glab` CLIs at runtime.

**Spec:** `docs/superpowers/specs/2026-08-18-native-nax-finish-design.md` — this plan implements **cutover step 1** of section 6. Read section 2.7 (the duplication table) and the revised step 1 (the self-hosted defect) before starting.

## Global Constraints

- Runtime is **Bun**. `src/` is Bun-native; use `Bun.*` freely. (The `flows/` directory is the sole exception and this plan does not touch it.)
- **`flows/` must never import from `src/`** — it is loaded by a separate `acpx` process where `src/` and the `@/*` alias do not exist. This plan therefore does **not** deduplicate the `flows/nax-finish/steps/forge.ts` and `flows/nax-finish/pr-template.ts` copies. They are deleted in a later plan when `flows/` goes. Duplication persisting after this plan is expected, not a defect.
- **File size caps:** 600 lines for `src/`, 800 for `test/`. Enforced by `scripts/check-file-sizes.ts`.
- **No emojis** in code, comments, or documentation.
- **Imports:** use the `@/` alias (`@/*` -> `./src/*`). `scripts/check-alias-internals.ts` forbids alias imports that reach into a module's internals, so `@/forge` must resolve through `src/forge/index.ts`. `scripts/check-deep-relatives.ts` has a frozen baseline of 2845 — **new tests must import `@/forge`, never `../../../../src/forge/...`**.
- **Errors:** use `NaxError` from `src/errors.ts`. `scripts/check-nax-error.ts` has a baseline of 105 violations; do not add any.
- **Commits:** conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`). Attribution is disabled globally; do not add co-author trailers.
- **Branch:** create `feat/forge-shared-module` from `main` before Task 1.
- **Gates before every commit:** `bun x tsc --noEmit`, `bun run lint`, and the task's own tests. A pre-commit hook runs the full static-check suite automatically and will reject the commit if anything fails.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/forge/types.ts` | `ForgeKind`, `ForgeRunResult`, `ForgeDeps`. Pure types, no behaviour. |
| `src/forge/detect.ts` | `remoteHost`, `forgeFromRemoteUrl` (sync, pure), `detectForge` (async, adds a `gh`/`glab` probe). |
| `src/forge/pr.ts` | `extractUrl`, `viewArgv`, `hasOpenPr`, `openPr`. |
| `src/forge/template.ts` | `findPrTemplate` — locate the repo's PR/MR template verbatim. |
| `src/forge/index.ts` | Public barrel. The only entry point `@/forge` consumers may use. |
| `test/unit/forge/detect.test.ts` | Detection, including the self-hosted regression. |
| `test/unit/forge/pr.test.ts` | `hasOpenPr`, `openPr`, `extractUrl`, `viewArgv`. |
| `test/unit/forge/template.test.ts` | Template discovery. |

**Modified:**

| File | Change |
| --- | --- |
| `src/plugins/builtin/auto-pr/types.ts` | Drop `ForgeKind`; re-export it from `@/forge`. `AutoPrDeps` becomes an alias of `ForgeDeps`. `AutoPrConfig` stays. |
| `src/plugins/builtin/auto-pr/index.ts` | Import `forgeFromRemoteUrl`, `hasOpenPr`, `openPr`, `findPrTemplate` from `@/forge`. |
| `test/unit/plugins/builtin/auto-pr-forge.test.ts` | Reduced to the plugin's wiring; the unit coverage of detect/pr moves to `test/unit/forge/`. |
| `test/unit/plugins/builtin/auto-pr-template.test.ts` | Retargeted at `@/forge`. |

**Deleted:**

| File | Reason |
| --- | --- |
| `src/plugins/builtin/auto-pr/forge.ts` | Superseded by `src/forge/detect.ts` + `src/forge/pr.ts`. |
| `src/plugins/builtin/auto-pr/template.ts` | Superseded by `src/forge/template.ts`. |

---

### Task 1: Forge detection

The auto-PR plugin currently classifies a remote with `remoteUrl.includes("github.com")`
(`src/plugins/builtin/auto-pr/forge.ts:24`). That is false for `gitlab.mycorp.com`, so
`detectForge` returns `null`, `shouldRun` returns `false` at `index.ts:176-177`, and
**auto-PR silently does nothing on every self-hosted GitHub or GitLab**. The finish flow
already fixed this by matching on the parsed *host*; this task brings that fix into `src/`.

**Files:**
- Create: `src/forge/types.ts`
- Create: `src/forge/detect.ts`
- Test: `test/unit/forge/detect.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `type ForgeKind = "github" | "gitlab"`
  - `interface ForgeRunResult { exitCode: number; stdout: string; stderr: string }`
  - `interface ForgeDeps { run(cmd: string[], opts: { cwd: string; timeoutMs?: number }): Promise<ForgeRunResult>; readText(path: string): Promise<string | null> }`
  - `function remoteHost(remoteUrl: string): string`
  - `function forgeFromRemoteUrl(remoteUrl: string): ForgeKind | null`
  - `function detectForge(deps: ForgeDeps, repoRoot: string): Promise<ForgeKind | null>`

- [ ] **Step 1: Create the branch**

```bash
git checkout main
git pull --ff-only
git checkout -b feat/forge-shared-module
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/forge/detect.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { type ForgeDeps, detectForge, forgeFromRemoteUrl, remoteHost } from "@/forge";

function deps(handler: (cmd: string[]) => { exitCode: number; stdout: string; stderr: string }): ForgeDeps {
  return {
    run: async (cmd) => handler(cmd),
    readText: async () => null,
  };
}

const OK = { exitCode: 0, stdout: "", stderr: "" };
const MISSING = { exitCode: 127, stdout: "", stderr: "command not found" };

describe("remoteHost", () => {
  test("reads the host from an scp-style remote", () => {
    expect(remoteHost("git@github.com:owner/repo.git")).toBe("github.com");
  });

  test("reads the host from a URL-style remote, ignoring userinfo and port", () => {
    expect(remoteHost("https://user@gitlab.example.com:8443/team/repo.git")).toBe("gitlab.example.com");
  });

  test("returns empty string for something that is not a remote URL", () => {
    expect(remoteHost("not a url")).toBe("");
  });
});

describe("forgeFromRemoteUrl", () => {
  test("classifies github.com and gitlab.com", () => {
    expect(forgeFromRemoteUrl("git@github.com:owner/repo.git")).toBe("github");
    expect(forgeFromRemoteUrl("https://gitlab.com/team/repo.git")).toBe("gitlab");
  });

  // The defect this module exists to fix. `"gitlab.mycorp.com".includes("gitlab.com")`
  // is false, so the auto-PR plugin's substring check returned null here and the
  // plugin skipped itself on every self-hosted forge.
  test("classifies a self-hosted GitLab host", () => {
    expect(forgeFromRemoteUrl("git@gitlab.mycorp.com:team/repo.git")).toBe("gitlab");
  });

  test("classifies a self-hosted GitHub Enterprise host", () => {
    expect(forgeFromRemoteUrl("https://github.mycorp.com/team/repo.git")).toBe("github");
  });

  test("returns null for a host naming neither forge", () => {
    expect(forgeFromRemoteUrl("git@git.corp.com:team/repo.git")).toBeNull();
  });
});

describe("detectForge", () => {
  test("classifies from the remote when the host names a forge", async () => {
    const d = deps((cmd) =>
      cmd[0] === "git" ? { exitCode: 0, stdout: "git@gitlab.mycorp.com:t/r.git\n", stderr: "" } : MISSING,
    );
    expect(await detectForge(d, "/repo")).toBe("gitlab");
  });

  test("falls back to the installed CLI when the host names neither forge", async () => {
    const d = deps((cmd) => {
      if (cmd[0] === "git") return { exitCode: 0, stdout: "git@git.corp.com:t/r.git\n", stderr: "" };
      if (cmd[0] === "glab") return OK;
      return MISSING;
    });
    expect(await detectForge(d, "/repo")).toBe("gitlab");
  });

  test("stays undecided when both CLIs are installed", async () => {
    const d = deps((cmd) =>
      cmd[0] === "git" ? { exitCode: 0, stdout: "git@git.corp.com:t/r.git\n", stderr: "" } : OK,
    );
    expect(await detectForge(d, "/repo")).toBeNull();
  });

  test("stays undecided when neither CLI is installed", async () => {
    const d = deps((cmd) =>
      cmd[0] === "git" ? { exitCode: 0, stdout: "git@git.corp.com:t/r.git\n", stderr: "" } : MISSING,
    );
    expect(await detectForge(d, "/repo")).toBeNull();
  });

  test("returns null when the remote cannot be read at all", async () => {
    const d = deps(() => ({ exitCode: 128, stdout: "", stderr: "no such remote 'origin'" }));
    expect(await detectForge(d, "/repo")).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test test/unit/forge/detect.test.ts`
Expected: FAIL — `Cannot find module '@/forge'`.

- [ ] **Step 4: Write `src/forge/types.ts`**

```ts
/**
 * Shared forge (GitHub / GitLab) types.
 *
 * Pure types only. Every subprocess and filesystem call in this module goes
 * through an injected `ForgeDeps` so callers can supply fakes without touching
 * real disk or spawning a process.
 */

/** Forge identifier for the host repository. */
export type ForgeKind = "github" | "gitlab";

/** Captured result of a subprocess run. */
export interface ForgeRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injected I/O for every function in this module. */
export interface ForgeDeps {
  /** Run a subprocess and capture its exit code and output streams. */
  run(cmd: string[], opts: { cwd: string; timeoutMs?: number }): Promise<ForgeRunResult>;
  /** Read a UTF-8 file. Returns null when the file does not exist. */
  readText(path: string): Promise<string | null>;
}
```

- [ ] **Step 5: Write `src/forge/detect.ts`**

```ts
/**
 * Forge detection.
 *
 * Classification matches the parsed *host*, not a substring of the whole URL.
 * That distinction is the whole point: `"gitlab.mycorp.com".includes("gitlab.com")`
 * is false, so a whole-URL substring check rejects every self-hosted forge.
 */
import type { ForgeDeps, ForgeKind } from "./types";

/**
 * Host of a git remote, for both URL forms git accepts:
 * `git@host:path` (scp-like) and `scheme://[user@]host[:port]/path`.
 */
export function remoteHost(remoteUrl: string): string {
  const scp = remoteUrl.match(/^[^/]*@([^:/]+):/);
  if (scp?.[1]) return scp[1].toLowerCase();
  const url = remoteUrl.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/]+)/i);
  return url?.[1]?.toLowerCase() ?? "";
}

/**
 * Classify a remote by host name. GitHub is tested first purely for determinism
 * on an absurd host naming both.
 */
export function forgeFromRemoteUrl(remoteUrl: string): ForgeKind | null {
  const host = remoteHost(remoteUrl);
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  return null;
}

/**
 * Last resort for an enterprise host that names neither forge (`git.corp.com`):
 * ask which CLI is installed. Only decisive when exactly one is — with both or
 * neither present a guess would send `gh` at a GitLab remote.
 */
async function forgeFromCli(deps: ForgeDeps, repoRoot: string): Promise<ForgeKind | null> {
  const [gh, glab] = await Promise.all([
    deps.run(["gh", "--version"], { cwd: repoRoot }),
    deps.run(["glab", "--version"], { cwd: repoRoot }),
  ]);
  const hasGh = gh.exitCode === 0;
  const hasGlab = glab.exitCode === 0;
  if (hasGh && !hasGlab) return "github";
  if (hasGlab && !hasGh) return "gitlab";
  return null;
}

/**
 * Resolve the forge for a repository: read `origin`, classify by host, and fall
 * back to a CLI probe. Returns null rather than throwing — callers differ on
 * whether an undetermined forge is fatal, so the decision is theirs.
 */
export async function detectForge(deps: ForgeDeps, repoRoot: string): Promise<ForgeKind | null> {
  const remote = await deps.run(["git", "remote", "get-url", "origin"], { cwd: repoRoot });
  if (remote.exitCode !== 0) return null;
  return forgeFromRemoteUrl(remote.stdout.trim()) ?? (await forgeFromCli(deps, repoRoot));
}
```

- [ ] **Step 6: Write the barrel so `@/forge` resolves**

Create `src/forge/index.ts`:

```ts
/**
 * Shared forge module — the only public entry point.
 *
 * `scripts/check-alias-internals.ts` forbids alias imports that reach past this
 * barrel, so consumers import from `@/forge` and never `@/forge/detect`.
 */
export type { ForgeDeps, ForgeKind, ForgeRunResult } from "./types";
export { detectForge, forgeFromRemoteUrl, remoteHost } from "./detect";
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test test/unit/forge/detect.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 8: Run the gates**

```bash
bun x tsc --noEmit
bun run lint
```
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add src/forge/types.ts src/forge/detect.ts src/forge/index.ts test/unit/forge/detect.test.ts
git commit -m "feat(forge): add shared forge detection that works on self-hosted hosts"
```

---

### Task 2: PR/MR lookup and creation

**Files:**
- Create: `src/forge/pr.ts`
- Modify: `src/forge/index.ts`
- Test: `test/unit/forge/pr.test.ts`

**Interfaces:**
- Consumes: `ForgeDeps`, `ForgeKind` from Task 1.
- Produces:
  - `function extractUrl(stdout: string): string | undefined`
  - `function viewArgv(forge: ForgeKind, branch: string, githubFields: string): string[]`
  - `function hasOpenPr(forge: ForgeKind, branch: string, deps: ForgeDeps, cwd: string): Promise<boolean>` — **throws** on a non-zero forge-CLI exit
  - `interface OpenPrInput { title: string; body: string; branch: string; draft: boolean }`
  - `interface OpenPrResult { success: boolean; message: string; url?: string }`
  - `function openPr(forge: ForgeKind, input: OpenPrInput, deps: ForgeDeps, cwd: string): Promise<OpenPrResult>`

`OpenPrResult` is structurally assignable to `PostRunActionResult` (`src/plugins/extensions.ts:176` — `success: boolean; message: string; url?: string; skipped?: boolean`), so the auto-PR plugin can return it unchanged in Task 4.

- [ ] **Step 1: Write the failing test**

Create `test/unit/forge/pr.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { type ForgeDeps, extractUrl, hasOpenPr, openPr, viewArgv } from "@/forge";

function deps(
  handler: (cmd: string[]) => { exitCode: number; stdout: string; stderr: string },
  captured?: string[][],
): ForgeDeps {
  return {
    run: async (cmd) => {
      captured?.push(cmd);
      return handler(cmd);
    },
    readText: async () => null,
  };
}

describe("extractUrl", () => {
  test("prefers the JSON url field", () => {
    expect(extractUrl('{"url":"https://github.com/o/r/pull/1"}')).toBe("https://github.com/o/r/pull/1");
  });

  test("accepts GitLab's web_url field", () => {
    expect(extractUrl('{"web_url":"https://gitlab.com/t/r/-/merge_requests/2"}')).toBe(
      "https://gitlab.com/t/r/-/merge_requests/2",
    );
  });

  test("falls back to the first URL in plain output", () => {
    expect(extractUrl("Created:\nhttps://github.com/o/r/pull/3\n")).toBe("https://github.com/o/r/pull/3");
  });

  test("returns undefined when there is no URL", () => {
    expect(extractUrl("nothing here")).toBeUndefined();
  });
});

describe("viewArgv", () => {
  test("builds the gh and glab view commands", () => {
    expect(viewArgv("github", "feat/x", "number,state")).toEqual([
      "gh", "pr", "view", "feat/x", "--json", "number,state",
    ]);
    expect(viewArgv("gitlab", "feat/x", "number")).toEqual([
      "glab", "mr", "view", "feat/x", "--output", "json",
    ]);
  });
});

describe("hasOpenPr", () => {
  test("true when the forge reports an open PR", async () => {
    const d = deps(() => ({ exitCode: 0, stdout: '[{"number":7}]', stderr: "" }));
    expect(await hasOpenPr("github", "feat/x", d, "/repo")).toBe(true);
  });

  test("false when the forge reports none", async () => {
    const d = deps(() => ({ exitCode: 0, stdout: "[]", stderr: "" }));
    expect(await hasOpenPr("gitlab", "feat/x", d, "/repo")).toBe(false);
  });

  // BUG-8: a non-zero exit used to read as "no open PR", which let a concurrent
  // run open a duplicate. It must surface as an error so the caller can skip.
  test("throws when the forge CLI fails, rather than reporting no PR", async () => {
    const d = deps(() => ({ exitCode: 1, stdout: "", stderr: "gh: auth required" }));
    expect(hasOpenPr("github", "feat/x", d, "/repo")).rejects.toThrow("auth required");
  });

  test("false when the forge returns unparseable output", async () => {
    const d = deps(() => ({ exitCode: 0, stdout: "not json", stderr: "" }));
    expect(await hasOpenPr("github", "feat/x", d, "/repo")).toBe(false);
  });
});

describe("openPr", () => {
  test("passes --draft to gh when draft is requested and returns the URL", async () => {
    const captured: string[][] = [];
    const d = deps(() => ({ exitCode: 0, stdout: "https://github.com/o/r/pull/9\n", stderr: "" }), captured);
    const r = await openPr("github", { title: "T", body: "B", branch: "feat/x", draft: true }, d, "/repo");
    expect(r.success).toBe(true);
    expect(r.url).toBe("https://github.com/o/r/pull/9");
    expect(captured[0]).toEqual([
      "gh", "pr", "create", "--title", "T", "--body", "B", "--head", "feat/x", "--draft",
    ]);
  });

  test("omits --draft when a ready PR is requested", async () => {
    const captured: string[][] = [];
    const d = deps(() => ({ exitCode: 0, stdout: "https://gitlab.com/t/r/-/merge_requests/4", stderr: "" }), captured);
    await openPr("gitlab", { title: "T", body: "B", branch: "feat/x", draft: false }, d, "/repo");
    expect(captured[0]).toEqual([
      "glab", "mr", "create", "--title", "T", "--description", "B", "--source-branch", "feat/x",
    ]);
  });

  test("reports failure with the CLI's stderr", async () => {
    const d = deps(() => ({ exitCode: 1, stdout: "", stderr: "  a PR already exists  " }));
    const r = await openPr("github", { title: "T", body: "B", branch: "feat/x", draft: true }, d, "/repo");
    expect(r).toEqual({ success: false, message: "a PR already exists" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/forge/pr.test.ts`
Expected: FAIL — `extractUrl`, `hasOpenPr`, `openPr`, `viewArgv` are not exported from `@/forge`.

- [ ] **Step 3: Write `src/forge/pr.ts`**

```ts
/**
 * Reading and creating PRs/MRs through the `gh` and `glab` CLIs.
 */
import { NaxError } from "@/errors";
import type { ForgeDeps, ForgeKind } from "./types";

/** Matches the first http(s) URL — `gh`/`glab` print the URL on stdout. */
const URL_REGEX = /https?:\/\/\S+/;

/** Best-effort URL extraction: try `{url}`/`{web_url}` JSON first, then a raw regex. */
export function extractUrl(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { url?: string; web_url?: string };
    if (parsed.url) return parsed.url;
    if (parsed.web_url) return parsed.web_url;
  } catch {
    // fall through to regex extraction
  }
  return stdout.match(URL_REGEX)?.[0];
}

/** Argv for reading the branch's existing PR/MR as JSON. */
export function viewArgv(forge: ForgeKind, branch: string, githubFields: string): string[] {
  return forge === "github"
    ? ["gh", "pr", "view", branch, "--json", githubFields]
    : ["glab", "mr", "view", branch, "--output", "json"];
}

/**
 * Whether an open PR/MR exists for the branch.
 *
 * BUG-8: a non-zero exit must NOT read as "no open PR". A `gh` auth failure or a
 * transient API error both exit non-zero, and treating that as a green light let
 * two concurrent runs each open a PR. Throwing makes the caller decide, and the
 * safe decision is to skip.
 */
export async function hasOpenPr(
  forge: ForgeKind,
  branch: string,
  deps: ForgeDeps,
  cwd: string,
): Promise<boolean> {
  const cmd =
    forge === "github"
      ? ["gh", "pr", "list", "--head", branch, "--state", "open", "--json", "number"]
      : ["glab", "mr", "list", "--source-branch", branch, "--state", "opened", "--output", "json"];
  const result = await deps.run(cmd, { cwd });
  if (result.exitCode !== 0) {
    throw new NaxError(
      `hasOpenPr: forge CLI exited with code ${result.exitCode}: ${result.stderr.trim()}`,
      "FORGE_PR_LIST_FAILED",
      { forge, branch, exitCode: result.exitCode },
    );
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/** Inputs required to open a PR/MR. */
export interface OpenPrInput {
  title: string;
  body: string;
  branch: string;
  draft: boolean;
}

/**
 * Structurally assignable to `PostRunActionResult` so the auto-PR plugin can
 * return it unchanged, without this module depending on the plugin types.
 */
export interface OpenPrResult {
  success: boolean;
  message: string;
  url?: string;
}

/** Open a PR/MR, as a draft or ready for review. */
export async function openPr(
  forge: ForgeKind,
  input: OpenPrInput,
  deps: ForgeDeps,
  cwd: string,
): Promise<OpenPrResult> {
  const baseCmd =
    forge === "github"
      ? ["gh", "pr", "create", "--title", input.title, "--body", input.body]
      : ["glab", "mr", "create", "--title", input.title, "--description", input.body];
  const branchArg = forge === "github" ? ["--head", input.branch] : ["--source-branch", input.branch];
  const draftArg = input.draft ? ["--draft"] : [];

  const result = await deps.run([...baseCmd, ...branchArg, ...draftArg], { cwd });
  if (result.exitCode !== 0) {
    return {
      success: false,
      message: result.stderr.trim() || `forge CLI exited with code ${result.exitCode}`,
    };
  }
  const url = extractUrl(result.stdout);
  return {
    success: true,
    message: `Opened ${forge === "github" ? "PR" : "MR"} for ${input.branch}`,
    ...(url ? { url } : {}),
  };
}
```

- [ ] **Step 4: Extend the barrel**

Append to `src/forge/index.ts`:

```ts
export type { OpenPrInput, OpenPrResult } from "./pr";
export { extractUrl, hasOpenPr, openPr, viewArgv } from "./pr";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/unit/forge/pr.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Run the gates and commit**

```bash
bun x tsc --noEmit
bun run lint
git add src/forge/pr.ts src/forge/index.ts test/unit/forge/pr.test.ts
git commit -m "feat(forge): add shared PR/MR lookup and creation"
```

---

### Task 3: Repository template discovery

**Files:**
- Create: `src/forge/template.ts`
- Modify: `src/forge/index.ts`
- Test: `test/unit/forge/template.test.ts`

**Interfaces:**
- Consumes: `ForgeDeps`, `ForgeKind` from Task 1.
- Produces: `function findPrTemplate(workdir: string, forge: ForgeKind, deps: ForgeDeps): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/forge/template.test.ts`:

```ts
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { type ForgeDeps, findPrTemplate } from "@/forge";

function deps(files: Record<string, string>, read?: string[]): ForgeDeps {
  return {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readText: async (p: string) => {
      read?.push(p);
      return files[p] ?? null;
    },
  };
}

describe("findPrTemplate", () => {
  test("returns the GitHub template verbatim", async () => {
    const p = path.join("/repo", ".github/PULL_REQUEST_TEMPLATE.md");
    expect(await findPrTemplate("/repo", "github", deps({ [p]: "## Summary\n\n" }))).toBe("## Summary\n\n");
  });

  test("honours GitHub candidate priority order", async () => {
    const read: string[] = [];
    const lower = path.join("/repo", ".github/pull_request_template.md");
    await findPrTemplate("/repo", "github", deps({ [lower]: "x" }, read));
    expect(read[0]).toBe(path.join("/repo", ".github/PULL_REQUEST_TEMPLATE.md"));
    expect(read[1]).toBe(lower);
  });

  test("returns the GitLab default template", async () => {
    const p = path.join("/repo", ".gitlab/merge_request_templates/Default.md");
    expect(await findPrTemplate("/repo", "gitlab", deps({ [p]: "MR body" }))).toBe("MR body");
  });

  test("returns null when no template exists", async () => {
    expect(await findPrTemplate("/repo", "github", deps({}))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/forge/template.test.ts`
Expected: FAIL — `findPrTemplate` is not exported from `@/forge`.

- [ ] **Step 3: Write `src/forge/template.ts`**

```ts
/**
 * Repository PR/MR template discovery.
 *
 * Why preserve-not-fill: passing `--body` / `--description` to `gh` / `glab`
 * suppresses the repo's default template, so callers must read and re-embed it.
 */
import * as path from "node:path";
import type { ForgeDeps, ForgeKind } from "./types";

/**
 * Candidate template paths for GitHub, in priority order. Multi-template
 * directories (`PULL_REQUEST_TEMPLATE/`) are intentionally skipped because they
 * are ambiguous unattended.
 */
const GITHUB_TEMPLATE_PATHS: readonly string[] = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
] as const;

/** Preferred single-template location for GitLab. */
const GITLAB_DEFAULT_TEMPLATE_PATH = ".gitlab/merge_request_templates/Default.md";

async function firstExisting(workdir: string, deps: ForgeDeps, paths: readonly string[]): Promise<string | null> {
  for (const relPath of paths) {
    const content = await deps.readText(path.join(workdir, relPath));
    if (content !== null) return content;
  }
  return null;
}

/** Locate the PR/MR template for the repository, or null when none resolves. */
export async function findPrTemplate(
  workdir: string,
  forge: ForgeKind,
  deps: ForgeDeps,
): Promise<string | null> {
  if (forge === "github") return firstExisting(workdir, deps, GITHUB_TEMPLATE_PATHS);
  if (forge === "gitlab") return firstExisting(workdir, deps, [GITLAB_DEFAULT_TEMPLATE_PATH]);
  return null;
}
```

- [ ] **Step 4: Extend the barrel**

Append to `src/forge/index.ts`:

```ts
export { findPrTemplate } from "./template";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test test/unit/forge/template.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Run the gates and commit**

```bash
bun x tsc --noEmit
bun run lint
git add src/forge/template.ts src/forge/index.ts test/unit/forge/template.test.ts
git commit -m "feat(forge): add shared repository PR template discovery"
```

---

### Task 4: Move the auto-PR plugin onto `src/forge/`

This is where the self-hosted defect is actually fixed for users, and where the
duplicate modules are deleted. Write the plugin-level regression test **first**,
because it is the one that proves the user-visible behaviour changed.

**Files:**
- Modify: `src/plugins/builtin/auto-pr/types.ts`
- Modify: `src/plugins/builtin/auto-pr/index.ts`
- Delete: `src/plugins/builtin/auto-pr/forge.ts`
- Delete: `src/plugins/builtin/auto-pr/template.ts`
- Modify: `test/unit/plugins/builtin/auto-pr-forge.test.ts`
- Modify: `test/unit/plugins/builtin/auto-pr-template.test.ts`

**Interfaces:**
- Consumes: `forgeFromRemoteUrl`, `hasOpenPr`, `openPr`, `findPrTemplate`, `ForgeDeps`, `ForgeKind` from Tasks 1-3.
- Produces: nothing new. `_autoPrDeps` keeps its existing key names (`detectForge`, `hasOpenPr`, `openDraft`, `findPrTemplate`) so the stubs in `test/unit/plugins/builtin/auto-pr-acceptance.test.ts:69-87` keep working untouched. `detectForge` stays **synchronous and takes a remote URL**, which is what those stubs assume (`(() => "github")`).

- [ ] **Step 1: Write the failing plugin-level regression test**

Append to `test/unit/plugins/builtin/auto-pr-forge.test.ts`:

```ts
// `_autoPrDeps` is not exported from the `@/plugins` barrel — it is a test-only
// injection seam on the plugin module itself. Import it the way the sibling
// suite already does (`test/unit/plugins/builtin/auto-pr-acceptance.test.ts:27`).
import { _autoPrDeps } from "../../../../src/plugins/builtin/auto-pr";

// Before src/forge, the plugin classified with `remoteUrl.includes("github.com")`,
// so a self-hosted host produced null, shouldRun returned false, and auto-PR
// silently did nothing on every enterprise install.
describe("auto-PR forge classification (self-hosted regression)", () => {
  test("classifies a self-hosted GitLab remote", () => {
    expect(_autoPrDeps.detectForge("git@gitlab.mycorp.com:team/repo.git")).toBe("gitlab");
  });

  test("classifies a self-hosted GitHub Enterprise remote", () => {
    expect(_autoPrDeps.detectForge("https://github.mycorp.com/team/repo.git")).toBe("github");
  });

  test("still rejects a host naming neither forge", () => {
    expect(_autoPrDeps.detectForge("git@git.corp.com:team/repo.git")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/unit/plugins/builtin/auto-pr-forge.test.ts`
Expected: FAIL — the first two assertions receive `null`. This is the defect, reproduced.

- [ ] **Step 3: Rewrite `src/plugins/builtin/auto-pr/types.ts`**

```ts
/**
 * Auto-PR Plugin — Types
 *
 * Forge types and injected I/O now live in `@/forge`; this file keeps only the
 * plugin's own config surface and re-exports the shared names so existing
 * importers keep compiling.
 */
export type { ForgeDeps as AutoPrDeps, ForgeKind } from "@/forge";

/** Configuration surface for `autoPr` in `nax.config.json`. */
export interface AutoPrConfig {
  /** Whether auto-PR creation is enabled (default: false) */
  enabled: boolean;
  /** Whether to create the PR as a draft (default: true) */
  draft: boolean;
}
```

- [ ] **Step 4: Repoint `src/plugins/builtin/auto-pr/index.ts`**

Replace the import at line 18:

```ts
import { detectForge as _detectForge, hasOpenPr as _hasOpenPr, openDraft as _openDraft } from "./forge";
```

with:

```ts
import {
  findPrTemplate as _findPrTemplate,
  forgeFromRemoteUrl as _detectForge,
  hasOpenPr as _hasOpenPr,
  openPr as _openDraft,
} from "@/forge";
```

and delete the now-duplicated `import { findPrTemplate as _findPrTemplate } from "./template";` line.

No other change is needed: `_autoPrDeps` keeps the same key names and the same
call sites, `forgeFromRemoteUrl` has the same `(remoteUrl) => ForgeKind | null`
signature the plugin already calls, and `openPr` returns a shape assignable to
`PostRunActionResult`.

- [ ] **Step 5: Delete the superseded modules**

```bash
git rm src/plugins/builtin/auto-pr/forge.ts src/plugins/builtin/auto-pr/template.ts
```

- [ ] **Step 6: Retarget the two orphaned test files**

In `test/unit/plugins/builtin/auto-pr-forge.test.ts`, replace the two imports at
lines 10-11 with:

```ts
import { type AutoPrDeps, hasOpenPr, openPr as openDraft } from "@/forge";
```

Then delete its `describe("detectForge", ...)` block — that coverage now lives in
`test/unit/forge/detect.test.ts` and must not be duplicated. Keep the `hasOpenPr`
and `openDraft` blocks and the new self-hosted regression block from Step 1.

In `test/unit/plugins/builtin/auto-pr-template.test.ts`, replace the import of
`../../../../src/plugins/builtin/auto-pr/template` with `@/forge`, and the import
of `.../auto-pr/types` with `import type { AutoPrDeps } from "@/forge";`.

- [ ] **Step 7: Run the full affected suites**

```bash
bun test test/unit/forge/ test/unit/plugins/builtin/
```
Expected: PASS, including the three self-hosted regression tests that failed in Step 2.

- [ ] **Step 8: Run the whole suite and the gates**

```bash
bun test
bun x tsc --noEmit
bun run lint
```
Expected: all clean. `scripts/check-deep-relatives.ts` should report **at or below**
the 2845 baseline. This task removes four deep-relative imports (two in
`auto-pr-forge.test.ts`, two in `auto-pr-template.test.ts`) and adds one (the
`_autoPrDeps` seam in Step 1), so the count should fall by three. If it reports
fewer than the baseline, lower it with
`bun run scripts/check-deep-relatives.ts --update-baseline` and include that
change in the commit.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(auto-pr): move onto the shared forge module

Fixes forge detection on self-hosted GitHub and GitLab. The plugin classified
remotes with remoteUrl.includes(\"github.com\"), which is false for a host like
gitlab.mycorp.com, so detectForge returned null, shouldRun returned false, and
auto-PR silently did nothing on every enterprise install. The shared module
matches the parsed host instead, and falls back to a gh/glab probe for hosts
naming neither forge."
```

---

## Self-Review

**Spec coverage.** This plan implements cutover step 1 of section 6 of the design
doc, and section 2.7's forge/template/types rows. The `pr-body` row of that table
is deliberately **not** covered here: the design (section 4.2) keeps body
*content* with each caller and shares only template discovery and merging, and
the merge helper (`flows/nax-finish/pr-template-merge.ts`) has no auto-PR twin to
deduplicate against — it moves with `src/finish/` in a later plan.

**No placeholders.** Every step contains the code or the exact command to run.

**Type consistency.** `ForgeKind`, `ForgeDeps`, `ForgeRunResult`, `OpenPrInput`
and `OpenPrResult` are defined in Tasks 1-2 and used with those exact names in
Tasks 3-4. `forgeFromRemoteUrl` is synchronous everywhere, which is what the
existing `_autoPrDeps.detectForge` stubs assume. `detectForge` (async, with the
CLI probe) is exported for `src/finish/` in a later plan and is deliberately not
wired into auto-PR here — auto-PR already holds a remote URL and swapping it to
the async form would change `shouldRun`'s failure messages for no benefit in this
plan.

## Follow-on plans

This is **plan 1 of 4**. The remaining plans are deliberately not written yet —
each depends on the real API surface the previous one lands:

2. `src/finish/` core — state machine, gates, state, audit, commit.
3. `src/finish/` review and ops — prose codegen, prompt assembly, parse, the
   three `RunOperation`s, PR draft/promote.
4. Wire the post-run phase, migrate config with compat shims, delete `flows/`
   and the finish plugin.

Out of any plan, because they are outside the repository: rewriting the nine
`nax-finish-*.json` profiles, migrating `~/.acpx/config.json`, and syncing the
`nax-toolkit-skills` repo.
