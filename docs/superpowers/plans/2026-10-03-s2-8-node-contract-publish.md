# S2-8 — Node contract suite, packed-tarball smoke and staged publish (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@nathapp/nax-agent` gains a generated publish directory (`.publish/`), a vitest contract suite that runs on real Node, and a smoke that installs the packed tarball into a clean Node project and runs the agent through it.

**Architecture:** `scripts/stage-publish.ts` copies `dist/` plus README/CHANGELOG/LICENSE into `.publish/` and writes a generated manifest whose `exports`/`imports` point into `dist/`. `test/node/` holds a small vitest suite: the runner-neutral spawn/glob behaviour cases against `nodeRuntime`, one test per Node built-in replacement, and a pack smoke that drives build → stage → `npm pack` → install → run → consumer typecheck. A new CI matrix job runs the suite on Node 22 and 24.

**Tech Stack:** TypeScript 7.0.2, vitest 4.1.9 (nax-ai's pin), Bun 1.4.0 for install/build/scripts, Node 22/24 for the contract suite, npm for packing and installing.

**Spec:** `docs/superpowers/specs/2026-10-02-s2-nax-agent-node-ready-publish-design.md` (§5.2, §7.2, §7.3, §9, §10). Read §4 and §5 before Task 1.

## Global Constraints

- Node floor stays `engines.node: ">=22.19.0"` in the staged manifest.
- **S2-8 matrix ruling (user, 2026-10-03):** the new CI job is Ubuntu × Node `[22, 24]`. No 22.19.0 leg and no macOS leg in this job. The exact 22.19.0 floor remains covered by the existing `nax-agent-glob-floor` job (ubuntu + macOS, exact `22.19.0`, glob cases); this is a recorded deviation from spec §7.3/§10.2.
- The stub provider in the pack smoke is injected through `/internal`'s `_clientDeps.build` (the seam the package's own tests use); `/internal` ships in the tarball.
- No new runtime dependencies. One new devDependency: `vitest` `4.1.9` (nax-ai's exact pin). `typescript` stays `7.0.2` and `@types/node` `25.2.3`.
- nax-agent ships no Bun code; `bun run check:no-bun-apis` stays green with no exceptions.
- `.` stays curated and exports no `_` name; `api/nax-agent.api.txt` must not change.
- `packages/nax/package.json` `dependencies` stay byte-identical; nax-agent stays bundled.
- All commands run from `packages/nax-agent` unless a step says otherwise.
- One commit per task, conventional messages.

## Review Focus

1. **`stage-publish` without a build** → it fails naming every missing input; it never stages an empty or partial `dist/`.
2. **A consumer typechecking with `skipLibCheck: false`** → third-party diagnostics are ignored, but any diagnostic under the staged `dist/` fails the smoke.
3. **The contract suite running under Bun by accident** → an explicit `process.versions.bun === undefined` assertion fails the suite.
4. **A missing OS sandbox on the Linux CI leg** → the pack smoke fails (never skips); the job installs bubblewrap.
5. **A failing `npm install`/network step** → the smoke reports the failing command with its captured output, not a bare timeout.

---

### Task 1: Stage the publish directory

**Files:**
- Create: `packages/nax-agent/LICENSE` (copy of `packages/nax-ai/LICENSE`)
- Create: `packages/nax-agent/scripts/lib/stage-manifest.ts`
- Create: `packages/nax-agent/scripts/stage-publish.ts`
- Create: `packages/nax-agent/test/unit/packaging/stage-manifest.test.ts`
- Modify: `packages/nax-agent/package.json` (add `author`, `homepage`, `bugs`, `keywords`; add `stage-publish` script; lint `scripts/`)
- Modify: `packages/nax-agent/tsconfig.json` (include `scripts/**/*.ts`)
- Modify: `packages/nax-agent/.gitignore` (add `.publish/`)

**Interfaces:**
- Produces in `scripts/lib/stage-manifest.ts`:
  - `STAGE_INPUTS: readonly ["dist/index.js", "dist/internal.js", "README.md", "CHANGELOG.md", "LICENSE"]`
  - `missingStageInputs(pkgDir: string): string[]` — relative paths from `STAGE_INPUTS` absent under `pkgDir`
  - `assertPublishRepo(githubRepository: string | undefined): void` — throws unless it is `undefined` or `"nathapp-io/nax"`
  - `buildStagedManifest(source: Record<string, unknown>, opts: { repository: string; directory: string }): Record<string, unknown>`
- Consumes: nothing (Task 4's pack smoke consumes `bun scripts/stage-publish.ts`).

- [ ] **Step 1: Write the failing manifest tests**

Create `test/unit/packaging/stage-manifest.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertPublishRepo,
  buildStagedManifest,
  missingStageInputs,
  STAGE_INPUTS,
} from "../../../scripts/lib/stage-manifest.ts";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const source = {
  name: "@nathapp/nax-agent",
  version: "0.0.0",
  private: true,
  description: "nax's native coding agent.",
  license: "MIT",
  author: "William Khoo",
  homepage: "https://github.com/nathapp-io/nax/tree/main/packages/nax-agent",
  bugs: { url: "https://github.com/nathapp-io/nax/issues" },
  keywords: ["agent", "coding-agent", "llm", "sandbox", "tools"],
  type: "module",
  exports: { ".": "./src/index.ts" },
  imports: { "#src/*": "./src/*.ts" },
  scripts: { build: "bun x tsc -p tsconfig.build.json" },
  dependencies: { "@nathapp/nax-ai": "0.1.16", "@anthropic-ai/sandbox-runtime": "0.0.77", zod: "^4.3.6" },
  devDependencies: { typescript: "7.0.2" },
};

const OPTS = { repository: "git+https://github.com/nathapp-io/nax.git", directory: "packages/nax-agent" };

describe("buildStagedManifest", () => {
  test("emits exactly the publish manifest", () => {
    expect(buildStagedManifest(source, OPTS)).toEqual({
      name: "@nathapp/nax-agent",
      version: "0.0.0",
      description: "nax's native coding agent.",
      license: "MIT",
      author: "William Khoo",
      homepage: "https://github.com/nathapp-io/nax/tree/main/packages/nax-agent",
      bugs: { url: "https://github.com/nathapp-io/nax/issues" },
      keywords: ["agent", "coding-agent", "llm", "sandbox", "tools"],
      repository: { type: "git", url: "git+https://github.com/nathapp-io/nax.git", directory: "packages/nax-agent" },
      type: "module",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./internal": { types: "./dist/internal.d.ts", import: "./dist/internal.js" },
      },
      imports: { "#src/*": { types: "./dist/*.d.ts", default: "./dist/*.js" } },
      engines: { node: ">=22.19.0" },
      dependencies: source.dependencies,
      publishConfig: { access: "public", registry: "https://registry.npmjs.org/", provenance: true, tag: "latest" },
    });
  });

  test("drops private, scripts, devDependencies and source-pointing exports", () => {
    const manifest = buildStagedManifest(source, OPTS);
    for (const key of ["private", "scripts", "devDependencies"]) expect(key in manifest).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain("./src/");
    expect(JSON.stringify(manifest)).not.toContain("test/helpers");
  });
});

describe("missingStageInputs", () => {
  test("names every missing input on an empty package dir and none once they exist", () => {
    const dir = makeTempDir("stage-inputs-");
    try {
      expect(missingStageInputs(dir)).toEqual([...STAGE_INPUTS]);
      for (const rel of STAGE_INPUTS) {
        const full = join(dir, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, "");
      }
      expect(missingStageInputs(dir)).toEqual([]);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("assertPublishRepo", () => {
  test("accepts unset or the publishing repo and rejects another", () => {
    expect(() => assertPublishRepo(undefined)).not.toThrow();
    expect(() => assertPublishRepo("nathapp-io/nax")).not.toThrow();
    expect(() => assertPublishRepo("someone/fork")).toThrow(/nathapp-io\/nax/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./test/unit/packaging/stage-manifest.test.ts --timeout=60000`
Expected: FAIL — cannot resolve `../../../scripts/lib/stage-manifest.ts`.

- [ ] **Step 3: Implement `scripts/lib/stage-manifest.ts`**

```ts
/**
 * The generated manifest and staging inputs for `bun run stage-publish`
 * (S2 spec §5.2). Pure so the pack smoke and the unit tests can pin it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export const STAGE_INPUTS = ["dist/index.js", "dist/internal.js", "README.md", "CHANGELOG.md", "LICENSE"] as const;

export function missingStageInputs(pkgDir: string): string[] {
  return STAGE_INPUTS.filter((rel) => !existsSync(join(pkgDir, rel)));
}

export function assertPublishRepo(githubRepository: string | undefined): void {
  if (githubRepository !== undefined && githubRepository !== "nathapp-io/nax") {
    throw new Error(`stage-publish: refusing to stage from ${githubRepository}; provenance requires nathapp-io/nax`);
  }
}

type Json = Record<string, unknown>;

export interface StageManifestOptions {
  readonly repository: string;
  readonly directory: string;
}

export function buildStagedManifest(source: Json, opts: StageManifestOptions): Json {
  return {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license,
    author: source.author,
    homepage: source.homepage,
    bugs: source.bugs,
    keywords: source.keywords,
    repository: { type: "git", url: opts.repository, directory: opts.directory },
    type: "module",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./internal": { types: "./dist/internal.d.ts", import: "./dist/internal.js" },
    },
    imports: { "#src/*": { types: "./dist/*.d.ts", default: "./dist/*.js" } },
    engines: { node: ">=22.19.0" },
    dependencies: source.dependencies,
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
      provenance: true,
      tag: "latest",
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./test/unit/packaging/stage-manifest.test.ts --timeout=60000`
Expected: PASS (3 describe blocks, 4 tests).

- [ ] **Step 5: Add the script, LICENSE, metadata and ignore rule**

Copy `packages/nax-ai/LICENSE` to `packages/nax-agent/LICENSE` unchanged.

Create `scripts/stage-publish.ts`:

```ts
#!/usr/bin/env bun
/**
 * Builds `.publish/`, the exact directory `npm publish` ships (S2 spec §5.2).
 * The workspace manifest points at `.ts` sources (R6), so the published
 * manifest is generated here instead.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertPublishRepo, buildStagedManifest, missingStageInputs } from "./lib/stage-manifest.ts";

const PKG = resolve(import.meta.dir, "..");
const OUT = join(PKG, ".publish");
const REPOSITORY = "git+https://github.com/nathapp-io/nax.git";
const DIRECTORY = "packages/nax-agent";

function main(): void {
  const missing = missingStageInputs(PKG);
  if (missing.length > 0) {
    throw new Error(`stage-publish: missing ${missing.join(", ")} — run \`bun run build\` first`);
  }
  assertPublishRepo(process.env.GITHUB_REPOSITORY);
  const source = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as Record<string, unknown>;
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  cpSync(join(PKG, "dist"), join(OUT, "dist"), { recursive: true });
  for (const file of ["README.md", "CHANGELOG.md", "LICENSE"]) cpSync(join(PKG, file), join(OUT, file));
  const manifest = buildStagedManifest(source, { repository: REPOSITORY, directory: DIRECTORY });
  writeFileSync(join(OUT, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`staged ${OUT}`);
}

