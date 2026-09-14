/**
 * Name the tool that serves the intent behind a denied call.
 *
 * `policy.ts` already names the granted argv FORMS, which is the right answer
 * when the model wanted a different install. It is the wrong answer when the
 * model wanted `git status`: across three runs, 8 of 32 denied argv calls were
 * for capabilities the session already held as a first-class tool (nax#1937).
 *
 * Lives here rather than in policy.ts because the policy knows the grants but
 * not which tools were ADVERTISED to this session. Naming a tool the session
 * never received would reproduce the defect this exists to fix, so every row
 * is gated on the caller's `available` set.
 *
 * ONE table answers both entry points. There used to be two -- one for argv
 * command lines, one for bare verbs -- covering disjoint command sets, while
 * `redirectForVerb` routed anything multi-token into the argv table. So which
 * table answered depended on whether the model typed a flag, and coverage came
 * out inverted: `ls -la` redirected but `ls` did not, `grep` redirected but
 * `grep -n x y` did not. 20 of 34 denials in the two runs after #1971 carried
 * no redirect (nax#1999). A single table cannot drift against itself.
 */

const GIT_READ_VERBS = new Set(["diff", "log", "show", "status", "blame"]);

/**
 * Git verbs that stage or record a commit. Deliberately NOT every write verb:
 * `git restore` reverts, which `GitCommit` does not do, and naming it would be
 * the same defect as naming a tool the session never received.
 */
const GIT_COMMIT_VERBS = new Set(["add", "commit"]);

/**
 * Git verbs that revert tracked paths. Checked separately from the intent
 * table: when the paths are nax's own `.nax/` run state, no tool serves the
 * intent, so the refusal teaches instead of naming one (nax#2007).
 */
const GIT_REVERT_VERBS = new Set(["checkout", "restore"]);

const NAX_OWNED_RUN_STATE_EXPLANATION =
  "`.nax/` is nax's own run state, written by the harness during this run. It is not part of your diff and must not be reverted.";

/**
 * The sentence explaining a revert of nax's own run state, or undefined.
 *
 * Deliberately NOT an `Intent`: `render()` wraps every hit as "this session
 * already has `X`", which is false here -- no tool reverts `.nax/`, and the
 * module's header forbids naming one it does not hold. So this predicate is
 * checked BEFORE `intentFor` in both entry points and returns its own sentence.
 *
 * Verb scope is `checkout` and `restore` only; `git stash` is the agent's own
 * WIP, not nax's state, and has no operands to gate on. The gate is a `.nax`
 * path SEGMENT (split on `/`), never a substring, so `src/nax-helpers.ts` and
 * `docs/.naxignore` stay unanswered. `--` is a separator, not an operand, and a
 * `timeout N` wrapper is stripped the same way `intentFor` strips it.
 */
function naxOwnedRunStateExplanation(tokens: readonly string[]): string | undefined {
  const av = withoutTimeoutPrefix(tokens);
  const hasGitPrefix = av[0] === "git";
  const verb = hasGitPrefix ? av[1] : av[0];
  if (verb === undefined || !GIT_REVERT_VERBS.has(verb)) return undefined;
  for (const operand of av.slice(hasGitPrefix ? 2 : 1)) {
    if (operand === "--") continue;
    if (operand.split("/").includes(".nax")) return NAX_OWNED_RUN_STATE_EXPLANATION;
  }
  return undefined;
}

interface Intent {
  readonly tool: string;
  readonly how: string;
}

const GLOB: Intent = { tool: "Glob", how: "Glob lists repository paths by pattern" };
const GREP: Intent = { tool: "Grep", how: "Grep searches file contents" };
const READ: Intent = { tool: "Read", how: "Read returns file contents, by line range with offset/limit" };
const DELETE: Intent = { tool: "Delete", how: "Delete removes one tracked file at a time" };
const GIT: Intent = { tool: "Git", how: `Git runs read-only git (${[...GIT_READ_VERBS].join(", ")})` };
const GIT_COMMIT: Intent = {
  tool: "GitCommit",
  how: "GitCommit stages and commits named files -- supply `message` and a `paths` array",
};
const TEST_SCOPED: Intent = {
  tool: "RunCommand:testScoped",
  how: 'RunCommand {"command":"testScoped"} runs the project test command on named files',
};
const BASH: Intent = {
  tool: "Bash",
  how: "Bash runs one shell command string, when a Bash(...) allow rule covers every segment of it",
};

