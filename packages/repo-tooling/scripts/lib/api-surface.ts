/**
 * A package's public API, read from its BUILT declarations.
 *
 * The published surface is whatever `dist/index.d.ts` and `dist/internal.d.ts`
 * export, after every `export *`, rename and `export type` has been resolved.
 * Reading source text would miss a `_` name that arrives through `export *`,
 * and importing the built JS would see values only. So the package is built
 * into a temp project and the TypeScript 7 checker is asked for each entry's
 * exports. The temp project maps `#src/*` to the built declarations: against
 * the real package.json the same specifier would resolve to `src/*.ts`.
 *
 * `typescript/unstable/async` is used because the sync client fails under Bun.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API, type Checker, SymbolFlags, type Symbol as TsSymbol } from "typescript/unstable/async";
import { byCodePoint } from "#scripts/lib/sort";

export type ApiEntryPoint = "." | "./internal";
export const ENTRY_POINTS: readonly ApiEntryPoint[] = [".", "./internal"];
const ENTRY_FILES: Readonly<Record<ApiEntryPoint, string>> = { ".": "index.d.ts", "./internal": "internal.d.ts" };

export interface ApiEntry {
  readonly name: string;
  readonly kind: "value" | "type";
}
export type ApiSurface = Readonly<Record<ApiEntryPoint, readonly ApiEntry[]>>;

/** repo-tooling owns `typescript`, so `bun x tsc` run from here is TypeScript 7 (a bare temp dir would fetch the wrong `tsc`). */
const TOOLING_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function buildDeclarations(packageDir: string, outDir: string): void {
  const proc = spawnSync(
    process.execPath,
    ["x", "tsc", "-p", join(packageDir, "tsconfig.build.json"), "--outDir", outDir],
    { cwd: TOOLING_ROOT, encoding: "utf8" },
  );
  if (proc.status !== 0) throw new Error(`tsc failed for ${packageDir}:\n${proc.stdout}${proc.stderr}`);
}

function writeProjectFiles(projectDir: string, packageDir: string): void {
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "api-surface-probe", type: "module", imports: { "#src/*": "./dist/*.d.ts" } }),
  );
  writeFileSync(
    join(projectDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "nodenext",
        moduleResolution: "nodenext",
        noEmit: true,
        skipLibCheck: false,
        allowImportingTsExtensions: true,
        types: ["node"],
      },
      files: ENTRY_POINTS.map((e) => `dist/${ENTRY_FILES[e]}`),
    }),
  );
  const modules = join(packageDir, "node_modules");
  if (existsSync(modules)) symlinkSync(modules, join(projectDir, "node_modules"));
}

async function kindOf(checker: Checker, symbol: TsSymbol): Promise<ApiEntry["kind"]> {
  const target = symbol.flags & SymbolFlags.Alias ? await checker.getAliasedSymbol(symbol) : symbol;
  return target.flags & SymbolFlags.Value ? "value" : "type";
}

/** The exports of each entry of an already-built project. Fails on any diagnostic inside its `dist/`. */
export async function extractApiSurface(projectDir: string): Promise<ApiSurface> {
  const root = realpathSync(projectDir);
  const api = new API({ cwd: root });
  try {
    const snapshot = await api.updateSnapshot({ openProject: join(root, "tsconfig.json") });
    const project = snapshot.getProjects()[0];
    if (project === undefined) throw new Error(`no TypeScript project opened in ${root}`);
    const own = (await project.program.getSemanticDiagnostics()).filter((d) =>
      d.fileName?.startsWith(join(root, "dist")),
    );
    if (own.length > 0) {
      const lines = own.slice(0, 5).map((d) => `${d.fileName}: TS${d.code} ${d.text}`);
      throw new Error(
        `the built declarations do not type-check, so the API cannot be read reliably:\n${lines.join("\n")}`,
      );
    }
    const out: Partial<Record<ApiEntryPoint, ApiEntry[]>> = {};
    for (const entry of ENTRY_POINTS) {
      const file = join(root, "dist", ENTRY_FILES[entry]);
      const sourceFile = await project.program.getSourceFile(file);
      const moduleSymbol = sourceFile && (await project.checker.getSymbolAtLocation(sourceFile));
      if (moduleSymbol === undefined) throw new Error(`${file} is missing or exports nothing`);
      const entries: ApiEntry[] = [];
      for (const symbol of await project.checker.getExportsOfModule(moduleSymbol)) {
        entries.push({ name: symbol.name, kind: await kindOf(project.checker, symbol) });
      }
      out[entry] = entries.sort((a, b) => byCodePoint(a.name, b.name));
    }
    return out as ApiSurface;
  } finally {
    await api.close();
  }
}

