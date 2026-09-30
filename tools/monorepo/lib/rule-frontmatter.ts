// tools/monorepo/lib/rule-frontmatter.ts
/** Spec §6.1: prefix appliesTo with the package dir and add a package `paths:` filter. */
export function rewriteRuleFrontmatter(text: string, pkgDir: string): string {
  const lines = text.split("\n");
  if (lines[0] !== "---") throw new Error("rewriteRuleFrontmatter: no frontmatter");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("rewriteRuleFrontmatter: no frontmatter");
  const fm = lines.slice(1, end);
  if (fm.some((l) => /^paths:/.test(l))) throw new Error("rewriteRuleFrontmatter: rule already declares paths:");
  const appliesIdx = fm.findIndex((l) => /^appliesTo:/.test(l));
  if (appliesIdx === -1) throw new Error("rewriteRuleFrontmatter: no appliesTo");

  const prefix = `${pkgDir}/`;
  let inApplies = false;
  const rewritten = fm.map((line) => {
    if (/^\S/.test(line)) inApplies = /^appliesTo:/.test(line);
    const m = inApplies ? /^(\s+-\s+)"([^"]+)"\s*$/.exec(line) : null;
    if (!m) return line;
    const value = m[2] as string;
    return value.startsWith(prefix) ? line : `${m[1]}"${prefix}${value}"`;
  });

  const pathsBlock = ["paths:", `  - "${pkgDir}/*"`];
  const priorityIdx = rewritten.findIndex((l) => /^priority:/.test(l));
  const insertAt = priorityIdx === -1 ? 0 : priorityIdx + 1;
  const withPaths = [...rewritten.slice(0, insertAt), ...pathsBlock, ...rewritten.slice(insertAt)];
  return [lines[0], ...withPaths, ...lines.slice(end)].join("\n");
}
