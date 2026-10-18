/** opencode's isolated V2 shell plugin and restored AGENTS.md instructions. */
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { backendUnavailable } from "#src/client/errors";
import { digest, writeStateFile } from "#src/client/policy-files";
import { type ShellSandboxPlan, sandboxWrapSnippet } from "#src/client/shell-sandbox";

export const _opencodeSandboxDeps = { readFile, stat };

/** The hook wraps only shell commands, before opencode asks permission for the original. */
export function opencodeSandboxPluginSource(prefix: string): string {
  return `${sandboxWrapSnippet(prefix)}
export default {
  id: "nax-shell-sandbox",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      const tool = typeof event.tool === "string" ? event.tool.toLowerCase() : "";
      if ((tool === "shell" || tool === "bash") && typeof event.input?.command === "string") {
        event.input = { ...event.input, command: naxSandboxWrap(event.input.command) };
      }
    });
  }
};
`;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await _opencodeSandboxDeps.readFile(path, "utf8");
  } catch (cause) {
    if (missing(cause)) return undefined;
    throw backendUnavailable(`the opencode instruction file "${path}" could not be read`, { path, cause });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await _opencodeSandboxDeps.stat(path);
    return true;
  } catch (cause) {
    if (missing(cause)) return false;
    throw backendUnavailable(`the opencode config path "${path}" could not be inspected`, { path, cause });
  }
}

async function instructions(userDir: string, workdir: string): Promise<string> {
  const texts: string[] = [];
  const global = await optionalText(join(userDir, "AGENTS.md"));
  if (global !== undefined) texts.push(global);
  for (let dir = workdir; ; dir = dirname(dir)) {
    const text = await optionalText(join(dir, "AGENTS.md"));
    if (text !== undefined) texts.push(text);
    if (await exists(join(dir, ".git"))) break;
    if (dirname(dir) === dir) break;
  }
  return texts.join("\n\n");
}

async function operatorConfig(userDir: string): Promise<string | undefined> {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const path = join(userDir, name);
    if (await exists(path)) return path;
  }
  return undefined;
}

/**
 * All writes use the shared fail-closed writer, on every launch. Operator config
 * may itself name V2 plugins that undo this hook; isolating the whole process is
 * outside this shell-only sandbox. Only AGENTS.md (not CLAUDE.md) is restored.
 */
export async function opencodeSandboxEnv(
  plan: ShellSandboxPlan,
  permissionConfig: string,
  callerEnv: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, string>>> {
  const userDir =
    callerEnv.OPENCODE_CONFIG_DIR ?? join(callerEnv.XDG_CONFIG_HOME ?? join(plan.home, ".config"), "opencode");
  const text = await instructions(userDir, plan.workdir);
  const source = opencodeSandboxPluginSource(plan.prefix);
  // Planning owns the invariant <stateDir>/sandbox/policy-<digest>.json.
  const stateDir = dirname(dirname(plan.policyFile));
  const relativeDir = join("opencode", digest(source + "\n\n" + text));
  await writeStateFile(stateDir, join(relativeDir, "plugins", "nax-shell-sandbox.js"), source, 0o600);
  if (text.length > 0) await writeStateFile(stateDir, join(relativeDir, "AGENTS.md"), text, 0o600);
  const config = callerEnv.OPENCODE_CONFIG === undefined ? await operatorConfig(userDir) : undefined;
  return Object.freeze({
    OPENCODE_CONFIG_CONTENT: permissionConfig,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG_DIR: join(stateDir, relativeDir),
    ...(config === undefined ? {} : { OPENCODE_CONFIG: config }),
  });
}
