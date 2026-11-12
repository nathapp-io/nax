/** Terminal controls, kept together so help stays useful with a large resource catalog. */
export const CHAT_KEYBOARD_HELP = [
  "Keyboard",
  "enter  send · shift+enter / alt+enter  newline",
  "pgup/pgdn  scroll page · shift+up/down  scroll line · home/end  top/latest",
  "ctrl+o  expand/collapse details · ctrl+g  jobs",
  "shift+tab  cycle mode · ctrl+t  cycle reasoning effort",
  "ctrl+v  paste image · esc  close overlay or interrupt turn",
  "ctrl+b  move the running command to the background (ctrl+b ctrl+b in tmux)",
  "ctrl+c  quit when idle; interrupt when running (again to quit)",
  "ctrl+s  steer the running turn (or interrupt and send)",
].join("\n");

/** A count with its noun in the form the count reads as: `1 command`, `2 commands`, `0 skills`. */
function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * The catalog summary `/help` shows on a native host, or `undefined` when the catalog holds
 * nothing at all — `0 commands · 0 skills` only tells the user there was nothing to list, so
 * the caller omits the line rather than printing it.
 */
export function resourceHelp(commands: number, skills: number): string | undefined {
  if (commands === 0 && skills === 0) return undefined;
  const resources = `${counted(commands, "command", "commands")} · ${counted(skills, "skill", "skills")}`;
  return `${resources} — type / to search; /skills for details`;
}
