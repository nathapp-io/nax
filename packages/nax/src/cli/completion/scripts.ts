/**
 * Shell completion scripts — the text `nax completion <shell>` prints.
 *
 * Each script is a thin transport: it forwards the words after `nax` through the
 * cursor to the hidden `nax __complete -- ...` protocol, reads one candidate per
 * line on stdout, and hands them to the shell. Discovery lives in `engine.ts`
 * (US-002); nothing here decides what a candidate is.
 *
 * Two details carry the contract:
 *
 * - nax's stderr is discarded (`2>/dev/null`), so a Tab press never prints a
 *   warning into the user's prompt.
 * - Candidates are read one line at a time rather than via `COMPREPLY=($(...))`
 *   or a word split, so a candidate is never glob-expanded or re-split.
 *
 * The scripts complete only the command name `nax`; they never touch the user's
 * `~/.bashrc` or `~/.zshrc` — the user adds the `eval` line by hand.
 */

/** Shells `completionScript` can render. */
export const SUPPORTED_SHELLS: readonly ["bash", "zsh"] = ["bash", "zsh"];

/** One of {@link SUPPORTED_SHELLS}. */
export type CompletionShell = (typeof SUPPORTED_SHELLS)[number];

/**
 * bash 3.2 (what macOS ships) has no `mapfile`, so the reply is drained with a
 * `while read` loop over a process substitution; the empty-line check keeps a
 * trailing newline from becoming a candidate. `-o default` makes an empty
 * COMPREPLY fall back to the shell's own file completion.
 */
const BASH_SCRIPT = `_nax_complete() {
  local line
  COMPREPLY=()
  while IFS= read -r line; do
    [[ -n $line ]] && COMPREPLY+=("$line")
  done < <(nax __complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)
}
complete -o default -F _nax_complete nax
`;

/**
 * zsh splits the reply on newlines itself (`(@f)`), drops the empty fields a
 * trailing newline leaves behind, and passes the rest to `compadd` without `-Q`
 * so zsh quotes whatever it inserts. With no candidates it calls `_files`.
 *
 * `compinit` is never loaded here — it would write `~/.zcompdump`. Without
 * `compdef` the script prints a one-line hint instead.
 */
const ZSH_SCRIPT = `_nax() {
  local -a candidates
  candidates=("\${(@f)$(nax __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  candidates=(\${candidates:#})
  if (( \${#candidates} )); then compadd -- "\${candidates[@]}"; else _files; fi
}
if (( $+functions[compdef] )); then
  compdef _nax nax
else
  print -u2 "nax completion: add 'autoload -Uz compinit && compinit' before this line in ~/.zshrc"
fi
`;

/**
 * The completion script for `shell`.
 *
 * @param shell - a shell in {@link SUPPORTED_SHELLS}
 * @returns the script text, ready to `eval`
 */
export function completionScript(shell: CompletionShell): string {
  return shell === "bash" ? BASH_SCRIPT : ZSH_SCRIPT;
}