/**
 * Commands whose intent the HEAD token alone decides.
 *
 * `rm` and `git` are absent on purpose: their intent is decided by the SECOND
 * token (`rm a.ts` is a Delete, `rm -r dir` is nothing Delete can do; `git log`
 * is Git, `git add` is GitCommit), so they are resolved by shape below.
 */
const HEAD_INTENTS: ReadonlyMap<string, Intent> = new Map<string, Intent>([
  ["ls", GLOB],
  ["find", GLOB],
  ["grep", GREP],
  ["cat", READ],
  ["bash", BASH],
  ["sh", BASH],
  ["zsh", BASH],
  // No tool counts lines, and Read with no offset/limit returns a byte-bounded
  // PREFIX -- so counting what it returns under-reports exactly the large files
  // the question gets asked about. Naming Read beats a bare refusal the model
  // retries verbatim, but only if the ceiling is stated rather than implied.
  ["wc", { tool: "Read", how: "Read returns file contents, truncated past a size ceiling -- no tool counts lines" }],
  ["git", GIT],
  ...[...GIT_READ_VERBS].map((verb) => [verb, GIT] as const),
  // `git.ts` declares `allowedVerbs: GIT_READ_VERBS`, so every Git verb-slot
  // denial carries a write verb and arrives BARE -- `commit`, never
  // `git commit`. Reaching these only through the shape branch below would
  // leave the row unreachable from the one slot Git denials come through.
  // Safe as head tokens: `add` is an install verb only in TASK_RUNNERS
  // position (`bun add`), where the head is the runner, not `add`.
  ...[...GIT_COMMIT_VERBS].map((verb) => [verb, GIT_COMMIT] as const),
]);

/** Task-runner binaries. A detection heuristic ONLY: what gets named comes
 * entirely from the project's declared commands, never from this list. A runner
 * missing here degrades to the pre-#1971 message rather than to a wrong one.
 */
const TASK_RUNNERS = new Set([
  "bun",
  "npm",
  "pnpm",
  "yarn",
  "deno",
  "npx",
  "make",
  "just",
  "task",
  "go",
  "cargo",
  "uv",
  "poetry",
  "pipenv",
  "tox",
  "gradle",
  "mvn",
]);

/**
 * Install subcommands. These runners double as package managers, and an install
 * attempt wants the granted install FORMS policy.ts already printed -- not a
 * list of project gates that cannot install anything.
 */
const INSTALL_VERBS = new Set(["add", "install", "i", "ci", "get", "sync", "fetch", "mod", "download"]);

function isSingleFileDelete(tokens: readonly string[], from: number): boolean {
  return tokens.length === from + 1 && !tokens[from]?.startsWith("-");
}

/** A `timeout N ...` prefix wraps the real command; look past it. */
function withoutTimeoutPrefix(tokens: readonly string[]): readonly string[] {
  return tokens[0] === "timeout" ? tokens.slice(2) : tokens;
}

/**
 * The one intent table. Shape-dependent heads are resolved first, then the
 * head-only map -- so a bare verb and the same verb with arguments can never
 * be answered differently.
 */
function intentFor(tokens: readonly string[]): Intent | undefined {
  const av = withoutTimeoutPrefix(tokens);
  const [head, second] = av;
  if (head === undefined) return undefined;

  if (head === "rm") return isSingleFileDelete(av, 1) ? DELETE : undefined;
  if (head === "git" && second !== undefined) {
    if (second === "rm") return isSingleFileDelete(av, 2) ? DELETE : undefined;
    if (GIT_READ_VERBS.has(second)) return GIT;
    if (GIT_COMMIT_VERBS.has(second)) return GIT_COMMIT;
    return undefined;
  }
  if (head === "bun" && second === "test") return TEST_SCOPED;

  return HEAD_INTENTS.get(head);
}

