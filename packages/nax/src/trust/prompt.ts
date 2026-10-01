/**
 * The three-way trust prompt (US-002).
 *
 * `[p]arent` exists because trust attaches to a folder and covers everything
 * beneath it (design R-2): answering `p` for `<workspace>/repo` trusts
 * `<workspace>`, which covers repositories cloned there later. It is offered
 * only when there is a parent to trust -- `null` means the caller refused one
 * (a protected folder, or the root of the filesystem), and then `p` means no.
 *
 * The default is No. `promptForConfirmation` defaults to yes and offers two
 * choices, so it cannot express this question.
 */

import type { TrustChoice } from "./types";

/** The invariant half of the question, between the root and the choices. */
const CONSEQUENCE = "? nax will run this project's plugins, hooks, MCP servers and test commands.";

/**
 * Injectable seam for reading one answer. The production `ask` writes the
 * question to stderr -- never stdout, which the gate's callers may be piping --
 * and reads one line from stdin.
 */
export const _trustPromptDeps: { ask: (question: string) => Promise<string | null> } = {
  ask: async (question) => {
    process.stderr.write(question);
    return readStdinLine();
  },
};

/**
 * Ask whether `root` may be trusted, returning the operator's choice.
 *
 * `parent` is the folder to offer as the `[p]arent` answer, or `null` when the
 * caller decided no parent may be trusted.
 */
export async function promptTrustChoice(root: string, parent: string | null): Promise<TrustChoice> {
  const choices = parent === null ? "[y]es / [N]o " : `[y]es / [p]arent (${parent}) / [N]o `;
  const answer = (await _trustPromptDeps.ask(`Trust ${root}${CONSEQUENCE} ${choices}`))?.trim().toLowerCase() ?? "";
  if (answer === "y" || answer === "yes") return "yes";
  // An unoffered parent choice is not consent to the parent: refuse, do not guess.
  if (parent !== null && (answer === "p" || answer === "parent")) return "parent";
  return "no";
}

/** One line from stdin without its terminator, or `null` at end of input. */
async function readStdinLine(): Promise<string | null> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    const newline = buffer.indexOf("\n");
    if (newline !== -1) return stripCarriageReturn(buffer.slice(0, newline));
  }
  buffer += decoder.decode();
  return buffer === "" ? null : stripCarriageReturn(buffer);
}

/** A CRLF terminal sends `\r` before `\n`; the answer is the text before both. */
function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
