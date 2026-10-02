/**
 * The two nax-agent entry points (S1 spec section 4.4) and the moved test
 * helpers' barrel.
 *
 * `.` (src/index.ts) re-exports a fixed list: the session contract, the native
 * barrel, the tool, permission, sandbox and command-safety barrels, the cost
 * core and the two slots. `/internal` (src/internal.ts) re-exports exactly the
 * modules nax reaches outside that list, plus the namespaces nax spies on.
 * Both use `export *` (Bun rejects `export { T }` for a type-only T). tsc reports
 * a name two modules export differently (TS2308); EXPLICIT_REEXPORTS settles one
 * by naming its module, which beats `export *`.
 */
import { basename, dirname } from "node:path";
import { byCodePoint } from "@/utils/sort";

const PUBLIC_FILES: ReadonlySet<string> = new Set([
  "src/native/index.ts",
  "src/tools/index.ts",
  "src/permissions/index.ts",
  "src/sandbox/index.ts",
  "src/command-safety/index.ts",
  "src/cost/core/index.ts",
  "src/cost/estimate.ts",
  "src/cost/usage-math.ts",
  "src/cost/standard-types.ts",
  "src/cost/model-spec.ts",
]);
const CONTRACT_DIR = "src/session";

/** A name `export *` would make ambiguous, re-exported explicitly from the module that owns it. */
export interface ExplicitReexport {
  readonly entry: "index" | "internal";
  readonly name: string;
  readonly module: string;
  readonly typeOnly: boolean;
}

/**
 * Measured on the trial run: `session/interaction-handler` re-declares the no-op
 * handler (typed InteractionHandler) over `session/no-op-interaction-handler`'s
 * constant, so the contract directory exports the name twice.
 */
export const EXPLICIT_REEXPORTS: readonly ExplicitReexport[] = [
  {
    entry: "index",
    name: "NO_OP_INTERACTION_HANDLER",
    module: "src/session/interaction-handler.ts",
    typeOnly: false,
  },
];

/** `src/tools/index.ts` -> `#src/tools/index`; `test/helpers/temp.ts` -> `#test/helpers/temp`. */
export function packageImportSpec(agentRel: string): string {
  return `#${agentRel.replace(/\.tsx?$/, "")}`;
}

export function isPublicModule(agentRel: string): boolean {
  return PUBLIC_FILES.has(agentRel) || dirname(agentRel) === CONTRACT_DIR;
}

function camel(name: string): string {
  return name.replace(/[-_.]+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** `src/native/session/transcript-store.ts` -> `transcriptStoreModule`; an index takes its directory's name. */
export function namespaceExportName(agentRel: string): string {
  const file = basename(agentRel).replace(/\.tsx?$/, "");
  const stem = file === "index" ? basename(dirname(agentRel)) : file;
  return `${camel(stem)}Module`;
}

function explicitLines(entry: ExplicitReexport["entry"]): string[] {
  return EXPLICIT_REEXPORTS.filter((r) => r.entry === entry).map(
    (r) => `export ${r.typeOnly ? "type " : ""}{ ${r.name} } from "${packageImportSpec(r.module)}";`,
  );
}

const INDEX_HEADER = `/**
 * @nathapp/nax-agent public entry (S1 spec section 4.4): the session contract,
 * the native session adapter, the tool, permission, sandbox and command-safety
 * barrels, the cost core and the process-wide slots.
 *
 * Written by the S1-5 move script; maintained by hand from here on.
 */
`;

const INTERNAL_HEADER = `/**
 * @nathapp/nax-agent/internal: what nax reaches below the public entry -- shared
 * helpers, NaxError, deep modules and the _*Deps test seams (S1 spec section 4.4).
 * Not covered by semver. It re-exports the same module instances, so patching a
 * seam here patches the object the agent reads.
 *
 * Written by the S1-5 move script; maintained by hand from here on.
 */
`;

const SLOTS = [
  'export { configureCredentials, setAgentLogger } from "#src/infra/index";',
  'export type { AgentLogger, CredentialAuthConfig, CredentialsConfig } from "#src/infra/index";',
];

export function renderIndex(movedSources: readonly string[]): string {
  const modules = movedSources.filter(isPublicModule).sort(byCodePoint);
  const stars = modules.map((m) => `export * from "${packageImportSpec(m)}";`);
  return `${INDEX_HEADER}\n${[...stars, ...SLOTS, ...explicitLines("index")].join("\n")}\n`;
}

export function renderInternal(modules: ReadonlySet<string>, namespaces: ReadonlyMap<string, string>): string {
  const stars = [...modules].sort(byCodePoint).map((m) => `export * from "${packageImportSpec(m)}";`);
  const spaces = [...namespaces.entries()]
    .sort(([a], [b]) => byCodePoint(a, b))
    .map(([m, name]) => `export * as ${name} from "${packageImportSpec(m)}";`);
  return `${INTERNAL_HEADER}\n${[...stars, ...spaces, ...explicitLines("internal")].join("\n")}\n`;
}

/** Fails when two modules would share one namespace export name. */
export function assertDistinctNamespaces(namespaces: ReadonlyMap<string, string>): string[] {
  const owner = new Map<string, string>();
  const errors: string[] = [];
  for (const [module, name] of namespaces) {
    const other = owner.get(name);
    if (other !== undefined) errors.push(`namespace export ${name} would name both ${other} and ${module}`);
    owner.set(name, module);
  }
  return errors;
}

const BARREL_STATEMENT = /^export\s*(?:type\s*)?\{[^}]*\}\s*from\s*["']\.\/([^"']+)["'];?$/gm;

/** The moved helpers' barrel: nax's barrel statements whose module moved, unchanged. */
export function renderHelperBarrel(naxBarrel: string, movedHelpers: readonly string[]): string {
  const moved = new Set(movedHelpers.map((h) => basename(h).replace(/\.tsx?$/, "")));
  const lines = [...naxBarrel.matchAll(BARREL_STATEMENT)].filter((m) => moved.has(m[1] ?? "")).map((m) => m[0]);
  return `/** Barrel for nax-agent's test helpers (moved from packages/nax/test/helpers by S1-5). */\n\n${lines.join("\n")}\n`;
}

/** nax's shim at a moved helper's old path: its own tests and barrel keep importing it there. */
export function renderHelperShim(helperRel: string): string {
  const name = helperRel.replace(/^test\//, "").replace(/\.tsx?$/, "");
  return `/** Moved to @nathapp/nax-agent by S1-5; nax keeps this path for its own tests. */\nexport * from "@nathapp/nax-agent/test/${name}";\n`;
}
