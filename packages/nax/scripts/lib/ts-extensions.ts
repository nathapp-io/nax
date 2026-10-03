/**
 * S2-6 codemod core: give every relative specifier in nax-agent's src/ an
 * explicit `.ts` path (a file -> `x.ts`, a directory -> `x/index.ts`) so tsc's
 * nodenext build emits Node-loadable `./x.js`. One-shot: retired once S2-6
 * lands; from then on the build's TS2835/TS2834 errors keep imports explicit.
 */
import { dirname, join, resolve } from "node:path";
import { rewriteSpecifiers } from "./import-specifiers";

function isRelative(spec: string): boolean {
  return spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
}

/** `.`, `..` and a trailing `/` name a directory; they never resolve to a sibling file. */
function isDirectoryOnly(spec: string): boolean {
  return spec === "." || spec === ".." || spec.endsWith("/");
}

/**
 * The explicit form of one specifier, or `null` to leave it unchanged (not
 * relative, or already naming a file). A file beats a same-named directory,
 * matching bundler resolution. Throws when neither exists.
 */
export function explicitTsSpecifier(spec: string, fromFile: string, isFile: (abs: string) => boolean): string | null {
  if (!isRelative(spec)) return null;
  const base = resolve(dirname(fromFile), spec);
  if (isFile(base)) return null;
  const stem = spec.replace(/\/+$/, "");
  if (!isDirectoryOnly(spec) && isFile(`${base}.ts`)) return `${stem}.ts`;
  if (isFile(join(base, "index.ts"))) return `${stem}/index.ts`;
  throw new Error(`${fromFile}: cannot resolve "${spec}" to a .ts file or a directory index.ts`);
}

export function rewriteTsExtensions(
  source: string,
  fromFile: string,
  isFile: (abs: string) => boolean,
): { source: string; rewritten: number } {
  let rewritten = 0;
  const out = rewriteSpecifiers(source, (site) => {
    const next = explicitTsSpecifier(site.spec, fromFile, isFile);
    if (next !== null) rewritten += 1;
    return next;
  });
  return { source: out, rewritten };
}
