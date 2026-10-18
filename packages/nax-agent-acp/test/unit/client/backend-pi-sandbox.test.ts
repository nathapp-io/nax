import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import { resolveAcpOptions } from "#src/client/options";
import { _policyFilesDeps } from "#src/client/policy-files";
import { NO_RULES, policyLaunchEnv } from "#src/client/rule-policy";
import { _shellSandboxDeps } from "#src/client/shell-sandbox";
import { inMemoryAgent } from "#test/helpers/in-memory-launch";
import { openContext } from "#test/helpers/open-context";

const originals = { launch: _acpBackendDeps.launch, files: { ..._policyFilesDeps }, sandbox: { ..._shellSandboxDeps } };
let dir: string;
beforeEach(() => {
  dir = makeTempDir("pi-sandbox-open-");
  _shellSandboxDeps.homedir = () => dir;
});
afterEach(() => {
  _acpBackendDeps.launch = originals.launch;
  Object.assign(_policyFilesDeps, originals.files);
  Object.assign(_shellSandboxDeps, originals.sandbox);
  cleanupTempDir(dir);
});
function setup(extensions: "user" | "none" = "user", bash = false, available = true) {
  const fake = inMemoryAgent({ agentInfo: { name: "pi", version: "1" } });
  _acpBackendDeps.launch = fake.launch;
  const backend = acpBackend({
    agent: "pi",
    allowUnsandboxed: true,
    command: "fake-pi",
    stateDir: dir,
    rules: bash ? { ...NO_RULES, allow: [{ tool: "Bash", patterns: ["ls"] }] } : NO_RULES,
    shellSandbox: { runtime: "/usr/bin/node", runner: ["/opt/nax.js", "sandbox", "exec"], pi: { extensions } },
  });
  const ctx = {
    ...openContext(dir),
    profile: "review" as const,
    sandbox: available
      ? { kind: "policy" as const, policy: { writeRoots: [dir], denyRead: [], denyWrite: [], network: {} } }
      : { kind: "unavailable" as const, reason: "x" },
  };
  return { fake, opened: backend.open(ctx) };
}
describe("pi sandbox launch", () => {
  test.each([
    [1, "user", false],
    [2, "none", false],
    [3, "user", true],
  ] as const)("AC-%d/5: %s extensions, Bash rule %s", async (_, extensions, bash) => {
    const { fake, opened } = setup(extensions, bash);
    const adapter = await opened;
    try {
      const wrapper = fake.requests[0]?.env.PI_ACP_PI_COMMAND ?? "";
      const body = await readFile(wrapper, "utf8");
      const gate = body.match(/'([^']*\/pi\/sandbox-gate-[a-f0-9]{16}\.ts)'/)?.[1];
      expect(gate).toBeDefined();
      expect(body).toBe(
        `#!/bin/sh\nexec 'pi' ${extensions === "none" ? "'--no-extensions' " : ""}'-e' '${gate}' '--tools' 'read,grep,find,ls,bash' "$@"\n`,
      );
      expect((await stat(gate ?? "")).mode & 0o777).toBe(0o600);
      expect((await stat(wrapper)).mode & 0o777).toBe(0o700);
      expect(await readFile(gate ?? "", "utf8")).toContain("spawnHook");
    } finally {
      await adapter.close();
    }
  });
  test("AC-4: unavailable sandbox keeps read tools only", async () => {
    const { fake, opened } = setup("user", false, false);
    const adapter = await opened;
    try {
      expect(await readFile(fake.requests[0]?.env.PI_ACP_PI_COMMAND ?? "", "utf8")).toBe(
        "#!/bin/sh\nexec 'pi' '--tools' 'read,grep,find,ls' \"$@\"\n",
      );
    } finally {
      await adapter.close();
    }
  });
  test("AC-15: extension write failure names its path and launches nothing", async () => {
    _policyFilesDeps.writeFile = async (path, content) => {
      if (path.includes("sandbox-gate-")) throw new Error("extension failed");
      return originals.files.writeFile(path, content);
    };
    const { fake, opened } = setup();
    await expect(opened).rejects.toMatchObject({
      code: "AGENT_SESSION_BACKEND_UNAVAILABLE",
      message: expect.stringMatching(/pi\/sandbox-gate-[a-f0-9]{16}\.ts/),
    });
    expect(fake.requests).toEqual([]);
  });
  test("AC-18: no sandbox preserves exact review wrapper", async () => {
    const env = await policyLaunchEnv(
      "review",
      resolveAcpOptions({ agent: "pi", allowUnsandboxed: true, stateDir: dir, rules: NO_RULES }),
    );
    expect(await readFile(env.PI_ACP_PI_COMMAND ?? "", "utf8")).toBe(
      "#!/bin/sh\nexec 'pi' '--tools' 'read,grep,find,ls' \"$@\"\n",
    );
  });
});
