/** Per-session command sandbox planning. Agent processes themselves remain on the host. */
import { mkdir, readlink, realpath, symlink } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { AgentSessionProfile, SandboxPolicy, SessionSandbox } from "@nathapp/nax-agent";
import { backendUnavailable } from "#src/client/errors";
import type { ResolvedAcpOptions } from "#src/client/options";
import { digest } from "#src/client/policy-files";

export const _shellSandboxDeps = {
  homedir,
  realpath: (path: string): Promise<string> => realpath(path),
  mkdir,
  platform,
  symlink,
  readlink,
};

/** Internal to the ACP package, not part of the ./client API. */
export type ShellSandboxPlan = {
  agent: "opencode" | "cursor" | "pi";
  policy: SandboxPolicy;
  policyContent: string;
  policyFile: string;
  prefix: string;
  home: string;
  runtime: string;
  workdir: string;
  verify: boolean;
  onUnwrapped: "rules" | "deny";
  piExtensions: "user" | "none";
  stripEnv: readonly string[];
};

/** One POSIX shell word; an embedded apostrophe closes, escapes, then reopens the quote. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

async function credentialPath(path: string): Promise<string | undefined> {
  try {
    return await _shellSandboxDeps.realpath(path);
  } catch (err) {
    // Only a missing file is safe to omit. Permission and other I/O failures refuse planning.
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined;
    throw backendUnavailable(`the credential floor "${path}" could not be resolved`, { path, cause: err });
  }
}

async function withFloors(policy: SandboxPolicy, stateDir: string, home: string): Promise<SandboxPolicy> {
  let state: string;
  try {
    await _shellSandboxDeps.mkdir(stateDir, { recursive: true, mode: 0o700 });
    state = await _shellSandboxDeps.realpath(stateDir);
  } catch (err) {
    throw backendUnavailable(`the shell sandbox state directory "${stateDir}" could not be resolved`, {
      path: stateDir,
      cause: err,
    });
  }
  const credentials = await Promise.all([
    credentialPath(join(home, ".local", "share", "opencode", "auth.json")),
    credentialPath(join(home, ".pi", "agent", "auth.json")),
  ]);
  return {
    ...policy,
    denyWrite: [...policy.denyWrite, state],
    denyRead: [...policy.denyRead, ...credentials.filter((path) => path !== undefined)],
  };
}

function credentialEnvNames(options: ResolvedAcpOptions): readonly string[] {
  const secrets = new Set(options.secrets);
  return [
    ...new Set([
      ...(options.entry?.authEnv ?? []),
      ...Object.keys(options.env).filter((name) => secrets.has(options.env[name] ?? "")),
    ]),
  ].sort();
}

/** Plans only opted-in review commands with an available policy; does not write the policy file. */
export async function shellSandboxPlan(
  profile: AgentSessionProfile,
  options: ResolvedAcpOptions,
  sandbox: SessionSandbox | undefined,
  workdir: string,
): Promise<ShellSandboxPlan | undefined> {
  const settings = options.shellSandbox;
  const agent = options.agentName;
  if (profile !== "review" || settings === undefined || sandbox?.kind !== "policy") return undefined;
  if (agent !== "opencode" && agent !== "cursor" && agent !== "pi") return undefined;
  if (agent === "opencode" && settings.opencodeProjectConfig === "keep") return undefined;
  const home = _shellSandboxDeps.homedir();
  const policy = await withFloors(sandbox.policy, options.stateDir, home);
  const stripEnv = credentialEnvNames(options);
  const policyContent = JSON.stringify({ version: 1, home, stripEnv, policy });
  const policyFile = join(options.stateDir, "sandbox", `policy-${digest(policyContent)}.json`);
  const prefix = `${[settings.runtime, ...settings.runner, policyFile].map(shellQuote).join(" ")} `;
  return {
    agent,
    policy,
    policyContent,
    policyFile,
    prefix,
    home,
    runtime: settings.runtime,
    workdir,
    verify: agent === "cursor",
    onUnwrapped: settings.cursorOnUnwrapped,
    piExtensions: settings.piExtensions,
    stripEnv,
  };
}