main();
```

In `packages/nax-agent/package.json` add after `"license": "MIT"`:

```json
  "author": "William Khoo",
  "homepage": "https://github.com/nathapp-io/nax/tree/main/packages/nax-agent",
  "bugs": { "url": "https://github.com/nathapp-io/nax/issues" },
  "keywords": ["agent", "coding-agent", "llm", "sandbox", "tools"]
```

in `scripts` add:

```json
    "stage-publish": "bun scripts/stage-publish.ts",
```

and extend the two Biome script paths to cover the new directory (`scripts/` joins `src/ test/`, as in nax-ai):

```json
    "lint:biome": "bun x biome check --error-on-warnings --diagnostic-level=warn src/ test/ scripts/",
    "lint:fix": "bun x biome check --write src/ test/ scripts/",
```

In `packages/nax-agent/tsconfig.json` change `include` to `["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"]` so the script is typechecked.

In `packages/nax-agent/.gitignore` append `.publish/`.

- [ ] **Step 6: Verify the real script end to end**

Run: `rm -rf .publish dist && bun run stage-publish`
Expected: FAIL naming `dist/index.js, dist/internal.js` — the no-build guard.

Run: `bun run build && bun run stage-publish`
Expected: `staged .../packages/nax-agent/.publish`. Then read `.publish/package.json` and confirm `exports`/`imports` point into `./dist/`, `engines.node` is `>=22.19.0`, and `private`/`scripts`/`devDependencies` are absent. Also confirm `bun run typecheck` and `bun run lint:biome` stay green with `scripts/` included.

- [ ] **Step 7: Commit**

```bash
git add packages/nax-agent/LICENSE packages/nax-agent/scripts packages/nax-agent/test/unit/packaging/stage-manifest.test.ts packages/nax-agent/package.json packages/nax-agent/.gitignore
git commit -m "feat: stage the nax-agent publish directory"
```

---

### Task 2: Vitest scaffold and the spawn/glob contract cases

**Files:**
- Modify: `packages/nax-agent/package.json` (add `vitest` devDependency and `test:node` script)
- Modify: `bun.lock` (via `bun install`)
- Create: `packages/nax-agent/vitest.config.ts`
- Create: `packages/nax-agent/test/node/contract-spawn.test.ts`
- Create: `packages/nax-agent/test/node/contract-glob.test.ts`

**Interfaces:**
- Consumes: `nodeRuntime` from `#src/runtime/index`; `SPAWN_CASES` / `GLOB_CASES` from `@nathapp/nax-test-kit/cases/*`.
- Produces: `bun run test:node` runs `test/node/**/*.test.ts` under vitest on real Node (probed: vitest's bin shebang is `env node`, so `bun run` executes it under Node).

- [ ] **Step 1: Add the devDependency, config and script**

In `packages/nax-agent/package.json` `devDependencies` add `"vitest": "4.1.9"`, and in `scripts` add `"test:node": "vitest --run"`.

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/node/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
```

Run: `bun install` (repo root).
Expected: lockfile updated, `packages/nax-agent/node_modules/.bin/vitest` present.

- [ ] **Step 2: Write the two contract test files**

`test/node/contract-spawn.test.ts`:

```ts
/**
 * The runner-neutral spawn behaviour cases (S2 spec §4.3) against the Node
 * runtime, on real Node. The bun suite covers the same cases; this suite
 * proves the runtime the package ships to.
 */
import { SPAWN_CASES } from "@nathapp/nax-test-kit/cases/spawn-cases";
import { expect, test } from "vitest";
import { nodeRuntime } from "#src/runtime/index";

test("the contract suite runs on Node, not Bun", () => {
  expect(process.versions.bun).toBeUndefined();
});

for (const c of SPAWN_CASES) {
  test(c.name, () => c.run(nodeRuntime), 15_000);
}
```

`test/node/contract-glob.test.ts`:

```ts
import { GLOB_CASES } from "@nathapp/nax-test-kit/cases/glob-cases";
import { test } from "vitest";
import { nodeRuntime } from "#src/runtime/index";

for (const c of GLOB_CASES) {
  test(c.name, () => c.run(nodeRuntime), 15_000);
}
```

- [ ] **Step 3: Run the suite**

Run: `bun run test:node`
Expected: PASS; the reported test count is exactly `1 + SPAWN_CASES.length + GLOB_CASES.length` (all spawn and glob cases plus the Bun guard). Confirm the guard test is present in the output.

- [ ] **Step 4: Commit**

```bash
git add packages/nax-agent/package.json packages/nax-agent/vitest.config.ts packages/nax-agent/test/node bun.lock
git commit -m "test: run the spawn and glob behaviour cases on real Node"
```

---

### Task 3: Prove the Node built-in replacements on Node

**Files:**
- Create: `packages/nax-agent/test/node/builtins.test.ts`

**Interfaces:**
- Consumes: `fileSizeOrZero` (`#src/internal/file-size`), `readApprovalsFileDetailed` (`#src/permissions/approvals-store`), `_gitGuardDeps` (`#src/sandbox/git-guards`), `_spillDeps` (`#src/tools/spill`), `digest64` (`#src/infra/spin-breaker/hash`), `getNativeClient`/`_clientDeps`/`_resetNativeClient` (`#src/native/client`), `which` (`#src/runtime/which`).
- Produces: one test per §4.1 replacement, green under `bun run test:node`.

- [ ] **Step 1: Write the tests**

Create `test/node/builtins.test.ts`:

```ts
/**
 * One test per Node built-in replacement (S2 spec §4.1), on real Node. The
 * bun suites already pin these behaviours; this suite proves the shipped
 * runtime, where `Bun.file`/`Bun.write`/`Bun.hash`/`Bun.CryptoHasher`/
 * `Bun.which` no longer exist.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { afterEach, expect, test } from "vitest";
import { digest64 } from "#src/infra/spin-breaker/hash";
import { fileSizeOrZero } from "#src/internal/file-size";
import { _clientDeps, _resetNativeClient, getNativeClient } from "#src/native/client";
import { readApprovalsFileDetailed } from "#src/permissions/approvals-store";
import { _gitGuardDeps } from "#src/sandbox/git-guards";
import { which } from "#src/runtime/which";
import { _spillDeps } from "#src/tools/spill";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "nax-node-builtin-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  _resetNativeClient();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

test("Bun.file .size → statSync: UTF-8 bytes, zero for a missing file, other errors propagate", () => {
  const dir = tmp();
  const file = join(dir, "héllo.txt");
  writeFileSync(file, "héllo");
  expect(fileSizeOrZero(file)).toBe(6);
  expect(fileSizeOrZero(join(dir, "missing"))).toBe(0);
  expect(() => fileSizeOrZero(join(file, "child"))).toThrow(/ENOTDIR/);
});

test("Bun.file read → readFile: a missing approvals file is missing, a permission error is not", async () => {
  const dir = tmp();
  expect(await readApprovalsFileDetailed(join(dir, "approvals.json"))).toEqual({
    state: "missing",
    file: { entries: [], taint: undefined },
    droppedMalformed: 0,
  });
  const denied = join(dir, "denied.json");
  writeFileSync(denied, "{}");
  chmodSync(denied, 0o000);
  if (process.getuid?.() === 0) return; // root ignores the mode; CI runs as a user
  await expect(readApprovalsFileDetailed(denied)).rejects.toThrow(/EACCES/);
});

test("Bun.file read → readFile: git-guard text reads UTF-8 and rejects ENOENT", async () => {
  const dir = tmp();
  const file = join(dir, "ignore.txt");
  writeFileSync(file, "héllo");
  expect(await _gitGuardDeps.readText(file)).toBe("héllo");
  await expect(_gitGuardDeps.readText(join(dir, "missing"))).rejects.toThrow(/ENOENT/);
});

test("Bun.write → fs/promises writeFile: byte count and stored bytes", async () => {
  const dir = tmp();
  const file = join(dir, "spill.txt");
  expect(await _spillDeps.writeFile(file, "héllo")).toBe(6);
  expect(await _gitGuardDeps.readText(file)).toBe("héllo");
});

test("Bun.hash → sha256's first 16 hex characters", () => {
  expect(digest64("")).toBe("e3b0c44298fc1c14");
  expect(digest64("abc")).toBe("ba7816bf8f01cfea");
});

test("Bun.CryptoHasher → createHash: the override digest is 12 hex characters", async () => {
  const model: ResolvedModel = {
    id: "stub",
    provider: "a",
    protocol: "stub",
    pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    supportsTools: false,
    thinkingLevels: [],
  };
  const stub: Client = {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* () {},
    complete: async () => ({ text: "unused", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "stop" }),
    validate: () => {},
  };
  _clientDeps.build = async () => stub;
  await getNativeClient([{ provider: "a", models: [] }]);
  const error = await getNativeClient([{ provider: "b", models: [] }]).catch(
    (e: unknown) => e as { context?: { requested?: { digest?: string } } },
  );
  expect(error.context?.requested?.digest).toMatch(/^[0-9a-f]{12}$/);
});

test("Bun.which → the PATH walk: executable files resolve, others do not", () => {
  const dir = tmp();
  const tool = join(dir, "tool");
  writeFileSync(tool, "#!/bin/sh\n");
  chmodSync(tool, 0o755);
  expect(which("tool", dir)).toBe(tool);
  writeFileSync(join(dir, "not-exec"), "x");
  chmodSync(join(dir, "not-exec"), 0o644);
  expect(which("not-exec", dir)).toBeNull();
  expect(which("absent", dir)).toBeNull();
  expect(which(join(dir, "tool"), dir)).toBe(join(dir, "tool"));
});
```

- [ ] **Step 2: Run the tests**

Run: `bun run test:node`
Expected: PASS, 7 new tests. These are contract tests for code that already exists; if one fails, the shipped source does not behave as S2-5 pinned it and must be investigated before continuing.

- [ ] **Step 3: Commit**

```bash
git add packages/nax-agent/test/node/builtins.test.ts
git commit -m "test: prove the Node built-in replacements on Node"
```

---

### Task 4: The packed-tarball smoke

**Files:**
- Create: `packages/nax-agent/test/node/fixtures/packed-smoke.mjs`
- Create: `packages/nax-agent/test/node/pack-smoke.test.ts`

**Interfaces:**
- Consumes: `bun run build`, `bun scripts/stage-publish.ts` (Task 1), `npm pack`, `npm install`, the fixture script below.
- Produces: `bun run test:node` also proves the packed tarball on the running Node.

- [ ] **Step 1: Write the consumer fixture**

Create `test/node/fixtures/packed-smoke.mjs` (plain Node ESM; runs inside the temporary consumer, not the repo):

```js
/**
 * Runs inside the temporary consumer that installed the packed nax-agent
 * tarball (S2 spec §7.3). Plain Node ESM: no repo imports, no test framework.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeSessionAdapter, globTool } from "@nathapp/nax-agent";
import { DEFAULT_SANDBOX_CONFIG, _clientDeps, resolveSessionSandbox } from "@nathapp/nax-agent/internal";

assert.equal(process.versions.bun, undefined, "the packed smoke must run on native Node");

const workdir = mkdtempSync(join(tmpdir(), "nax-packed-"));
writeFileSync(join(workdir, "hello.txt"), "hello");

// 1. One tool round-trip through the packed entry.
const globbed = await globTool.run(
  { pattern: "*.txt" },
  { root: workdir, resolvedPaths: [], maxBytes: 10_000, maxFileBytes: 10_000 },
);
assert.match(globbed.content, /hello\.txt/, `glob tool missed the file: ${globbed.content}`);

// 2. One native session turn against a stub client (the /internal seam the
//    package's own tests use; /internal ships in the tarball).
const model = {
  id: "packed-stub",
  provider: "stub",
  protocol: "stub",
  pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
};
_clientDeps.build = async () => ({
  model: async () => model,
  listModels: async () => [model],
  pricing: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
  stream: async function* () {},
  complete: async () => ({ text: "packed-ok", usage: { inputTokens: 2, outputTokens: 3 }, stopReason: "stop" }),
  validate: () => {},
});
const transcriptDir = join(workdir, "transcripts");
mkdirSync(transcriptDir, { recursive: true });
const adapter = new NativeSessionAdapter();
const handle = await adapter.openSession("packed-smoke", {
  agentName: "native",
  workdir,
  resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  modelDef: { provider: "stub", model: "stub/packed-stub" },
  timeoutSeconds: 60,
  transcriptDir,
});
const turn = await adapter.sendTurn(handle, "hi", {
  interactionHandler: { onInteraction: async () => ({ answer: "" }) },
});
assert.equal(turn.output, "packed-ok", `unexpected turn output: ${turn.output}`);
await adapter.closeSession(handle);

// 3. Linux only (spec §7.3): one command through the real OS sandbox. A
//    missing sandbox FAILS here; CI installs bubblewrap.
if (process.platform === "linux") {
  const launcher = await resolveSessionSandbox({
    config: DEFAULT_SANDBOX_CONFIG,
    root: workdir,
    needsLauncher: true,
    protectedPaths: {
      gitExcludePathspecs: [],
      gitIgnorePatterns: [],
      projectStateDir: ".nax",
      credentialDir: join(workdir, ".credentials"),
      trustStoreFile: join(workdir, ".trust.json"),
    },
  });
  const result = await launcher.run({
    spec: { kind: "shell", shell: "/bin/sh", command: "echo packed-sandbox" },
    root: workdir,
    cwd: workdir,
    timeoutMs: 30_000,
    stripEnvVars: [],
  });
  assert.equal(result.sandbox.wrapped, true, `sandbox was not applied: ${JSON.stringify(result.sandbox)}`);
  assert.equal(result.exitCode, 0, `sandboxed command failed: ${result.stderr}`);
  assert.match(result.stdout, /packed-sandbox/);
}

console.log("packed smoke ok");
```

- [ ] **Step 2: Write the smoke test**

Create `test/node/pack-smoke.test.ts`:

```ts
/**
 * The tarball smoke (S2 spec §7.3): build, stage, `npm pack .publish/`,
 * install into a clean Node project, import the packed package, run one tool
 * round-trip and one native session turn, then typecheck a consumer with
 * skipLibCheck:false. Only diagnostics under the installed package's dist/
 * fail; third-party ones are ignored (the S2-7 api-surface precedent).
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = join(PKG, "test/node/fixtures/packed-smoke.mjs");

function run(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    throw new Error(`${cmd} ${args.join(" ")} (cwd ${cwd}) failed with status ${e.status}:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
}