/** Builds `packageDir` into a temp project, reads its surface, and always removes the temp project. */
export async function extractPackageSurface(packageDir: string): Promise<ApiSurface> {
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "api-surface-")));
  try {
    buildDeclarations(packageDir, join(projectDir, "dist"));
    writeProjectFiles(projectDir, packageDir);
    return await extractApiSurface(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

export function renderSnapshot(packageName: string, surface: ApiSurface): string {
  const lines = [
    `# ${packageName} public API. Generated by \`bun run api:update\`; do not edit by hand.`,
    "# One line per exported name, sorted by code point. `type ` marks a name with no runtime value.",
  ];
  for (const entry of ENTRY_POINTS) {
    const sorted = [...surface[entry]].sort((a, b) => byCodePoint(a.name, b.name));
    lines.push("", `[${entry}]`, ...sorted.map((e) => (e.kind === "type" ? `type ${e.name}` : e.name)));
  }
  return `${lines.join("\n")}\n`;
}

/** `[section] line` for every entry line, in file order. */
function sectionedLines(text: string): string[] {
  let section = "";
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) section = line;
    else out.push(`${section} ${line}`);
  }
  return out;
}

export function diffSnapshots(committed: string, actual: string): { added: string[]; removed: string[] } {
  const before = new Set(sectionedLines(committed));
  const after = new Set(sectionedLines(actual));
  return {
    added: [...after].filter((l) => !before.has(l)).sort(byCodePoint),
    removed: [...before].filter((l) => !after.has(l)).sort(byCodePoint),
  };
}

/** `_` names are test seams and reset hooks: they belong on `./internal`, never on `.`. */
export function privateNamesOnPublicEntry(surface: ApiSurface): string[] {
  return surface["."]
    .filter((e) => e.name.startsWith("_"))
    .map((e) => e.name)
    .sort(byCodePoint);
}

function packageNameOf(packageDir: string): string {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { name?: string };
  if (typeof pkg.name !== "string") throw new Error(`${packageDir}/package.json has no name`);
  return pkg.name;
}

export function snapshotPathFor(packageDir: string): string {
  const unscoped = packageNameOf(packageDir).replace(/^@[^/]+\//, "");
  return join(packageDir, "api", `${unscoped}.api.txt`);
}

export interface ApiCheckResult {
  readonly ok: boolean;
  readonly messages: string[];
}

export async function checkApiSnapshot(packageDir: string, options: { update: boolean }): Promise<ApiCheckResult> {
  const surface = await extractPackageSurface(packageDir);
  const leaked = privateNamesOnPublicEntry(surface);
  if (leaked.length > 0) {
    return {
      ok: false,
      messages: [
        `The public entry "." exports ${leaked.length} "_" name(s): ${leaked.join(", ")}`,
        'Test seams and reset hooks belong on "./internal". Move them there; the snapshot is not updated.',
      ],
    };
  }
  const actual = renderSnapshot(packageNameOf(packageDir), surface);
  const path = snapshotPathFor(packageDir);
  if (options.update) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
    return {
      ok: true,
      messages: [
        `check-api-snapshot: wrote ${path} (${surface["."].length} on ".", ${surface["./internal"].length} on "./internal")`,
      ],
    };
  }
  if (!existsSync(path)) {
    return { ok: false, messages: [`${path} does not exist. Run \`bun run api:update\` and commit the file.`] };
  }
  const committed = readFileSync(path, "utf8");
  if (committed === actual) return { ok: true, messages: ["check-api-snapshot: clean"] };
  const { added, removed } = diffSnapshots(committed, actual);
  return {
    ok: false,
    messages: [
      "The built public API differs from the committed snapshot:",
      ...removed.map((l) => `  - ${l}`),
      ...added.map((l) => `  + ${l}`),
      "If the change is intended, run `bun run api:update` and commit the file.",
    ],
  };
}
