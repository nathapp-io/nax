/**
 * Unit tests for the generated bash and zsh completion scripts (US-003).
 *
 * Every case spawns a real shell — `bash --norc --noprofile` or `zsh -f` — with a
 * temporary directory first on PATH whose `nax` is a stub executable. The stub
 * records each argument on its own line (so an empty current word stays visible)
 * and prints a configurable candidate list; it optionally writes to stderr. The
 * real `nax` is never spawned here.
 *
 * bash is registered with `complete -o default`, so an empty reply falls back to
 * file names; the zsh script calls `_files` explicitly. Both behaviours are
 * asserted, and zsh's `compdef` / `compadd` / `_files` are stubbed so no real
 * compinit (and no `~/.zcompdump`) is ever loaded.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { completionScript, SUPPORTED_SHELLS } from "@/cli/completion";

type ShellName = "bash" | "zsh";

/** The shell names `completionScript` accepts. */
type Shell = Parameters<typeof completionScript>[0];

const SHELL_BIN: Record<ShellName, string | null> = {
  bash: Bun.which("bash"),
  zsh: Bun.which("zsh"),
};

const NO_CANDIDATES = "";
const ALPHA_BETA = "alpha\nbeta\n";

// ─── Stub nax ─────────────────────────────────────────────────────────────────

/**
 * The stub `nax` on PATH. `printf '%s\n' "$@"` writes one argument per line and
 * keeps an empty argument as an empty line, which is the only way AC-5 can see
 * the empty current word.
 */
