export type ResourceFrontmatterResult = { data: Record<string, unknown>; body: string } | { error: string };

/** Read Claude's permissive key/value dialect only when strict YAML rejects it. */
function readFallback(block: string): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    entries.push([key, value === "true" ? true : value === "false" ? false : value]);
  }
  return Object.fromEntries(entries);
}

/** Parse leading resource metadata, preserving the body verbatim after the closing line. */
export function readResourceFrontmatter(text: string): ResourceFrontmatterResult {
  const opening = /^---(?:\r?\n|$)/.exec(text);
  if (!opening) return { data: {}, body: text };
  const rest = text.slice(opening[0].length);
  const closing = /^---(?:\r?\n|$)/m.exec(rest);
  if (!closing) return { error: "[resources] Frontmatter has no closing --- line" };
  const block = rest.slice(0, closing.index);
  const body = rest.slice(closing.index + closing[0].length);
  let data: unknown;
  try {
    data = Bun.YAML.parse(block);
  } catch {
    // Claude Code accepts descriptions containing unquoted colons that strict YAML rejects.
    return { data: readFallback(block), body };
  }
  if (data == null) return { data: {}, body };
  if (typeof data !== "object" || Array.isArray(data)) {
    return { error: "[resources] Frontmatter must be a YAML object" };
  }
  return { data: data as Record<string, unknown>, body };
}
