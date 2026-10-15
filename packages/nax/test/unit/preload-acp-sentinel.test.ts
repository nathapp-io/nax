import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withTempDir, withTimeout } from "@test/helpers";
import { _acpDeps } from "@/agents/acp";

describe("test preload: sdk backend spawn sentinel (S4b-4 D4-d)", () => {
  test("an unmocked acpBackend throws instead of spawning a real ACP agent", () => {
    expect(() => _acpDeps.acpBackend({ agent: "claude", allowUnsandboxed: true })).toThrow(
      "[test-preload] _acpDeps.acpBackend called without a mock",
    );
  });
});

describe("test preload temporary globals", () => {
  test.each([
    ["nax", 0],
    ["nax", 1],
    ["nax-agent", 0],
    ["nax-agent", 1],
  ] as const)(
    "%s removes its global directory after exit %i",
    async (pkg, exitCode) => {
      await withTempDir(async (dir) => {
        const fixture = join(dir, "preload-cleanup.test.ts");
        const sibling = join(dir, "preload-sibling.test.ts");
        const imports = 'import { expect, test } from "bun:test"; import { existsSync } from "node:fs";';
        const checkGlobal = 'expect(existsSync(process.env.NAX_GLOBAL_CONFIG_DIR ?? "")).toBe(true);';
        await Bun.write(
          fixture,
          `${imports} test("exit fixture", () => { ${checkGlobal} expect(true).toBe(${exitCode === 0}); });`,
        );
        await Bun.write(sibling, `${imports} test("sibling fixture", () => { ${checkGlobal} });`);
        const child = Bun.spawn([process.execPath, "test", fixture, sibling, "--timeout=5000"], {
          cwd: resolve(import.meta.dir, "../../..", pkg),
          env: { ...process.env, AGENT: "0", TMPDIR: dir, TMP: dir, TEMP: dir },
          stdout: "pipe",
          stderr: "pipe",
        });
        try {
          const [code, stdout, stderr] = await withTimeout(
            Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
            10_000,
            "preload cleanup child",
          );
          expect(code, `${stdout}\n${stderr}`).toBe(exitCode);
          expect(stderr).toContain("(pass) sibling fixture");
          expect(stderr).toContain(exitCode === 0 ? "2 pass" : "1 pass");
          expect(stderr).toContain(exitCode === 0 ? "0 fail" : "1 fail");
          expect(
            (await readdir(dir)).filter((name) => name.startsWith("nax-") && name.includes("test-global-")),
          ).toEqual([]);
        } finally {
          child.kill();
          await child.exited;
        }
      });
    },
    15_000,
  );

  // Under `--parallel --no-isolate` the preload module runs once per worker but
  // its root-level hooks run once per FILE, so a cleanup in afterAll used to
  // delete the global directory after a worker's first file and leave every
  // later file on that worker without it (no trust.json -> PROJECT_UNTRUSTED).
  // Four files over two workers: at least one worker runs two or more.
  test.each(["nax", "nax-agent"] as const)(
    "%s keeps its global directory for every file a --parallel --no-isolate worker runs",
    async (pkg) => {
      await withTempDir(async (dir) => {
        const imports = 'import { expect, test } from "bun:test"; import { existsSync } from "node:fs";';
        const checkGlobal = 'expect(existsSync(process.env.NAX_GLOBAL_CONFIG_DIR ?? "")).toBe(true);';
        const files = [1, 2, 3, 4].map((n) => join(dir, `preload-worker-${n}.test.ts`));
        await Promise.all(
          files.map((file, i) =>
            Bun.write(file, `${imports} test("worker fixture ${i + 1}", () => { ${checkGlobal} });`),
          ),
        );
        const args = ["test", ...files, "--timeout=5000", "--parallel=2", "--no-isolate", "--parallel-delay=0"];
        const child = Bun.spawn([process.execPath, ...args], {
          cwd: resolve(import.meta.dir, "../../..", pkg),
          env: { ...process.env, AGENT: "0", TMPDIR: dir, TMP: dir, TEMP: dir },
          stdout: "pipe",
          stderr: "pipe",
        });
        try {
          const [code, stdout, stderr] = await withTimeout(
            Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
            10_000,
            "preload parallel child",
          );
          expect(code, `${stdout}\n${stderr}`).toBe(0);
          expect(`${stdout}\n${stderr}`).toContain("4 pass");
          expect(
            (await readdir(dir)).filter((name) => name.startsWith("nax-") && name.includes("test-global-")),
          ).toEqual([]);
        } finally {
          child.kill();
          await child.exited;
        }
      });
    },
    15_000,
  );
});
