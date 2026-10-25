import { dirname, resolve } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Command } from "commander";
import type { Instance } from "ink";
import { type ChatHost, createChatHost, createChatStorage } from "@/chat";
import { findProjectDir, loadConfig, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { type InteractionChain, initInteractionChain } from "@/interaction";
import { getSafeLogger } from "@/logger";
import { renderChat } from "@/tui/chat";

const SIGNAL_EXIT_CODES = { SIGTERM: 143, SIGHUP: 129 } as const;
type ChatSignal = keyof typeof SIGNAL_EXIT_CODES;
type ChatShell = Pick<Instance, "unmount" | "waitUntilExit">;

export interface ChatCommandOptions {
  resume?: boolean | string;
  mode?: string;
  model?: string;
  profile?: string[];
  dir?: string;
}

export const _chatCommandDeps = {
  stdinIsTTY: (): boolean => process.stdin.isTTY === true,
  loadConfig,
  findProjectDir,
  initInteractionChain,
  createChatStorage,
  createChatHost,
  renderChat: (props: { host: ChatHost }): ChatShell => renderChat(props),
  onSignal: (signal: ChatSignal, handler: () => Promise<void>): (() => void) => {
    process.on(signal, handler);
    return () => {
      process.off(signal, handler);
    };
  },
  writeErr: (message: string): void => {
    process.stderr.write(`${message}\n`);
  },
  setExitCode: (code: number): void => {
    process.exitCode = code;
  },
};
export type ChatCommandDeps = typeof _chatCommandDeps;

async function interactionChain(config: NaxConfig, deps: ChatCommandDeps): Promise<InteractionChain | null> {
  try {
    return await deps.initInteractionChain(config, true);
  } catch (error) {
    deps.writeErr(`interaction chain unavailable: ${errorMessage(error)}; asks stay in the terminal`);
    return null;
  }
}

function launchModel(config: NaxConfig, model?: string): string {
  if (model !== undefined) return model;
  const entry = config.models.native?.balanced;
  if (entry === undefined) {
    throw new NaxError("[chat] configure models.native.balanced or pass --model", "CHAT_SESSION_MODEL_REQUIRED", {
      stage: "chat",
    });
  }
  return typeof entry === "string" ? entry : `${entry.provider}/${entry.model}`;
}

async function startHost(host: ChatHost, options: ChatCommandOptions, config: NaxConfig): Promise<void> {
  const mode = options.mode === "full" || options.mode === "guarded" ? options.mode : undefined;
  if (options.resume) {
    await host.resume(typeof options.resume === "string" ? { id: options.resume } : {});
    if (mode !== undefined || options.model !== undefined) {
      await host.switchTo({
        ...(mode !== undefined ? { mode } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
      });
    }
  } else {
    await host.start({ mode: mode ?? "guarded", model: launchModel(config, options.model) });
  }
}

/** Own the terminal lifetime; signal shutdown awaits lock release before allowing exit. */
async function runShell(host: ChatHost, deps: ChatCommandDeps): Promise<void> {
  let shell: ChatShell | undefined;
  let closing: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  const removers: (() => void)[] = [];
  const close = (): Promise<void> => (closing ??= host.close());
  const stop = (signal: ChatSignal): Promise<void> =>
    (shutdown ??= (async () => {
      try {
        await close();
        deps.setExitCode(SIGNAL_EXIT_CODES[signal]);
      } catch (error) {
        deps.writeErr(errorMessage(error));
        deps.setExitCode(1);
      } finally {
        shell?.unmount();
      }
    })());
  try {
    for (const signal of ["SIGTERM", "SIGHUP"] as const) removers.push(deps.onSignal(signal, () => stop(signal)));
    shell = deps.renderChat({ host });
    await shell.waitUntilExit();
    await shutdown;
  } finally {
    try {
      await close();
    } finally {
      shell?.unmount();
      for (const remove of removers) remove();
    }
  }
}

async function composeChat(options: ChatCommandOptions, deps: ChatCommandDeps): Promise<void> {
  // CLI bootstrap anchor: keep cwd (possibly a package) distinct from the discovered root.
  const cwd = resolve(options.dir ?? process.cwd());
  const naxDir = deps.findProjectDir(cwd);
  const config = options.profile?.length
    ? await deps.loadConfig(naxDir ?? undefined, { profile: options.profile })
    : await deps.loadConfig(naxDir ?? undefined);
  const log = (stage: string, message: string): void => deps.writeErr(`[${stage}] ${message}`);
  const logger = getSafeLogger() ?? { warn: log, error: log, info: log, debug: log };
  const storage = deps.createChatStorage({ pid: process.pid, now: () => new Date(), logger });
  const chain = await interactionChain(config, deps);
  let host: ChatHost;
  try {
    host = deps.createChatHost({
      config,
      cwd,
      repoRoot: naxDir ? dirname(naxDir) : cwd,
      storage,
      chain,
      now: () => new Date(),
      logger,
    });
  } catch (error) {
    await chain?.destroy();
    throw error;
  }
  try {
    await startHost(host, options, config);
  } catch (error) {
    try {
      await host.close();
    } catch (closeError) {
      deps.writeErr(errorMessage(closeError));
    }
    throw error;
  }
  await runShell(host, deps);
}

export async function chatCommand(
  options: ChatCommandOptions,
  deps: ChatCommandDeps = _chatCommandDeps,
): Promise<void> {
  if (!deps.stdinIsTTY()) {
    deps.writeErr("nax chat needs an interactive terminal");
    deps.setExitCode(1);
    return;
  }
  if (options.mode !== undefined && options.mode !== "full" && options.mode !== "guarded") {
    deps.writeErr(`unknown mode ${options.mode}; expected full or guarded`);
    deps.setExitCode(1);
    return;
  }
  try {
    await composeChat(options, deps);
  } catch (error) {
    deps.writeErr(errorMessage(error));
    deps.setExitCode(1);
  }
}

function collectChatProfile(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

export function registerChatCommand(program: Command, deps: ChatCommandDeps = _chatCommandDeps): void {
  program
    .command("chat", { isDefault: true })
    .description("Open an interactive native chat session")
    .option("--resume [id]", "Resume a stored session (latest when no id is given)")
    .option("--mode <full|guarded>", "Chat permission mode (default: guarded for new sessions)")
    .option("--model <id>", "Provider/model id")
    .option("--profile <name>", "Profile(s) to overlay (repeatable)", collectChatProfile, [])
    .option("-d, --dir <path>", "Working directory")
    .action((options: ChatCommandOptions) => chatCommand(options, deps));
}