const STUB_NAX = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$NAX_STUB_ARGS"
if [ -n "$NAX_STUB_STDERR" ]; then printf 'boom\\n' >&2; fi
if [ -n "$NAX_STUB_CANDIDATES_FILE" ]; then cat "$NAX_STUB_CANDIDATES_FILE"; fi
`;

// ─── Fixture ──────────────────────────────────────────────────────────────────

interface Fixture {
  dir: string;
  binDir: string;
  completionPath: string;
  candidatesPath: string;
  stubArgsPath: string;
  callsPath: string;
  compaddArgsPath: string;
  compdefArgsPath: string;
}

interface ShellRun {
  code: number;
  stdout: string;
  stderr: string;
}

const created: string[] = [];

afterEach(() => {
  for (const dir of created) cleanupTempDir(dir);
  created.length = 0;
});

async function makeFixture(shell: Shell): Promise<Fixture> {
  const dir = makeTempDir("nax-completion-scripts-");
  created.push(dir);

  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const stubPath = join(binDir, "nax");
  await Bun.write(stubPath, STUB_NAX);
  chmodSync(stubPath, 0o755);

  const completionPath = join(dir, `completion.${shell}`);
  await Bun.write(completionPath, completionScript(shell));

  const candidatesPath = join(dir, "candidates");
  await Bun.write(candidatesPath, NO_CANDIDATES);

  return {
    dir,
    binDir,
    completionPath,
    candidatesPath,
    stubArgsPath: join(dir, "stub-args"),
    callsPath: join(dir, "calls"),
    compaddArgsPath: join(dir, "compadd-args"),
    compdefArgsPath: join(dir, "compdef-args"),
  };
}

/** Point the stub `nax` at a candidate list. */
async function setCandidates(fixture: Fixture, candidates: string): Promise<void> {
  await Bun.write(fixture.candidatesPath, candidates);
}

function shellEnv(fixture: Fixture, extra: Record<string, string>): Record<string, string | undefined> {
  return {
    ...process.env,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    NAX_COMPLETION_SCRIPT: fixture.completionPath,
    NAX_STUB_ARGS: fixture.stubArgsPath,
    NAX_STUB_CANDIDATES_FILE: fixture.candidatesPath,
    NAX_CALLS: fixture.callsPath,
    NAX_COMPADD_ARGS: fixture.compaddArgsPath,
    NAX_COMPDEF_ARGS: fixture.compdefArgsPath,
    ...extra,
  };
}

async function runHarness(
  fixture: Fixture,
  shell: ShellName,
  harnessBody: string,
  extraEnv: Record<string, string> = {},
): Promise<ShellRun> {
  const bin = SHELL_BIN[shell];
  if (bin === null) throw new Error(`[test] ${shell} is not on PATH`);

  const harnessPath = join(fixture.dir, `harness.${shell}`);
  await Bun.write(harnessPath, harnessBody);

  const flags = shell === "bash" ? ["--norc", "--noprofile"] : ["-f"];
  const proc = Bun.spawn([bin, ...flags, harnessPath], {
    env: shellEnv(fixture, extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** Read a recorded file as lines; a missing file is an empty record. */
async function readLines(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const text = await Bun.file(path).text();
  if (text === "") return [];
  // Drop exactly one trailing newline so a final empty argument survives.
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

interface ParsedReply {
  count: number;
  candidates: string[];
}

/** Parse the `count=` / `cand=` lines the bash harness prints. */
function parseReply(stdout: string): ParsedReply {
  const candidates: string[] = [];
  let count = -1;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("count=")) count = Number(line.slice("count=".length));
    else if (line.startsWith("cand=")) candidates.push(line.slice("cand=".length));
  }
  return { count, candidates };
}

/** Quote fixture words for a shell array literal. Fixture words hold no quotes. */
function quoteWords(words: readonly string[]): string {
  return words.map((word) => `'${word}'`).join(" ");
}

// ─── bash ─────────────────────────────────────────────────────────────────────

/** Load the completion script, complete `words` at `cword`, then print COMPREPLY. */
function bashCompleteHarness(words: readonly string[], cword: number): string {
  return [
    'source "$NAX_COMPLETION_SCRIPT"',
    `COMP_WORDS=(${quoteWords(words)})`,
    `COMP_CWORD=${cword}`,
    "_nax_complete",
    `printf 'count=%d\\n' "\${#COMPREPLY[@]}"`,
    `for candidate in "\${COMPREPLY[@]}"; do printf 'cand=%s\\n' "$candidate"; done`,
    "",
  ].join("\n");
}

describe.skipIf(SHELL_BIN.bash === null)("bash completion script", () => {
  test("AC-1 registers _nax_complete for nax", async () => {
    const fixture = await makeFixture("bash");
    const run = await runHarness(fixture, "bash", 'source "$NAX_COMPLETION_SCRIPT"\ncomplete -p nax\n');

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("_nax_complete");
  });

  test("AC-2 registers with -o default so an empty reply falls back to file names", async () => {
    const fixture = await makeFixture("bash");
    const run = await runHarness(fixture, "bash", 'source "$NAX_COMPLETION_SCRIPT"\ncomplete -p nax\n');

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("-o default");
  });

  test("AC-3 sets COMPREPLY to exactly the candidates nax printed", async () => {
    const fixture = await makeFixture("bash");
    await setCandidates(fixture, ALPHA_BETA);

    const run = await runHarness(fixture, "bash", bashCompleteHarness(["nax", "run", "-f", "a"], 3));

    expect(run.code).toBe(0);
    expect(parseReply(run.stdout)).toEqual({ count: 2, candidates: ["alpha", "beta"] });
  });

  test("AC-4 sends __complete -- and the words after nax through the cursor", async () => {
    const fixture = await makeFixture("bash");
    await setCandidates(fixture, ALPHA_BETA);

    await runHarness(fixture, "bash", bashCompleteHarness(["nax", "run", "-f", "a"], 3));

    expect(await readLines(fixture.stubArgsPath)).toEqual(["__complete", "--", "run", "-f", "a"]);
  });

  test("AC-5 sends five arguments with an empty last one for an empty current word", async () => {
    const fixture = await makeFixture("bash");
    await setCandidates(fixture, ALPHA_BETA);

    await runHarness(fixture, "bash", bashCompleteHarness(["nax", "run", "-f", ""], 3));

    const args = await readLines(fixture.stubArgsPath);
    expect(args).toHaveLength(5);
    expect(args.at(-1)).toBe("");
  });

  test("AC-6 discards nax stderr and still sets COMPREPLY", async () => {
    const fixture = await makeFixture("bash");
    await setCandidates(fixture, "alpha\n");

    const run = await runHarness(fixture, "bash", bashCompleteHarness(["nax", "run", "-f", "a"], 3), {
      NAX_STUB_STDERR: "1",
    });

    expect(run.stderr).toBe("");
    expect(parseReply(run.stdout).candidates).toEqual(["alpha"]);
  });

  test("AC-14 leaves COMPREPLY empty when nax prints nothing", async () => {
    const fixture = await makeFixture("bash");
    await setCandidates(fixture, NO_CANDIDATES);

    const run = await runHarness(fixture, "bash", bashCompleteHarness(["nax", "run", "-f", "a"], 3));

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(parseReply(run.stdout)).toEqual({ count: 0, candidates: [] });
  });
});

// ─── zsh ──────────────────────────────────────────────────────────────────────

/** compdef / compadd / _files stubs: they record calls instead of loading compinit. */
const ZSH_COMPLETION_STUBS = [
  `compdef() { printf 'compdef\\n' >> "$NAX_CALLS"; printf '%s\\n' "$@" >> "$NAX_COMPDEF_ARGS"; }`,
  `compadd() { printf 'compadd\\n' >> "$NAX_CALLS"; printf '%s\\n' "$@" >> "$NAX_COMPADD_ARGS"; }`,
  `_files() { printf '_files\\n' >> "$NAX_CALLS"; }`,
].join("\n");

/** Load the completion script (recording `compdef`) and call `_nax` for `words`. */
function zshCallHarness(words: readonly string[], current: number): string {
  return [
    ZSH_COMPLETION_STUBS,
    'source "$NAX_COMPLETION_SCRIPT"',
    `words=(${quoteWords(words)})`,
    `CURRENT=${current}`,
    "_nax",
    "",
  ].join("\n");
}

describe.skipIf(SHELL_BIN.zsh === null)("zsh completion script", () => {
  test("AC-7 registers _nax for nax through compdef", async () => {
    const fixture = await makeFixture("zsh");
    await runHarness(fixture, "zsh", `${ZSH_COMPLETION_STUBS}\nsource "$NAX_COMPLETION_SCRIPT"\n`);

    expect(await readLines(fixture.compdefArgsPath)).toEqual(["_nax", "nax"]);
  });

  test("AC-8 without compdef prints the compinit hint and succeeds", async () => {
    const fixture = await makeFixture("zsh");
    const run = await runHarness(fixture, "zsh", 'source "$NAX_COMPLETION_SCRIPT"\n');

    expect(run.code).toBe(0);
    expect(run.stderr).toContain("autoload -Uz compinit && compinit");
  });

  test("AC-9 passes the candidates nax printed to compadd", async () => {
    const fixture = await makeFixture("zsh");
    await setCandidates(fixture, ALPHA_BETA);

    await runHarness(fixture, "zsh", zshCallHarness(["nax", "run", "-f", "a"], 4));

    const args = await readLines(fixture.compaddArgsPath);
    expect(args).toContain("alpha");
    expect(args).toContain("beta");
  });

  test("AC-10 sends __complete -- and the words after nax through the cursor", async () => {
    const fixture = await makeFixture("zsh");
    await setCandidates(fixture, ALPHA_BETA);

    await runHarness(fixture, "zsh", zshCallHarness(["nax", "run", "-f", "a"], 4));

    expect(await readLines(fixture.stubArgsPath)).toEqual(["__complete", "--", "run", "-f", "a"]);
  });

  test("AC-11 falls back to _files without calling compadd when nax prints nothing", async () => {
    const fixture = await makeFixture("zsh");
    await setCandidates(fixture, NO_CANDIDATES);

    await runHarness(fixture, "zsh", zshCallHarness(["nax", "run", "-f", "a"], 4));

    const calls = await readLines(fixture.callsPath);
    expect(calls.filter((call) => call === "_files")).toHaveLength(1);
    expect(calls).not.toContain("compadd");
  });

  test("AC-12 discards nax stderr and still offers the candidate", async () => {
    const fixture = await makeFixture("zsh");
    await setCandidates(fixture, "alpha\n");

    const run = await runHarness(fixture, "zsh", zshCallHarness(["nax", "run", "-f", "a"], 4), {
      NAX_STUB_STDERR: "1",
    });

    expect(run.stderr).toBe("");
    expect(await readLines(fixture.compaddArgsPath)).toContain("alpha");
  });

  test("AC-15 does not pass -Q to compadd, leaving quoting to zsh", async () => {
    const fixture = await makeFixture("zsh");
    await setCandidates(fixture, ALPHA_BETA);

    await runHarness(fixture, "zsh", zshCallHarness(["nax", "run", "-f", "a"], 4));

    const args = await readLines(fixture.compaddArgsPath);
    expect(await readLines(fixture.callsPath)).toContain("compadd");
    expect(args).not.toContain("-Q");
  });
});

// ─── shell list ───────────────────────────────────────────────────────────────

describe("SUPPORTED_SHELLS", () => {
  test("AC-13 lists bash and zsh", () => {
    expect([...SUPPORTED_SHELLS]).toEqual(["bash", "zsh"]);
  });
});
