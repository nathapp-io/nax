/**
 * Which test files the coverage run hands `bun test` (check-coverage.ts, opt-in
 * with `--skip-source-free-tests`).
 *
 * `bun test --coverage` records only the test process. Code a test runs in a
 * child process (`Bun.spawn(["bun", "bin/nax.ts", ...])`) records nothing:
 * probed 2026-11-09 on Bun 1.4.4, where a function called only in the child had
 * 0 hits and the child's entry file had no `SF:` record. So a unit or
 * integration file that cannot run `src/` in-process adds run time to the
 * serial coverage run and no coverage. In nax these are mostly the
 * CLI-spawning tests, at 1-3s each; they still run in CI's confined step.
 *
 * This is decided by imports, not by searching for `@/`: a file is skipped
 * only when every import is `bun:test`, a `node:` built-in, or a temp-directory
 * helper from `@test/helpers` (those re-export `@nathapp/nax-test-kit`, outside
 * nax). Any other import keeps the file. A first version that only looked for
 * `@/` lost 101 covered lines of `src/cli/memory-admin-relink.ts`, reached
 * through `@test/helpers` harnesses that call src/ in-process (measured
 * 2026-11-09).
 *
 * Not a guarantee: importing even a temp-dir helper loads the whole
 * `@test/helpers` barrel, which loads some src/ modules. Those module bodies
 * are loaded by kept tests too, so no line is lost; on 2026-11-09 the skipped
 * files' covered src/ lines were all still covered without them (0 missing,
 * 907 src files compared). Re-run that comparison if this rule is widened.
 *
 * Kept anyway:
 * - every `test/ui/` file. CI's confined step does not run that suite, so the
 *   coverage run is its only run.
 * - a file that reads a confinement variable. It behaves differently outside
 *   the sandbox, and the coverage run is the suites' only unconfined run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A string literal naming nax `src/`: an `@/` alias (import, dynamic import, mock.module) or a `src/` path. */
const SOURCE_REFERENCE = /["'`]@\/|\/src\//;

/** Variables a test reads to behave differently inside or outside the confined sandbox. */
const CONFINEMENT_ENV = /\b(?:NAX_TEST_CONFINED|NAX_SANDBOXED|NAX_SANDBOX_REQUIRED)\b/;

/** Any runtime module load other than an `import ... from` clause, re-exports (`export ... from`) included. */
const OTHER_LOAD = /\bimport\s*\(|\brequire\s*\(|^\s*import\s+["']|^\s*export\s[^;]*?\bfrom\s*["']/m;

/** Every static `import ... from "<specifier>"`, with the braces of named imports when present. */
const STATIC_IMPORT = /\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;

/** `@test/helpers` exports known not to reach nax src/ (they re-export `@nathapp/nax-test-kit`). */
const SAFE_HELPERS: ReadonlySet<string> = new Set(["makeTempDir", "cleanupTempDir", "withTempDir"]);

/** Suites whose source-free files may be skipped. `test/ui/` is deliberately absent. */
const SKIPPABLE_SUITES: readonly string[] = ["test/unit/", "test/integration/"];

function namedImports(clause: string): string[] | undefined {
  const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
  if (!braces) return undefined;
  return braces[1]
    .split(",")
    .map((name) =>
      name
        .replace(/^\s*type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim(),
    )
    .filter((name) => name.length > 0);
}

function isSafeImport(clause: string, specifier: string): boolean {
  if (specifier === "bun:test" || specifier.startsWith("node:")) return true;
  if (specifier !== "@test/helpers") return false;
  const names = namedImports(clause);
  // A default or namespace import (`import * as h`) has no names to vet, so it never counts as safe.
  return names?.every((name) => SAFE_HELPERS.has(name)) === true;
}

export function isSourceFreeTest(text: string): boolean {
  if (SOURCE_REFERENCE.test(text) || CONFINEMENT_ENV.test(text) || OTHER_LOAD.test(text)) return false;
  return [...text.matchAll(STATIC_IMPORT)].every(([, clause, specifier]) => isSafeImport(clause, specifier));
}

export interface SelectionDeps {
  /** Test files under `suite`, relative to `root`, e.g. `test/unit/a.test.ts`. */
  listTestFiles(root: string, suite: string): string[];
  read(path: string): string;
}

const defaultDeps: SelectionDeps = {
  listTestFiles: (root, suite) =>
    [...new Bun.Glob("**/*.test.{ts,tsx}").scanSync({ cwd: join(root, suite) })].sort().map((f) => `${suite}${f}`),
  read: (path) => readFileSync(path, "utf8"),
};

/**
 * The arguments for `bun test`. A skippable suite becomes its kept files, each
 * prefixed `./` so bun reads it as a path, not as a name filter; any other suite
 * stays a directory.
 */
export function coverageTestPaths(
  root: string,
  suites: readonly string[],
  deps: SelectionDeps = defaultDeps,
): { paths: string[]; skipped: string[] } {
  const paths: string[] = [];
  const skipped: string[] = [];
  for (const suite of suites) {
    if (!SKIPPABLE_SUITES.includes(suite)) {
      paths.push(suite);
      continue;
    }
    for (const file of deps.listTestFiles(root, suite)) {
      if (isSourceFreeTest(deps.read(join(root, file)))) skipped.push(file);
      else paths.push(`./${file}`);
    }
  }
  return { paths, skipped };
}
