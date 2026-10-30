import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import chalk from "chalk";
import type { Command } from "commander";
import type { Instance } from "ink";
import { listCatalogModels, lookupThinkingLevels } from "@/agents/catalog";
import {
  type ChatHost,
  type ChatHostState,
  type ChatResources,
  chatEffortLevels,
  chatModelChoices,
  createAcpCatalog,
  createChatHost,
  createChatMcp,
  createChatStorage,
  createWorkflowProvider,
  tierModels,
} from "@/chat";
import { findProjectDir, getProjectKey, globalConfigDir, isWorkflowMode, loadConfig, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { type InteractionChain, initInteractionChain } from "@/interaction";
import { getSafeLogger } from "@/logger";
import { loadPlugins, PluginRegistry } from "@/plugins";
import { createSkillsProvider, loadResourceCatalog, naxPluginPackages } from "@/resources";
import { projectOutputDir } from "@/runtime";
import { ensureProjectTrusted, normalizeTrustPath, resolveTrustRoot } from "@/trust";
import { type ChatAppProps, formatChatExitSummary, renderChat, resolveChatTheme } from "@/tui/chat";
import { NAX_VERSION } from "@/version";
import { collectAuthList } from "./auth-list";

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
  collectAuthList,
  naxEntry: (): readonly string[] | undefined =>
    process.argv[1] === undefined ? undefined : [process.execPath, process.argv[1]],
  listCatalogModels,
  lookupThinkingLevels,
  stdinIsTTY: (): boolean => process.stdin.isTTY === true,
  ensureTrusted: async (cwd: string): Promise<void> => {
    await ensureProjectTrusted(await normalizeTrustPath(resolveTrustRoot(cwd)), { interactive: true });
  },
  loadPlugins,
  loadResourceCatalog,
  createChatMcp,
  env: process.env,
  loadConfig,
  findProjectDir,
  initInteractionChain,
  createChatStorage,
  createAcpCatalog,
  createChatHost,
  renderChat: (props: ChatAppProps): ChatShell => renderChat(props),
  onSignal: (signal: ChatSignal, handler: () => Promise<void>): (() => void) => {
    process.on(signal, handler);
    return () => {
      process.off(signal, handler);
    };
  },
  writeErr: (message: string): void => {
    process.stderr.write(`${message}\n`);
  },
  /** The normal screen's writer: the exit summary is printed here, after the alt screen is gone. */
  writeOut: (message: string): void => {
    process.stdout.write(`${message}\n`);
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

/**
 * Print what the user is left with once the screen is gone. The host keeps the last session
 * readable after `close`, so this runs after teardown; a host that never opened a session
 * throws and has nothing to summarize, which must not disturb the run's exit code.
 */
function writeExitSummary(host: ChatHost, deps: ChatCommandDeps): void {
  let state: ChatHostState;
  try {
    state = host.current();
  } catch {
    return;
  }
  deps.writeOut(formatChatExitSummary(state));
}

/** The props the screen draws with: the terminal's own theme, build, launch directory and home. */
function screenProps(host: ChatHost, deps: ChatCommandDeps, cwd: string): ChatAppProps {
  return {
    host,
    theme: resolveChatTheme({ env: deps.env, colorLevel: chalk.level }),
    version: NAX_VERSION,
    cwd,
    home: homedir(),
  };
}

/** Own the terminal lifetime; signal shutdown awaits lock release before allowing exit. */
async function runShell(host: ChatHost, deps: ChatCommandDeps, cwd: string): Promise<void> {
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
    shell = deps.renderChat(screenProps(host, deps, cwd));
    await shell.waitUntilExit();
    await shutdown;
  } finally {
    try {
      await close();
    } finally {
      shell?.unmount();
      for (const remove of removers) remove();
      writeExitSummary(host, deps);
    }
  }
}

async function chatResources(repoRoot: string, config: NaxConfig, deps: ChatCommandDeps): Promise<ChatResources> {
  let registry: PluginRegistry;
  try {
    registry = await deps.loadPlugins(
      join(globalConfigDir(), "plugins"),
      join(repoRoot, ".nax", "plugins"),
      config.plugins ?? [],
      repoRoot,
      config.disabledPlugins,
    );
  } catch (error) {
    deps.writeErr(`nax plugins unavailable: ${errorMessage(error)}`);
    registry = new PluginRegistry([]);
  }
  try {
    const catalog = await deps.loadResourceCatalog({
      repoRoot,
      config,
      env: deps.env,
      naxPluginPackages: await naxPluginPackages(registry.getResourceDirs()),
    });
    const outputDir = projectOutputDir(getProjectKey(config, repoRoot), config.outputDir);
    const mcp = await deps.createChatMcp({ config, catalog, repoRoot, env: deps.env });
    return {
      catalog,
      toolProviders: [
        createSkillsProvider(async () => catalog),
        createWorkflowProvider({
          repoRoot,
          outputDir,
          maxIterations: isWorkflowMode(config) ? undefined : config.execution.maxIterations,
        }),
        ...mcp.providers,
      ],
      pluginHandlers: registry.getLoopHandlers(),
      naxPlugins: registry.plugins.map(({ name, provides }) => ({ name, provides })),
      mcp: mcp.state,
      teardown: async () => {
        try {
          await mcp.close();
        } finally {
          await registry.teardownAll();
        }
      },
    };
  } catch (error) {
    await registry.teardownAll();
    throw error;
  }
}

async function discoverModels(config: NaxConfig, deps: ChatCommandDeps): Promise<readonly string[]> {
  const requested = [
    ...new Set([
      ...tierModels(config).map((model) => model.slice(0, model.indexOf("/"))),
      ...(config.agent?.native?.catalogOverrides ?? []).map(({ provider }) => provider),
    ]),
  ];
  let availableProviders: string[] = [];
  try {
    const report = await deps.collectAuthList(requested);
    availableProviders = report.providers.filter(({ available }) => available).map(({ providerId }) => providerId);
  } catch {
    // Auth discovery is optional; explicitly configured models remain usable.
  }
  return chatModelChoices({ config, availableProviders, listCatalogModels: deps.listCatalogModels });
}

async function composeChat(options: ChatCommandOptions, deps: ChatCommandDeps, cwd: string): Promise<void> {
  const naxDir = deps.findProjectDir(cwd);
  const config = options.profile?.length
    ? await deps.loadConfig(naxDir ?? undefined, { profile: options.profile })
    : await deps.loadConfig(naxDir ?? undefined);
  const repoRoot = naxDir ? dirname(naxDir) : cwd;
  const models = await discoverModels(config, deps);
  const effortLevels = await chatEffortLevels({
    config,
    models: options.model === undefined ? models : [...models, options.model],
    lookupThinkingLevels: deps.lookupThinkingLevels,
  });
  const resources = await chatResources(repoRoot, config, deps);
  const log = (stage: string, message: string): void => deps.writeErr(`[${stage}] ${message}`);
  const logger = getSafeLogger() ?? { warn: log, error: log, info: log, debug: log };
  const storage = deps.createChatStorage({ pid: process.pid, now: () => new Date(), logger });
  const chain = await interactionChain(config, deps);
  const naxEntry = deps.naxEntry();
  let host: ChatHost;
  try {
    host = deps.createChatHost({
      models,
      acp: deps.createAcpCatalog({ env: deps.env }),
      effortLevels,
      ...(naxEntry === undefined ? {} : { naxEntry }),
      config,
      cwd,
      repoRoot,
      resources,
      storage,
      chain,
      now: () => new Date(),
      logger,
    });
  } catch (error) {
    try {
      await resources.teardown();
    } finally {
      await chain?.destroy();
    }
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
  await runShell(host, deps, cwd);
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
  // CLI bootstrap anchor: trust the launch directory before any repository composition.
  const cwd = resolve(options.dir ?? process.cwd());
  try {
    await deps.ensureTrusted(cwd);
  } catch (error) {
    if (error instanceof NaxError && error.code === "PROJECT_UNTRUSTED") {
      const root = error.context?.root ?? cwd;
      deps.writeErr(`Project not trusted: ${root}`);
      deps.writeErr(typeof error.context?.hint === "string" ? error.context.hint : `run: nax trust add ${root}`);
      deps.setExitCode(2);
    } else {
      deps.writeErr(errorMessage(error));
      deps.setExitCode(error instanceof NaxError && error.code === "TRUST_STORE_UNREADABLE" ? 2 : 1);
    }
    return;
  }
  try {
    await composeChat(options, deps, cwd);
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
