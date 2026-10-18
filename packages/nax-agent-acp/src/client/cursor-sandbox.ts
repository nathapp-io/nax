/** Cursor reads hooks only beneath HOME; isolate that HOME, not the command's home. */
import { dirname, join } from "node:path";
import { backendUnavailable } from "#src/client/errors";
import { digest, writeStateFile } from "#src/client/policy-files";
import { _shellSandboxDeps, type ShellSandboxPlan, sandboxWrapSnippet, shellQuote } from "#src/client/shell-sandbox";

/** A malformed hook event fails closed; non-command tools need no rewrite. */
export function cursorSandboxHookSource(prefix: string): string {
  return `${sandboxWrapSnippet(prefix)}
try {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  const toolInput = event?.tool_input;
  const result = typeof toolInput?.command === "string"
    ? { updated_input: { ...toolInput, command: naxSandboxWrap(toolInput.command) } }
    : {};
  process.stdout.write(JSON.stringify(result));
} catch {
  process.exitCode = 1;
}
`;
}

async function linkKeychains(home: string, realHome: string): Promise<void> {
  const path = join(home, "Library", "Keychains");
  const target = join(realHome, "Library", "Keychains");
  try {
    await _shellSandboxDeps.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await _shellSandboxDeps.symlink(target, path);
    } catch (cause) {
      // Reuse and concurrent opens are safe only for this exact link target.
      if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
      if ((await _shellSandboxDeps.readlink(path)) !== target) throw cause;
    }
  } catch (cause) {
    throw backendUnavailable(`the Cursor keychain link "${path}" could not be created`, { path, cause });
  }
}

/** Every open rewrites both private files through the shared atomic writer. */
export async function cursorSandboxEnv(
  plan: ShellSandboxPlan,
  cursorConfigDir: string,
): Promise<Readonly<Record<string, string>>> {
  // Planning owns the invariant <stateDir>/sandbox/policy-<digest>.json.
  const stateDir = dirname(dirname(plan.policyFile));
  const source = cursorSandboxHookSource(plan.prefix);
  const hookFile = await writeStateFile(stateDir, join("cursor", `sandbox-hook-${digest(source)}.mjs`), source, 0o600);
  const content = JSON.stringify({
    version: 1,
    hooks: { preToolUse: [{ command: `${shellQuote(plan.runtime)} ${shellQuote(hookFile)}`, failClosed: true }] },
  });
  const relativeHome = join("cursor-home", digest(content));
  await writeStateFile(stateDir, join(relativeHome, ".cursor", "hooks.json"), content, 0o600);
  const home = join(stateDir, relativeHome);
  if (_shellSandboxDeps.platform() === "darwin") await linkKeychains(home, plan.home);
  return Object.freeze({ CURSOR_CONFIG_DIR: cursorConfigDir, HOME: home });
}
