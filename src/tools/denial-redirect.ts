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

export function redirectForArgv(
  argv: readonly string[],
  available: ReadonlySet<string>,
  declaredCommands: ReadonlySet<string>,
): string | undefined {
  const hit = intendedTool(argv);
  if (hit === undefined) return undefined;

  if (hit.tool === "RunCommand:testScoped") {
    // Conditioned on the project actually declaring the command, not hardcoded:
    // naming a command this project never declared is the same defect again.
    if (!available.has("RunCommand") || !declaredCommands.has("testScoped")) return undefined;
    return `this session already has ${hit.how}`;
  }
  if (!available.has(hit.tool)) return undefined;
  return `this session already has \`${hit.tool}\` -- ${hit.how}`;
}