let consumer = "";
let packDir = "";

beforeAll(() => {
  run("bun", ["run", "build"], PKG);
  run("bun", ["scripts/stage-publish.ts"], PKG);
  packDir = mkdtempSync(join(tmpdir(), "nax-pack-"));
  run("npm", ["pack", ".publish/", "--pack-destination", packDir], PKG);
  const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  if (tgz === undefined) throw new Error(`npm pack produced no tarball in ${packDir}`);
  consumer = mkdtempSync(join(tmpdir(), "nax-consumer-"));
  run("npm", ["init", "-y"], consumer);
  run("npm", ["install", "--no-audit", "--no-fund", join(packDir, tgz), "typescript@7.0.2", "@types/node@25.2.3"], consumer);
}, 300_000);

afterAll(() => {
  if (packDir !== "") rmSync(packDir, { recursive: true, force: true });
  if (consumer !== "") rmSync(consumer, { recursive: true, force: true });
});

describe("the packed tarball", () => {
  test("runs one tool round-trip, one native turn and (on Linux) one sandboxed command", () => {
    cpSync(FIXTURE, join(consumer, "packed-smoke.mjs"));
    expect(run("node", ["packed-smoke.mjs"], consumer)).toContain("packed smoke ok");
  }, 180_000);

  test("typechecks for a skipLibCheck:false consumer; only third-party diagnostics are allowed", () => {
    writeFileSync(
      join(consumer, "index.ts"),
      [
        'import { NativeSessionAdapter, getAgentRuntime, globTool, nodeRuntime, setAgentRuntime } from "@nathapp/nax-agent";',
        'import { _clientDeps } from "@nathapp/nax-agent/internal";',
        "export const names = [typeof NativeSessionAdapter, typeof getAgentRuntime, typeof globTool, typeof nodeRuntime, typeof setAgentRuntime, typeof _clientDeps];",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "nodenext",
          moduleResolution: "nodenext",
          lib: ["ES2023"],
          types: ["node"],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        include: ["index.ts"],
      }),
    );
    let output = "";
    try {
      output = run(join(consumer, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], consumer);
    } catch (error) {
      output = (error as Error).message;
    }
    const ownDist = join(consumer, "node_modules/@nathapp/nax-agent/dist/");
    expect(output.split("\n").filter((line) => line.includes(ownDist))).toEqual([]);
  }, 120_000);
});
```

- [ ] **Step 3: Run the smoke test alone**

Run: `bun run test:node -- pack-smoke`
Expected: PASS on macOS (the Linux sandbox branch is skipped). On Linux it passes only with a working bubblewrap and fails with the sandbox message otherwise. Every failure names the failing command and its output (the `run()` wrapper), never a bare timeout.

- [ ] **Step 4: Run the full suite**

Run: `bun run test:node`
Expected: PASS — spawn cases, glob cases, built-ins, both packed-tarball tests.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/test/node/fixtures packages/nax-agent/test/node/pack-smoke.test.ts
git commit -m "test: smoke the packed nax-agent tarball"
```

