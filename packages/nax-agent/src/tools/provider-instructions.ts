/**
 * The `## MCP servers` section (#2517): what each MCP server said about itself
 * in its `initialize` result, rendered as one block of system prompt text.
 *
 * Those instructions come from an external process, exactly like a `discovered`
 * provider tool's description, so they are the same prompt-injection surface and
 * get the same first treatment: control characters are stripped, not trusted
 * (`provider-sanitize.ts`). Line breaks and tabs are kept, because instructions
 * are prose and a tab or a list break is formatting the server meant to send.
 *
 * They are then capped twice. Per server, so one verbose server cannot crowd its
 * neighbours out of the section. In total, so the section's context cost stays
 * bounded on every hop — the tax nax#1991's context-burn report is about. A cut
 * per-server text says so with `…(truncated)`; a server that does not fit the
 * total is dropped whole and the section says how many were (a half-rendered
 * set of instructions is worse than one that admits it is incomplete).
 */

/** One server's instructions as the provider reported them. */
type ProviderInstructionEntry = { readonly providerId: string; readonly text: string };

export const MCP_INSTRUCTIONS_MAX_CHARS_PER_SERVER = 2000;
export const MCP_INSTRUCTIONS_MAX_CHARS_TOTAL = 6000;

const SECTION_HEADING = "## MCP servers";
const TRUNCATION_MARKER = "…(truncated)";

// C0 controls except tab (\u0009) and newline (\u000A), plus DEL.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the point of this regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Caps text at `max` code POINTS, so a cut never splits a surrogate pair the
 * way `String.prototype.slice` would. The marker is added on top of the cap:
 * a cut text is `max` characters of content plus the note that it was cut.
 */
function capText(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max).join("")}${TRUNCATION_MARKER}`;
}

function serverBlock(entry: ProviderInstructionEntry): string {
  const text = capText(entry.text.replace(CONTROL_CHARS, ""), MCP_INSTRUCTIONS_MAX_CHARS_PER_SERVER);
  return `### ${entry.providerId}\n${text}`;
}

/**
 * The section, or `undefined` when there is nothing to say — an empty section
 * would spend prompt on a heading with no content under it.
 *
 * Per-server <= total, so the first server always fits and a non-empty input
 * always renders at least one server.
 */
export function renderProviderInstructions(entries: readonly ProviderInstructionEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const blocks: string[] = [];
  let total = 0;
  for (const entry of entries) {
    const block = serverBlock(entry);
    if (total + block.length > MCP_INSTRUCTIONS_MAX_CHARS_TOTAL) break;
    total += block.length;
    blocks.push(block);
  }
  const omitted = entries.length - blocks.length;
  const tail = omitted === 0 ? "" : `\n\n(instructions omitted for ${omitted} more MCP server(s))`;
  return [SECTION_HEADING, ...blocks].join("\n\n") + tail;
}
