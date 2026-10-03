/**
 * Does a module export `name` ONLY through type-only routes?
 *
 * A re-export such as `export type { K } from "./a.ts"` hands consumers a type
 * even when `K` is a class: there is no runtime binding on that entry, and a JS
 * consumer gets `undefined`. The checker's alias target still carries the
 * class's value flags, so the flags alone cannot tell. This walks the module's
 * own export statements instead, following named re-exports and `export *`
 * through intermediate modules, and honours `export type { … }`,
 * `export { type X }`, `export type * from` and `export type * as ns`.
 *
 * It answers only "is every route to this name type-only?". A name declared
 * directly in the module (no re-export statement provides it) is never blocked.
 */

import { type ExportDeclaration, type SourceFile, SyntaxKind } from "typescript/unstable/ast";
import type { Checker, Project, Symbol as TsSymbol } from "typescript/unstable/async";

export class TypeOnlyExports {
  private readonly checker: Checker;
  private readonly files = new Map<number, Promise<SourceFile | undefined>>();
  private readonly names = new Map<number, Promise<Set<string>>>();

  constructor(project: Project) {
    this.checker = project.checker;
  }

  private sourceFileOf(moduleSymbol: TsSymbol): Promise<SourceFile | undefined> {
    let file = this.files.get(moduleSymbol.id);
    if (file === undefined) {
      file = (async () => {
        const node = await moduleSymbol.declarations[0]?.resolve();
        return node?.kind === SyntaxKind.SourceFile ? (node as SourceFile) : undefined;
      })();
      this.files.set(moduleSymbol.id, file);
    }
    return file;
  }

  private exportedNames(moduleSymbol: TsSymbol): Promise<Set<string>> {
    let names = this.names.get(moduleSymbol.id);
    if (names === undefined) {
      names = this.checker.getExportsOfModule(moduleSymbol).then((list) => new Set(list.map((s) => s.name)));
      this.names.set(moduleSymbol.id, names);
    }
    return names;
  }

  private async targetOf(statement: ExportDeclaration): Promise<TsSymbol | undefined> {
    const spec = statement.moduleSpecifier;
    return spec === undefined ? undefined : this.checker.getSymbolAtLocation(spec);
  }

  /** True when `name` is exported by `moduleSymbol` and every route to it is type-only. */
  async onlyTypeRoutes(moduleSymbol: TsSymbol, name: string): Promise<boolean> {
    const file = await this.sourceFileOf(moduleSymbol);
    if (file === undefined) return false;
    let provided = false;
    for (const statement of file.statements) {
      if (statement.kind !== SyntaxKind.ExportDeclaration) continue;
      const decl = statement as ExportDeclaration;
      const route = await this.routeFor(decl, name);
      if (route === undefined) continue;
      provided = true;
      if (decl.isTypeOnly || route.typeOnly) continue;
      if (route.target === undefined) return false;
      if (!(await this.onlyTypeRoutes(route.target, route.name))) return false;
    }
    return provided;
  }

  /** How `decl` provides `name`, or undefined when it does not. */
  private async routeFor(
    decl: ExportDeclaration,
    name: string,
  ): Promise<{ typeOnly: boolean; target: TsSymbol | undefined; name: string } | undefined> {
    const clause = decl.exportClause;
    if (clause === undefined) {
      const target = await this.targetOf(decl);
      if (target === undefined || !(await this.exportedNames(target)).has(name)) return undefined;
      return { typeOnly: false, target, name };
    }
    if (clause.kind === SyntaxKind.NamespaceExport) {
      return clause.name.text === name ? { typeOnly: false, target: undefined, name } : undefined;
    }
    for (const element of clause.elements) {
      if (element.name.text !== name) continue;
      return {
        typeOnly: element.isTypeOnly,
        target: await this.targetOf(decl),
        name: element.propertyName?.text ?? name,
      };
    }
    return undefined;
  }
}
