import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { makeFakeSandboxBackend } from "@test/helpers/sandbox";
import { cleanupTempDir, makeTempDir } from "@test/helpers/temp";
import { _sandboxExecDeps as deps, sandboxExecCommand } from "@/cli/sandbox-exec";

const original = { ...deps };
afterEach(() => {
  Object.assign(deps, original);
});

test("AC-13: real spawn restores HOME, removes credentials, inherits cwd and exit 3", async () => {
  const dir = makeTempDir("sandbox-exec-");
  const key = process.env.CURSOR_API_KEY;
  const cwd = process.cwd();
  try {
    process.env.CURSOR_API_KEY = "secret";
    process.chdir(dir);
    const policy = join(dir, "policy.json");
    await Bun.write(
      policy,
      JSON.stringify({
        version: 1,
        home: dir,
        stripEnv: ["CURSOR_API_KEY"],
        policy: { writeRoots: [dir], denyWrite: [], denyRead: [], network: {} },
      }),
    );
    const backend = makeFakeSandboxBackend("leak");
    backend.wrap = async () => [
      "/bin/sh",
      "-c",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX parameter expansion, not JS interpolation.
      'printf \'%s|%s\' "$HOME" "${CURSOR_API_KEY-unset}" > out.txt; exit 3',
    ];
    deps.createBackend = () => backend;
    expect(await sandboxExecCommand(policy, "ignored")).toBe(3);
    expect(await Bun.file(join(dir, "out.txt")).text()).toBe(`${dir}|unset`);
  } finally {
    process.chdir(cwd);
    if (key === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = key;
    cleanupTempDir(dir);
  }
});

// Story-required CLI smoke: no config/trust gate or external agent is involved.
test.each([
  { ac: "AC-15", args: ["--help"], exit: 0 },
  { ac: "AC-16", args: ["--", "/nonexistent/nax-policy", "true"], exit: 126 },
  { ac: "AC-17", args: ["--", "/nonexistent/nax-policy", "-la"], exit: 126 },
])("$ac: CLI sandbox exec $args", async ({ args, exit }) => {
  const child = Bun.spawn(["bun", "bin/nax.ts", "sandbox", "exec", ...args], {
    cwd: join(import.meta.dir, "../../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(exit);
  if (exit === 0) {
    expect(stdout).toContain("<policy-file>");
    expect(stdout).toContain("<command>");
  } else {
    expect(stdout).toBe("");
    expect(stderr).toStartWith("nax sandbox exec:");
  }
});
