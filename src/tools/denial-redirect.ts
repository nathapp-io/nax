/**
 * Name the tool that serves the intent behind a denied argv call.
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
 */

const GIT_READ_VERBS = new Set(["diff", "log", "show", "status", "blame"]);

function isSingleFileDelete(argv: readonly string[]): boolean {
  if (argv[0] === "rm") return argv.length === 2 && !argv[1]?.startsWith("-");
  return argv[0] === "git" && argv[1] === "rm" && argv.length === 3 && !argv[2]?.startsWith("-");
}

/** Argv shapes that are really a request for a first-class tool. */
function intendedTool(argv: readonly string[]): { tool: string; how: string } | undefined {
  // A `timeout N ...` prefix wraps the real command; look past it.
  const av = argv[0] === "timeout" ? argv.slice(2) : argv;
  const [head, second] = av;
  if (head === undefined) return undefined;

  if (head === "ls" || head === "find") {
    return { tool: "Glob", how: "Glob lists repository paths by pattern" };
  }
  if (isSingleFileDelete(av) && head === "rm") {
    return { tool: "Delete", how: "Delete removes one tracked file at a time" };
  }
  if (isSingleFileDelete(av) && head === "git" && second === "rm") {
    return { tool: "Delete", how: "Delete removes one tracked file at a time" };
  }
  if (head === "git" && second !== undefined && GIT_READ_VERBS.has(second)) {
    return { tool: "Git", how: `Git runs read-only git (${[...GIT_READ_VERBS].join(", ")})` };
  }
  if (head === "bun" && second === "test") {
    return {
      tool: "RunCommand:testScoped",
      how: 'RunCommand {"command":"testScoped"} runs the project test command on named files',
    };
  }
  return undefined;
}

/**
 * Task-runner binaries. A detection heuristic ONLY: what gets named comes
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

export function redirectForArgv(
  argv: readonly string[],
  available: ReadonlySet<string>,
  declaredCommands: ReadonlySet<string>,
): string | undefined {
  const hit = intendedTool(argv);
  if (hit === undefined) {
    // Nothing specific matched. If the model reached for a task runner, it
    // wanted to run a project gate -- name the gates this project actually
    // declared, rather than the package-manager install allowlist that
    // policy.ts already printed and that is never the answer (nax#1971).
    const av = argv[0] === "timeout" ? argv.slice(2) : argv;
    const head = av[0];
    if (head === undefined || !TASK_RUNNERS.has(head)) return undefined;
    const sub = av[1];
    if (sub !== undefined && INSTALL_VERBS.has(sub)) return undefined;
    if (!available.has("RunCommand") || declaredCommands.size === 0) return undefined;
    return `this session already has RunCommand with declared commands: ${[...declaredCommands].join(", ")}`;
  }

  if (hit.tool === "RunCommand:testScoped") {
    // Conditioned on the project actually declaring the command, not hardcoded:
    // naming a command this project never declared is the same defect again.
    if (!available.has("RunCommand") || !declaredCommands.has("testScoped")) return undefined;
    return `this session already has ${hit.how}`;
  }
  if (!available.has(hit.tool)) return undefined;
  return `this session already has \`${hit.tool}\` -- ${hit.how}`;
}

/**
 * Bare verbs that are really a request for a first-class tool.
 *
 * Distinct from `intendedTool`: those are argv command lines, these are single
 * words the model put in a `verbField` slot (`RunCommand {command:"diff"}`).
 */
const VERB_TOOLS: ReadonlyMap<string, { tool: string; how: string }> = new Map([
  ["grep", { tool: "Grep", how: "Grep searches file contents" }],
  ["git", { tool: "Git", how: `Git runs read-only git (${[...GIT_READ_VERBS].join(", ")})` }],
  ...[...GIT_READ_VERBS].map(
    (v) => [v, { tool: "Git", how: `Git runs read-only git (${[...GIT_READ_VERBS].join(", ")})` }] as const,
  ),
]);

/**
 * Name the tool that serves the intent behind a denied VERB call.
 *
 * `redirectForArgv` is unreachable for RunCommand and Git: they deny through
 * `verbField`, where the policy sees no argv at all, so every such denial was a
 * bare refusal (nax#1971). A verb slot carries either a mini command line the
 * model stuffed there ("ls -la") -- tokenized here and handed to the same argv
 * table, so the two branches can never disagree about what `ls -la` means --
 * or a bare word ("grep"), handled by VERB_TOOLS.
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
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;

  // A multi-token verb IS a command line. Delegate to the argv table directly:
  // its RunCommand: testScoped affordance is distinct from the raw-command slot.
  if (tokens.length > 1) return redirectForArgv(tokens, available, declaredCommands);

  const hit = VERB_TOOLS.get(tokens[0] as string);
  if (hit === undefined) return undefined;
  // Telling Git it already has Git reads as a contradiction of the denial.
  if (hit.tool === deniedTool) return undefined;
  if (!available.has(hit.tool)) return undefined;
  return `this session already has \`${hit.tool}\` -- ${hit.how}`;
}
