/** Terminal login UI shared by `nax auth login` and `nax-agent login` (S5-4 M-28). */
export { createTerminalAuthInteraction, type TerminalAuthOptions } from "./interaction.ts";
export { _openUrlDeps, openUrl, spawnDetached } from "./open-url.ts";
export {
  _terminalPromptDeps,
  PLAIN_STYLE,
  PromptCancelledError,
  type PromptStdin,
  promptForLine,
  promptForSecret,
  promptForSelect,
  type SelectChoice,
  type TerminalStyle,
} from "./prompt.ts";
