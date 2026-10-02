/**
 * Specifier rewrites for the S1-5 move.
 *
 * Moved files: a specifier that reached another moved file keeps its text when
 * the relative path between the two is unchanged; otherwise it becomes
 * `#src/<path>` or `#test/<path>` (package `imports`, which do no index
 * resolution, so an index module keeps its `/index`). A specifier that reaches
 * a file staying in nax is an error: the boundary would break.
 *
 * Staying files: a specifier that reached a moved source becomes
 * `@nathapp/nax-agent` when the module is part of the public entry and the
 * statement imports no `_` seam, otherwise `@nathapp/nax-agent/internal`. A
 * namespace import becomes a named import of the module's namespace, which the
 * internal entry re-exports with `export * as`, so spies still patch the real
 * module. Helpers that moved keep a shim at their old path, so specifiers that
 * reach them stay as they are.
 */
import { dirname, posix } from "node:path";
import { rewriteSpecifiers, type SiteRewrite, type SpecifierSite } from "../import-specifiers";
import { isPublicModule, namespaceExportName, packageImportSpec } from "./entries";
import { isLocalSpecifier, resolveInPackage } from "./resolve";

export const PUBLIC_ENTRY = "@nathapp/nax-agent";
export const INTERNAL_ENTRY = "@nathapp/nax-agent/internal";

/** nax-relative path -> nax-agent-relative destination, for every moved file. */
export type Destinations = ReadonlyMap<string, string>;

/** What the staying files need from the internal entry. Filled while rewriting. */
export interface InternalNeeds {
  readonly modules: Set<string>;
  readonly namespaces: Map<string, string>;
}

export interface RewriteResult {
  readonly text: string;
  readonly errors: readonly string[];
}

function withoutExtension(path: string): string {
  return path.replace(/\.tsx?$/, "");
}

function relativeSpec(fromFile: string, toFile: string): string {
  const rel = posix.relative(dirname(fromFile), withoutExtension(toFile));
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function movedSpec(fromRel: string, targetRel: string, site: SpecifierSite, dest: Destinations): string {
  const newFrom = dest.get(fromRel) ?? fromRel;
  const newTarget = dest.get(targetRel) ?? targetRel;
  const keepsRelation = relativeSpec(fromRel, targetRel) === relativeSpec(newFrom, newTarget);
  if (site.spec.startsWith(".") && keepsRelation) return site.spec;
  return packageImportSpec(newTarget);
}

export function rewriteMovedFile(naxRoot: string, fromRel: string, source: string, dest: Destinations): RewriteResult {
  const errors: string[] = [];
  const text = rewriteSpecifiers(source, (site) => {
    if (!isLocalSpecifier(site.spec)) return null;
    const target = resolveInPackage(naxRoot, fromRel, site.spec);
    if (target === null) {
      errors.push(`${fromRel}: cannot resolve "${site.spec}"`);
      return null;
    }
    if (!dest.has(target)) {
      errors.push(`${fromRel}: "${site.spec}" reaches ${target}, which stays in nax`);
      return null;
    }
    return movedSpec(fromRel, target, site, dest);
  });
  return { text, errors };
}

const NAMESPACE_IMPORT = /^\s*import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s*$/;
const STAR_EXPORT = /^\s*export\s+\*/;

function importsSeam(prelude: string): boolean {
  const clause = prelude.match(/\{([^}]*)\}/)?.[1] ?? "";
  return /(?:^|[\s,{])(?:type\s+)?_[A-Za-z0-9_$]/.test(` ${clause}`);
}

function stayingRewrite(site: SpecifierSite, agentRel: string, needs: InternalNeeds, errors: string[]): SiteRewrite {
  const namespace = site.prelude.match(NAMESPACE_IMPORT);
  if (namespace !== null) {
    const exported = namespaceExportName(agentRel);
    needs.namespaces.set(agentRel, exported);
    const local = namespace[1] ?? exported;
    const binding = local === exported ? exported : `${exported} as ${local}`;
    return { statement: `import { ${binding} } from "${INTERNAL_ENTRY}"` };
  }
  if (STAR_EXPORT.test(site.prelude)) {
    errors.push(`export * from "${site.spec}" re-exports a moved module wholesale; list the names first`);
    return null;
  }
  if (isPublicModule(agentRel) && !importsSeam(site.prelude)) return PUBLIC_ENTRY;
  needs.modules.add(agentRel);
  return INTERNAL_ENTRY;
}

export function rewriteStayingFile(
  naxRoot: string,
  fromRel: string,
  source: string,
  dest: Destinations,
  needs: InternalNeeds,
): RewriteResult {
  const errors: string[] = [];
  const text = rewriteSpecifiers(source, (site) => {
    if (!isLocalSpecifier(site.spec)) return null;
    const target = resolveInPackage(naxRoot, fromRel, site.spec);
    if (target === null || !target.startsWith("src/")) return null;
    const agentRel = dest.get(target);
    if (agentRel === undefined) return null;
    return stayingRewrite(site, agentRel, needs, errors);
  });
  return { text, errors: errors.map((e) => `${fromRel}: ${e}`) };
}