---

### Task 5: CI matrix job

**Files:**
- Modify: `.github/workflows/ci.yml` (add the `nax-agent-node` job after `nax-agent-glob-floor`)

**Interfaces:**
- Consumes: `bun run test:node` (Tasks 2–4), which itself builds and stages.
- Produces: a required CI job on Node 22 and 24.

- [ ] **Step 1: Add the job**

Insert after the `nax-agent-glob-floor` job in `.github/workflows/ci.yml`:

```yaml
  # S2-8: the Node contract suite (spec §7.3). vitest's bin has an
  # `#!/usr/bin/env node` shebang, so `bun run` executes it under the matrix
  # Node; the suite also asserts `process.versions.bun` is undefined.
  # Matrix ruling 2026-10-03: Ubuntu × [22, 24]; the exact 22.19.0 floor stays
  # covered by nax-agent-glob-floor.
  nax-agent-node:
    name: "nax-agent: node ${{ matrix.node }}"
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        node: ["22", "24"]
    defaults:
      run:
        working-directory: packages/nax-agent
    steps:
      - uses: actions/checkout@v5

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.4.0"

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}

      - name: Cache bun dependencies
        uses: actions/cache@v5
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: |
            bun-${{ runner.os }}-

      - name: Install dependencies
        run: bun install --frozen-lockfile
        working-directory: .

      # The pack smoke runs one sandboxed command on Linux; a missing
      # bubblewrap FAILS it (the fixture asserts the sandbox was applied).
      - name: Enable the OS sandbox (bubblewrap)
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y -qq bubblewrap socat ripgrep
          sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || true

      - run: node --version

      - name: Node contract suite
        run: bun run test:node