/**
 * Name the gates this project declared, for a model that reached for a task
 * runner and wanted to run one of them. What gets named comes from the
 * project's declared commands, never from a hardcoded list (nax#1971).
 */
function taskRunnerFallback(
  tokens: readonly string[],
  available: ReadonlySet<string>,
  declaredCommands: ReadonlySet<string>,
): string | undefined {
  const av = withoutTimeoutPrefix(tokens);
  const head = av[0];
  if (head === undefined || !TASK_RUNNERS.has(head)) return undefined;
  const sub = av[1];
  if (sub !== undefined && INSTALL_VERBS.has(sub)) return undefined;
  if (!available.has("RunCommand") || declaredCommands.size === 0) return undefined;
  return `this session already has RunCommand with declared commands: ${[...declaredCommands].join(", ")}`;
}

function render(
  hit: Intent,
  available: ReadonlySet<string>,
  declaredCommands: ReadonlySet<string>,
): string | undefined {
  if (hit.tool === TEST_SCOPED.tool) {
    // Conditioned on the project actually declaring the command, not hardcoded:
    // naming a command this project never declared is the same defect again.
    if (!available.has("RunCommand") || !declaredCommands.has("testScoped")) return undefined;
    return `this session already has ${hit.how}`;
  }
  if (!available.has(hit.tool)) return undefined;
  return `this session already has \`${hit.tool}\` -- ${hit.how}`;
}

export function redirectForArgv(
  argv: readonly string[],
  available: ReadonlySet<string>,
  declaredCommands: ReadonlySet<string>,
): string | undefined {
  const ownedRunState = naxOwnedRunStateExplanation(argv);
  if (ownedRunState !== undefined) return ownedRunState;
  const hit = intentFor(argv);
  if (hit === undefined) return taskRunnerFallback(argv, available, declaredCommands);
  return render(hit, available, declaredCommands);
}

/**
 * Name the tool that serves the intent behind a denied Bash COMMAND.
 *
 * Reads the first segment only: that is what the model reached for, and a
 * later segment's intent is not what to teach when the call is refused. The
 * split is deliberately its own crude one rather than the lexer's
 * (`lexBashCommand`): a command REFUSED for an unanalysable construct must
 * still get a redirect, and the lexer returns nothing to read in that case.
 */
export function redirectForCommand(
  command: string,
  available: ReadonlySet<string>,
  declaredCommands: ReadonlySet<string>,
): string | undefined {
  const [first = ""] = command.split(/&&|\|\||;|\||\n/);
  const tokens = first
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return undefined;

  const ownedRunState = naxOwnedRunStateExplanation(tokens);
  if (ownedRunState !== undefined) return ownedRunState;

  const hit = intentFor(tokens);
  if (hit === undefined) return taskRunnerFallback(tokens, available, declaredCommands);
  // Telling Bash it already has Bash reads as a contradiction of the denial —
  // the same suppression redirectForVerb applies.
  if (hit.tool === "Bash") return undefined;
  return render(hit, available, declaredCommands);
}

/**
 * Name the tool that serves the intent behind a denied VERB call.
 *
 * `redirectForArgv` is unreachable for RunCommand and Git: they deny through
 * `verbField`, where the policy sees no argv at all, so every such denial was a
 * bare refusal (nax#1971). A verb slot carries either a mini command line the
 * model stuffed there ("ls -la") or a bare word ("grep"); both are tokenized
 * and answered by the same table, which is what keeps them consistent.
 */
export function redirectForVerb(
  deniedTool: string,
  verb: string,
  available: ReadonlySet<string>,
  declaredCommands: ReadonlySet<string>,
): string | undefined {
  const tokens = verb
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return undefined;

  const ownedRunState = naxOwnedRunStateExplanation(tokens);
  if (ownedRunState !== undefined) return ownedRunState;

  const hit = intentFor(tokens);
  if (hit === undefined) return taskRunnerFallback(tokens, available, declaredCommands);
  // Telling Git it already has Git reads as a contradiction of the denial.
  if (hit.tool === deniedTool) return undefined;
  return render(hit, available, declaredCommands);
}
