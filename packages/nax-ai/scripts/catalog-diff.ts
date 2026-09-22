// scripts/catalog-diff.ts
/**
 * Reviews a pi-ai bump by diffing the bundled provider catalog between two
 * versions.
 *
 * pi-ai ships no CHANGELOG and releases roughly ten times a month, so the
 * review that a bump actually needs — did anything reaching this package
 * change? — is not answerable from release notes. It is answerable from the
 * data, which is what this prints.
 *
 * SCOPE: model data only, from `dist/providers/data/*.json`. Provider-level
 * `baseUrl` and `auth` live in pi-ai's provider JS modules, not this data, and
 * `providers/pi-catalog.ts` prefers the provider-level `baseUrl` over the
 * model's. A bump that moves a provider's base URL, or flips it to oauth-only
 * (which makes `toProviderAuth` throw at load), therefore diffs clean here.
 * Nor does any of this see wire behaviour: a provider that changes its SSE
 * framing without touching its catalog entry is invisible to every offline
 * check, this one included.
 *
 * Node-only by the same rule as the release script: nothing here may assume
 * Bun at runtime. It reaches the npm registry (to fetch tarballs) but never a
 * provider, so it spends nothing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Catalog, diffCatalogs, filterCatalog, formatDiff, hasChanges } from "./catalog-diff-core.ts";

const PACKAGE = "@earendil-works/pi-ai";
const DATA_DIR = join("dist", "providers", "data");
const MANIFEST = ".manifest.json";
const INSTALLED = "installed";

/** npm version specs and dist-tags only. Anything else would reach `join()` as a path segment. */
const SPEC_PATTERN = /^[A-Za-z0-9._-]+$/;

const USAGE = `Diff pi-ai's bundled provider catalog between two versions.

  node scripts/catalog-diff.ts                       installed -> latest
  node scripts/catalog-diff.ts 0.85.1 0.87.0         two published versions
  node scripts/catalog-diff.ts installed 0.87.0      what a bump would do
  node scripts/catalog-diff.ts --only opencode-go,minimax

A whole-catalog diff of one bump runs to thousands of lines, so --only (the
providers actually routed to) is the form worth running routinely.

Scope: model data only. Provider-level baseUrl/auth and wire behaviour are
not covered — see the header comment.`;

class UsageError extends Error {}

interface Snapshot {
  readonly label: string;
  readonly catalog: Catalog;
  readonly schemaVersion: unknown;
}

