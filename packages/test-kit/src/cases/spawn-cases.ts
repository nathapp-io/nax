/**
 * Spawn behaviour cases (spec S2 §4.3): plain data plus node:assert over any
 * runtime of the CaseRuntime shape. Each case records Bun's measured behaviour;
 * a non-Bun runtime normalises to it. Runner-neutral: run them from bun:test or
 * vitest with `for (const c of SPAWN_CASES) test(c.name, () => c.run(runtime))`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaseRuntime, CaseSpawnResult } from "./runtime-types";

export interface RuntimeCase {
  readonly name: string;
  run(runtime: CaseRuntime): Promise<void>;
}

const PIPES = { stdout: "pipe", stderr: "pipe" } as const;
const text = (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text();
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The error `f` throws synchronously; fails the case if it returns. */
function thrownBy(f: () => unknown): { code?: string } {
  try {
    f();
  } catch (error) {
    return error as { code?: string };
  }
  throw new assert.AssertionError({ message: "expected spawn to throw synchronously" });
}

function stdinOf(p: CaseSpawnResult): NonNullable<CaseSpawnResult["stdin"]> {
  if (p.stdin === undefined) throw new assert.AssertionError({ message: "stdin: 'pipe' gave no stdin" });
  return p.stdin;
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "nax-spawn-case-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

export const SPAWN_CASES: readonly RuntimeCase[] = [
  {
    name: "a zero exit: exited 0, exitCode 0, signalCode null",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "exit 0"], PIPES);
      assert.equal(await p.exited, 0);
      assert.equal(p.exitCode, 0);
      assert.equal(p.signalCode, null);
    },
  },
  {
    name: "a non-zero exit is reported as is",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "exit 3"], PIPES);
      assert.equal(await p.exited, 3);
      assert.equal(p.exitCode, 3);
    },
  },
  {
    name: "stdout and stderr carry their own bytes",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "printf 'out-é'; printf 'err' >&2"], PIPES);
      const [out, err] = await Promise.all([text(p.stdout), text(p.stderr)]);
      assert.equal(out, "out-é");
      assert.equal(err, "err");
      assert.equal(await p.exited, 0);
    },
  },
  {
    name: "stdout.cancel() does not throw and the process still exits",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "yes | head -c 1000000"], PIPES);
      await p.stdout.cancel();
      await p.stderr.cancel();
      assert.equal(typeof (await p.exited), "number");
    },
  },
  {
    name: "stdin write returns the UTF-8 byte count; end() delivers EOF; flush() does not throw",
    async run(rt) {
      const p = rt.spawn(["cat"], { stdin: "pipe", ...PIPES });
      const stdin = stdinOf(p);
      assert.equal(stdin.write("héllo"), 6);
      stdin.flush();
      stdin.end();
      assert.equal(await text(p.stdout), "héllo");
      assert.equal(await p.exited, 0);
    },
  },
  {
    name: "unset stdin reads as EOF, not the parent's stdin",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "cat; echo done"], PIPES);
      assert.equal((await text(p.stdout)).trim(), "done");
      assert.equal(await p.exited, 0);
    },
  },
  {
    name: "writing to stdin after the child exited does not throw (a broken pipe is swallowed)",
    async run(rt) {
      const p = rt.spawn(["true"], { stdin: "pipe", ...PIPES });
      await p.exited;
      await pause(50);
      const stdin = stdinOf(p);
      stdin.write("x".repeat(70_000));
      stdin.flush();
      stdin.end();
      await pause(50);
    },
  },
  {
    name: "env replaces the environment; undefined values are dropped",
    async run(rt) {
      const p = rt.spawn(["/bin/sh", "-c", 'echo "[$FOO][$BAR][$HOME]"'], {
        env: { FOO: "foo", BAR: undefined },
        ...PIPES,
      });
      assert.equal((await text(p.stdout)).trim(), "[foo][][]");
    },
  },
  {
    name: "no env inherits the environment the process started with",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", 'echo "$HOME"'], PIPES);
      assert.equal((await text(p.stdout)).trim(), process.env.HOME ?? "");
    },
  },
  {
    name: "cwd sets the working directory",
    run: (rt) =>
      withTempDir(async (dir) => {
        writeFileSync(join(dir, "marker"), "");
        const p = rt.spawn(["ls"], { cwd: dir, ...PIPES });
        assert.equal((await text(p.stdout)).trim(), "marker");
      }),
  },
  {
    name: "a missing binary on PATH throws ENOENT synchronously",
    async run(rt) {
      assert.equal(thrownBy(() => rt.spawn(["nax-no-such-binary-xyz"], PIPES)).code, "ENOENT");
    },
  },
  {
    name: "a missing absolute binary throws ENOENT synchronously",
    async run(rt) {
      assert.equal(thrownBy(() => rt.spawn(["/nonexistent/nax-bin-xyz"], PIPES)).code, "ENOENT");
    },
  },
  {
    name: "a missing cwd throws ENOENT synchronously",
    async run(rt) {
      assert.equal(thrownBy(() => rt.spawn(["true"], { cwd: "/nonexistent/nax-dir-xyz", ...PIPES })).code, "ENOENT");
    },
  },
  {
    name: "a cwd that is a file throws ENOTDIR synchronously",
    run: (rt) =>
      withTempDir(async (dir) => {
        const file = join(dir, "f");
        writeFileSync(file, "");
        assert.equal(thrownBy(() => rt.spawn(["true"], { cwd: file, ...PIPES })).code, "ENOTDIR");
      }),
  },
  {
    name: "kill(SIGKILL): exited 137, exitCode null, signalCode SIGKILL",
    async run(rt) {
      const p = rt.spawn(["sleep", "5"], PIPES);
      p.kill("SIGKILL");
      assert.equal(await p.exited, 137);
      assert.equal(p.exitCode, null);
      assert.equal(p.signalCode, "SIGKILL");
    },
  },
  {
    name: "kill() defaults to SIGTERM: exited 143",
    async run(rt) {
      const p = rt.spawn(["sleep", "5"], PIPES);
      p.kill();
      assert.equal(await p.exited, 143);
      assert.equal(p.signalCode, "SIGTERM");
    },
  },
  {
    name: "kill() after exit does not throw",
    async run(rt) {
      const p = rt.spawn(["true"], PIPES);
      await p.exited;
      p.kill("SIGKILL");
    },
  },
  {
    name: "exited resolves when the child exits even if a grandchild still holds stdout",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "sleep 3 & echo started"], PIPES);
      const started = Date.now();
      await p.exited;
      assert.ok(Date.now() - started < 2000, `exited took ${Date.now() - started}ms`);
      await p.stdout.cancel();
      await p.stderr.cancel();
    },
  },
  {
    name: "detached makes the child its own process-group leader",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "ps -o pgid= -p $$"], { ...PIPES, detached: true });
      assert.equal(Number((await text(p.stdout)).trim()), p.pid);
    },
  },
  {
    name: "killing a detached child's process group leaves no descendants (ORPHAN-1)",
    async run(rt) {
      const p = rt.spawn(["sh", "-c", "sleep 30 & echo $!; wait"], { ...PIPES, detached: true });
      const reader = p.stdout.getReader();
      const first = await reader.read();
      const grandchild = Number(new TextDecoder().decode(first.value).trim());
      assert.ok(isAlive(grandchild), "the grandchild should be running before the kill");
      process.kill(-p.pid, "SIGKILL");
      await p.exited;
      await reader.cancel();
      let gone = false;
      for (let i = 0; i < 20 && !gone; i++) {
        gone = !isAlive(grandchild);
        if (!gone) await pause(25);
      }
      assert.ok(gone, `grandchild ${grandchild} survived the group kill`);
    },
  },
];