```

- [ ] **Step 2: Verify locally at the same versions**

Run: `node --version && bun run test:node` from `packages/nax-agent`.
Expected: PASS on the locally installed Node (22.22.2 on the dev machine), same as the CI leg.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the nax-agent Node contract suite on 22 and 24"
```

---

### Task 6: Close-out — gates, measurements, arc record

**Files:**
- Modify: `/Users/williamkhoo/workspace/subrina-coder/projects/nax/nax-agent-master-plan.md` (arc SSOT; not in this repo)

**Interfaces:**
- Consumes: every task above.
- Produces: recorded measurements and the S2 row update.

- [ ] **Step 1: Run the package gates**

From `packages/nax-agent`:

```bash
bun run typecheck
bun run check:all
bun run build
bun run check:api
bun run test
bun run test:coverage
bun run test:node
```

Expected: all green; `check:api` reports no snapshot change; `test:coverage` baseline stays empty; `test:node` passes. If `check:test-satellites` or `check-file-sizes` trips on a new test file, fix the file (name/size), never the baseline.

- [ ] **Step 2: Run the repo gates**

From the repo root:

```bash
bun run typecheck
bun run check:all
git diff main --stat -- packages/nax packages/nax-ai
```

Expected: green; the `git diff` prints nothing (nax and nax-ai untouched, nax's dependencies byte-identical).

Then a CLI sanity check from `packages/nax`:

```bash
bun run build
bun dist/nax.js --help > /dev/null && bun dist/nax.js --version
```

Expected: both exit 0. (The billed `nax run` smoke in spec §10.5 needs the user's approval at launch and is not part of this task.)

- [ ] **Step 3: Record the slice in the arc SSOT**

Update `/Users/williamkhoo/workspace/subrina-coder/projects/nax/nax-agent-master-plan.md`:

- §2 Decisions: add **D22** — S2-8 matrix is Ubuntu × Node `[22, 24]` (user 2026-10-03); the exact 22.19.0 floor stays covered by `nax-agent-glob-floor`; the pack-smoke stub client is injected via `/internal`'s `_clientDeps.build`; the consumer typecheck ignores third-party diagnostics (S2-7 `api-surface.ts` precedent).
- §5 S2 row: append `**S2-8 PLAN WRITTEN 2026-10-03** ...` with the branch name and plan path; the execution line and PR go in after the PR merges.

- [ ] **Step 4: Commit any in-repo residue and stop**

Run `git status --short`; commit only in-repo files. Do **not** push or open a PR — that needs the user's explicit approval (arc guardrail).

---

## Self-review and requirement map

- Spec §5.2 (staged manifest): Task 1 Steps 3/5, tests in Step 1.
- Spec §7.3 (contract suite, Node built-ins, tarball smoke, sandbox on Linux): Tasks 2–4.
- Spec §10.2 (packed tarball on the matrix Node versions): Task 4 + Task 5 (deviation: Ubuntu × [22, 24], per D22).
- Spec §10.5 (nax CLI unchanged): Task 6 Step 2.
- S2-6 carry-ins: `.d.ts` `./x.ts` specifiers resolve for a consumer (pack smoke typecheck, Task 4); third-party TS7016 ignored by the same rule (Task 4).
- Review Focus 1 → Task 1 Step 6 (no-build guard) and Step 1 (`missingStageInputs`). 2 → Task 4 Step 2 (dist-only filter). 3 → Task 2 Step 2 (Bun guard). 4 → Task 4 fixture (asserts `wrapped === true`) + Task 5 bubblewrap step. 5 → Task 4 `run()` wraps every command with its captured output.
