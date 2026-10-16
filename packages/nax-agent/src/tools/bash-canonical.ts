/** Deny/ask-only views of Bash commands. Never use these views to grant or check paths. */
import { type BashSegment, type BashToken, lexBashCommand } from "#src/permissions/index";

export type CanonicalResult =
  | { readonly kind: "ok"; readonly segments: readonly BashSegment[] }
  | { readonly kind: "refused"; readonly reason: string };

interface Options {
  readonly flags: readonly string[];
  readonly values: readonly string[];
}

// Deliberately separate from commandHeadIndex: this policy must refuse unknown
// wrapper options rather than guess whether the next word names the executable.
const WRAPPERS: Readonly<Record<string, Options>> = {
  env: { flags: ["-i", "--ignore-environment"], values: ["-u", "--unset"] },
  command: { flags: ["-p"], values: [] },
  exec: { flags: ["-c", "-l"], values: ["-a"] },
  time: { flags: ["-p"], values: [] },
  nohup: { flags: [], values: [] },
  nice: { flags: [], values: ["-n", "--adjustment"] },
  timeout: {
    flags: ["--foreground", "--preserve-status", "-v", "--verbose"],
    values: ["-k", "--kill-after", "-s", "--signal"],
  },
  stdbuf: { flags: [], values: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  xargs: {
    flags: ["-0", "--null", "-r", "--no-run-if-empty", "-t", "--verbose", "-p", "--interactive", "-x", "--exit"],
    values: [
      "-I",
      "-n",
      "-P",
      "-d",
      "-E",
      "-L",
      "-s",
      "-a",
      "--replace",
      "--max-args",
      "--max-procs",
      "--delimiter",
      "--eof",
      "--max-lines",
      "--max-chars",
      "--arg-file",
    ],
  },
  busybox: { flags: [], values: [] },
  sudo: {
    flags: [
      "-A",
      "-b",
      "-E",
      "-H",
      "-K",
      "-k",
      "-n",
      "-S",
      "--askpass",
      "--background",
      "--preserve-env",
      "--set-home",
      "--non-interactive",
      "--stdin",
    ],
    values: [
      "-u",
      "-g",
      "-h",
      "-D",
      "-C",
      "-p",
      "-r",
      "-t",
      "-U",
      "--user",
      "--group",
      "--host",
      "--chdir",
      "--close-from",
      "--prompt",
      "--role",
      "--type",
      "--other-user",
    ],
  },
  doas: { flags: ["-n", "-s", "-L"], values: ["-u", "-C"] },
};
const GIT_OPTIONS: Options = {
  flags: ["--no-pager", "-p", "--paginate", "--bare", "--literal-pathspecs", "--no-replace-objects"],
  values: ["-C", "-c", "--git-dir", "--work-tree", "--namespace"],
};
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "{"]);
const CLOSERS = new Set(["fi", "done", "}"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function refused(reason: string): CanonicalResult {
  return { kind: "refused", reason: `Bash canonical analysis refused: ${reason}` };
}

/** Number of tokens an option consumes; undefined means it is unknown. */
function optionWidth(word: string, options: Options): number | undefined {
  if (options.flags.includes(word)) return 1;
  if (options.values.includes(word)) return 2;
  if (
    options.values.some((flag) =>
      flag.startsWith("--") ? word.startsWith(`${flag}=`) : word.startsWith(flag) && word.length > flag.length,
    )
  )
    return 1;
  // Short boolean options may be clustered (sudo -nE, for example).
  if (/^-[A-Za-z0-9]+$/.test(word) && [...word.slice(1)].every((letter) => options.flags.includes(`-${letter}`)))
    return 1;
  return undefined;
}

function afterOptions(tokens: readonly BashToken[], start: number, options: Options): number | string {
  let i = start;
  while (tokens[i]?.text.startsWith("-")) {
    const token = tokens[i] as BashToken;
    if (token.opaque) return "opaque wrapper option";
    if (token.text === "--") return i + 1;
    const width = optionWidth(token.text, options);
    if (width === undefined) return `unknown option ${token.text}`;
    if (width === 2 && tokens[i + 1] === undefined) return `missing value for ${token.text}`;
    i += width;
  }
  return i;
}

/** Locate only the shell's command-string operand, never a script's arguments. */
function shellPayload(tokens: readonly BashToken[]): BashToken | string | undefined {
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i] as BashToken;
    const word = token.text;
    if ((!word.startsWith("-") && !word.startsWith("+")) || word === "--") return undefined;
    if (token.opaque) return "opaque shell option";
    if (word === "-o" || word === "+o" || word === "-O" || word === "--rcfile" || word === "--init-file") {
      i += 1;
      continue;
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) return tokens[i + 1] ?? "missing shell command string";
  }
  return undefined;
}

function stripPrefixes(input: readonly BashToken[]): readonly BashToken[] | string {
  let tokens = input;
  for (;;) {
    const head = tokens[0];
    if (head === undefined) return [];
    if (head.opaque) return "opaque command head";
    if (KEYWORDS.has(head.text) || ASSIGNMENT.test(head.text)) {
      tokens = tokens.slice(1);
      continue;
    }
    const wrapper = Object.hasOwn(WRAPPERS, head.text) ? WRAPPERS[head.text] : undefined;
    if (wrapper === undefined) break;
    const next = afterOptions(tokens, 1, wrapper);
    if (typeof next === "string") return `${head.text}: ${next}`;
    const command = head.text === "timeout" ? next + 1 : next;
    if (head.text === "timeout" && tokens[next] === undefined) return "missing timeout duration";
    tokens = tokens.slice(command);
  }
  return tokens;
}

function expandShell(payload: BashToken, depth: number): CanonicalResult {
  if (depth >= 3) return refused("shell command strings nest deeper than 3 levels");
  if (payload.opaque) return refused("opaque shell command string");
  const lexed = lexBashCommand(payload.text);
  if (lexed.kind === "refused") return refused(`shell command string contains ${lexed.construct}`);
  const segments: BashSegment[] = [];
  for (const nested of lexed.segments) {
    const result = canonicalise(nested, depth + 1);
    if (result.kind === "refused") return result;
    segments.push(...result.segments);
  }
  return { kind: "ok", segments };
}

function canonicalise(segment: BashSegment, depth: number): CanonicalResult {
  const stripped = stripPrefixes(segment.tokens);
  if (typeof stripped === "string") return refused(stripped);
  let tokens = stripped;
  if (tokens.length === 0) return { kind: "ok", segments: [] };
  if (tokens.length === 1 && CLOSERS.has(tokens[0]?.text ?? "")) return { kind: "ok", segments: [] };
  if (tokens[0]?.text === "git") {
    const next = afterOptions(tokens, 1, GIT_OPTIONS);
    if (typeof next === "string") return refused(`git: ${next}`);
    tokens = [tokens[0], ...tokens.slice(next)];
  }
  const head = tokens[0]?.text.split("/").pop() ?? "";
  if (SHELLS.has(head)) {
    const payload = shellPayload(tokens);
    if (typeof payload === "string") return refused(payload);
    if (payload !== undefined) return expandShell(payload, depth);
  }
  return { kind: "ok", segments: [{ ...segment, tokens }] };
}

export function canonicalSegments(segment: BashSegment): CanonicalResult {
  return canonicalise(segment, 0);
}