/** Reads every provider JSON in one extracted (or installed) copy of pi-ai. */
function readCatalog(root: string, label: string): Catalog {
  const dir = join(root, DATA_DIR);
  if (!existsSync(dir)) {
    // The relocation is itself the most significant change a bump can carry,
    // since providers/pi-catalog.ts reads this path. Report it, do not crash.
    throw new Error(`${label}: no catalog at ${DATA_DIR} — pi-ai's layout changed. Review this bump by hand.`);
  }

  const catalog: Record<string, unknown> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || file.startsWith(".")) continue;
    try {
      catalog[file.slice(0, -".json".length)] = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      throw new Error(`${label}: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return catalog as Catalog;
}

/**
 * pi-ai stamps a `schemaVersion` beside the data. A change to it means the
 * entry shape moved, which silently invalidates every watched-field assumption
 * the differ makes — so it is surfaced rather than skipped with the dotfiles.
 */
function readSchemaVersion(root: string): unknown {
  const file = join(root, DATA_DIR, MANIFEST);
  if (!existsSync(file)) return undefined;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { schemaVersion?: unknown }).schemaVersion;
  } catch {
    return undefined;
  }
}

/**
 * Downloads one published version and returns the directory holding it.
 *
 * `npm pack` is used rather than `npm install` so nothing touches this repo's
 * node_modules or lockfile — reviewing a bump must not perform one.
 */
function fetchVersion(version: string, into: string): string {
  const dest = join(into, version);
  mkdirSync(dest, { recursive: true });

  let stdout: string;
  try {
    stdout = execFileSync("npm", ["pack", `${PACKAGE}@${version}`, "--pack-destination", dest, "--silent"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (error) {
    throw new Error(
      `Could not fetch ${PACKAGE}@${version}. Check the version exists and npm is on PATH. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const tarball = stdout.trim().split("\n").at(-1);
  if (tarball === undefined || tarball === "") throw new Error(`npm pack produced no tarball for ${version}.`);

  try {
    execFileSync("tar", ["-xzf", join(dest, tarball), "-C", dest], { stdio: "inherit" });
  } catch (error) {
    throw new Error(`Could not extract ${tarball}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Every npm tarball extracts under a top-level "package" directory.
  return join(dest, "package");
}

function resolve(spec: string, into: string): Snapshot {
  if (spec === INSTALLED) {
    const root = join(process.cwd(), "node_modules", PACKAGE);
    if (!existsSync(root)) throw new Error(`${PACKAGE} is not installed. Run 'bun install', or name a version.`);
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    const label = `${version} (installed)`;
    return { label, catalog: readCatalog(root, label), schemaVersion: readSchemaVersion(root) };
  }

  if (!SPEC_PATTERN.test(spec)) throw new UsageError(`"${spec}" is not a version or dist-tag.`);
  const root = fetchVersion(spec, into);
  return { label: spec, catalog: readCatalog(root, spec), schemaVersion: readSchemaVersion(root) };
}

interface Args {
  readonly before: string;
  readonly after: string;
  readonly only: readonly string[];
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  let only: readonly string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;

    if (arg === "--help" || arg === "-h") throw new UsageError("");

    if (arg === "--only" || arg.startsWith("--only=")) {
      const inline = arg.startsWith("--only=") ? arg.slice("--only=".length) : argv[++index];
      if (inline === undefined || inline === "") throw new UsageError("--only needs a comma-separated provider list.");
      only = inline.split(",").filter((id) => id !== "");
      continue;
    }

    if (arg.startsWith("-")) throw new UsageError(`Unknown option "${arg}".`);
    positional.push(arg);
  }

  if (positional.length > 2) throw new UsageError(`Expected at most two versions, got ${positional.length}.`);
  return { before: positional[0] ?? INSTALLED, after: positional[1] ?? "latest", only };
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (error.message !== "") console.error(`${error.message}\n`);
    console.error(USAGE);
    process.exitCode = error.message === "" ? 0 : 2;
    return;
  }

  const work = mkdtempSync(join(tmpdir(), "nax-ai-catalog-"));
  try {
    const from = resolve(args.before, work);
    const to = resolve(args.after, work);

    // A name in neither catalog is a typo, not a provider added later — and a
    // typo would otherwise print a confident "No catalog changes."
    const known = new Set([...Object.keys(from.catalog), ...Object.keys(to.catalog)]);
    const unknown = args.only.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`--only names no provider in either catalog: ${unknown.join(", ")}.`);
    }

    const scope = args.only.length === 0 ? "all providers" : args.only.join(", ");
    console.log(`pi-ai catalog: ${from.label} -> ${to.label}  [${scope}]\n`);

    if (from.schemaVersion !== to.schemaVersion) {
      console.log(
        `** catalog schemaVersion ${String(from.schemaVersion)} -> ${String(to.schemaVersion)}: the entry shape ` +
          "changed, so the watched-field list below is no longer known to be complete. Review it. **\n",
      );
    }

    const diff = diffCatalogs(filterCatalog(from.catalog, args.only), filterCatalog(to.catalog, args.only));
    console.log(formatDiff(diff));

    if (hasChanges(diff)) {
      console.log(
        `\n${diff.providersAdded.length + diff.providersRemoved.length} provider(s), ` +
          `${diff.modelsAdded.length} model(s) added, ${diff.modelsRemoved.length} removed, ` +
          `${diff.modelsChanged.length} changed.`,
      );
    }
  } catch (error) {
    // Every throw above carries a message written to be read on its own. A
    // stack trace here would bury it, and none of these are bugs in this
    // script — they are the operator's input, the network, or pi-ai's layout.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    // Best-effort: a failure to clean a temp directory must not mask the
    // report, or a transient EBUSY would look like a diff failure.
    rmSync(work, { recursive: true, force: true });
  }
}

main();
