/** Terminal controls, kept together so help stays useful with a large resource catalog. */
export const CHAT_KEYBOARD_HELP = [
  "Keyboard",
  "enter  send · shift+enter / alt+enter  newline",
  "pgup/pgdn  scroll · end  jump to latest",
  "ctrl+o  expand/collapse details · ctrl+g  jobs",
  "shift+tab  cycle mode · ctrl+t  cycle reasoning effort",
  "esc  close overlay or interrupt turn",
  "ctrl+c  quit when idle; interrupt when running (again to quit)",
  "ctrl+s  steer the running turn (or interrupt and send)",
].join("\n");

export function resourceHelp(commands: number, skills: number): string {
  return `${commands} commands · ${skills} skills — type / to search; /skills for details`;
}
