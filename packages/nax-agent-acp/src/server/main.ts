/**
 * The `nax-agent` entry point as a function of its environment (S5 spec §6.1), so
 * the unit suite covers it without spawning a process. Exit codes: 0 clean stop,
 * 1 connection failure, 2 usage or option error.
 */
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { configureCredentials, createFileTranscriptStore, redactSecrets, setAgentLogger } from "@nathapp/nax-agent";
import { connectMcp } from "@nathapp/nax-agent/mcp";
import { type AuthPorts, loadServerAuth, NAX_AGENT_AUTH } from "#src/server/auth";
import { type CliCommand, type CliFlags, parseCli, USAGE } from "#src/server/cli";
import { buildAgentApp, serveStdio } from "#src/server/connection";
import {
  type ConfigWriter,
  type ModelPorts,
  NAX_AGENT_MODELS,
  NODE_CONFIG_WRITER,
  offerDefaultModel,
} from "#src/server/default-model";
import { stderrLogger } from "#src/server/logger";
import { runLoginCommand } from "#src/server/login";
import { createMcpConnector } from "#src/server/mcp/connect";
import { credentialsFor, loadNaxConfig, type ReadTextFile } from "#src/server/nax-config";
import { catalogOverridesFrom, nativeOpenSession } from "#src/server/open-session";
import { type Env, resolveConfigDir, resolveServerOptions } from "#src/server/options";
import { createSessionRegistry } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
import { createSessionStorage } from "#src/server/storage";
import { fsReadOldText } from "#src/server/translate/diff";
import { packageVersion } from "#src/server/version";

export interface MainDeps {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly homedir: string;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly writeErr: (text: string) => void;
  readonly readFile: ReadTextFile;
  readonly onSignal: (handler: () => void) => void;
  /** stdin is an interactive terminal (login needs one). */
  readonly isTTY: boolean;
  /** nax-agent's auth API; tests inject a fake. Defaults to the real one. */
  readonly auth?: AuthPorts;
  /** The catalog behind the default-model pick after login; tests inject a fake. */
  readonly models?: ModelPorts;
  /** Writes config.json after login; tests inject a fake. */
  readonly writeConfig?: ConfigWriter;
}

export async function main(deps: MainDeps): Promise<number> {
  const command = parseCli(deps.argv);
  switch (command.kind) {
    case "help":
      deps.stdout.write(`${USAGE}\n`);
      return 0;
    case "version":
      deps.stdout.write(`${packageVersion()}\n`);
      return 0;
    case "usage-error":
      deps.writeErr(`nax-agent: ${command.message}\n\n${USAGE}\n`);
      return 2;
    case "login":
      return login(command, deps);
    case "acp":
      return serveAcp(command.flags, deps);
  }
}

async function login(command: Extract<CliCommand, { kind: "login" }>, deps: MainDeps): Promise<number> {
  // warn, not info: info lines would land in the middle of the interactive prompts.
  setAgentLogger(stderrLogger(deps.env.NAX_AGENT_LOG === "debug" ? "debug" : "warn", deps.writeErr));
  const configDir = resolveConfigDir(command.flags, deps.env, deps.homedir);
  configureCredentials(credentialsFor(configDir, deps.readFile));
  const auth = deps.auth ?? NAX_AGENT_AUTH;
  const pinned = [command.flags.model, deps.env.NAX_AGENT_MODEL].some((m) => m !== undefined && m !== "");
  return runLoginCommand(
    { provider: command.provider, ...(command.method !== undefined ? { method: command.method } : {}) },
    {
      isTTY: deps.isTTY,
      out: (line) => deps.stdout.write(`${line}\n`),
      err: (line) => deps.writeErr(`${line}\n`),
      auth,
      offerModel: (provider) =>
        offerDefaultModel({
          provider,
          configDir,
          isTTY: deps.isTTY,
          pinned,
          interaction: auth.interaction((line) => deps.stdout.write(`${line}\n`)),
          out: (line) => deps.stdout.write(`${line}\n`),
          models: deps.models ?? NAX_AGENT_MODELS,
          readFile: deps.readFile,
          write: deps.writeConfig ?? NODE_CONFIG_WRITER,
        }),
    },
  );
}

async function serveAcp(flags: CliFlags, deps: MainDeps): Promise<number> {
  const logger = stderrLogger(deps.env.NAX_AGENT_LOG === "debug" ? "debug" : "info", deps.writeErr);
  setAgentLogger(logger);
  const configDir = resolveConfigDir(flags, deps.env, deps.homedir);
  const loaded = await loadNaxConfig(configDir, deps.readFile);
  if (loaded.warning !== undefined) logger.warn("config", loaded.warning);
  const resolved = resolveServerOptions({ flags, env: deps.env, file: loaded.config, configDir });
  if (!resolved.ok) {
    deps.writeErr(`nax-agent: ${resolved.message}\n`);
    return 2;
  }
  configureCredentials(credentialsFor(configDir, deps.readFile));
  const overrides = catalogOverridesFrom(resolved.options.catalogOverrides, logger);
  const auth = await loadServerAuth({
    options: resolved.options,
    overrides,
    ports: deps.auth ?? NAX_AGENT_AUTH,
    logger,
  });
  const transcripts = createFileTranscriptStore(resolved.options.sessionsDir);
  const storage = createSessionStorage({
    dir: resolved.options.sessionsDir,
    pid: process.pid,
    now: () => new Date(),
    logger,
  });
  const registry = createSessionRegistry({
    options: resolved.options,
    openSession: nativeOpenSession({
      transcripts,
      catalogOverrides: overrides,
      turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    }),
    storage,
    transcripts,
    newId: randomUUID,
    now: () => new Date(),
    readOldText: fsReadOldText(),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    ensureCredentials: (model) => auth.ensureCredentials(model),
    reloadOptions: async () => {
      const reloaded = await loadNaxConfig(configDir, deps.readFile);
      const again = resolveServerOptions({ flags, env: deps.env, file: reloaded.config, configDir });
      const problem = reloaded.warning ?? (again.ok ? undefined : again.message);
      if (problem === undefined) return again.ok ? { options: again.options } : {};
      // Config paths and option names only, never file contents.
      logger.warn("config", redactSecrets(problem));
      return { ...(again.ok ? { options: again.options } : {}), problem: redactSecrets(problem) };
    },
    connectMcp: createMcpConnector({
      connect: connectMcp,
      timeoutMs: resolved.options.mcpConnectTimeoutSeconds * 1000,
      clientVersion: packageVersion(),
    }),
  });
  const connection = serveStdio(buildAgentApp({ version: packageVersion(), registry, logger, auth }), deps);
  const stop = (): void => connection.close();
  deps.onSignal(stop);
  deps.stdin.once("end", stop);
  logger.info("server", "nax-agent ACP server started", { configDir, sessionsDir: resolved.options.sessionsDir });
  // Scalars only: catalog overrides can carry provider headers (API keys).
  const { defaultModel, defaultMode, bashApproval, tiers, catalogOverrides, mcpConnectTimeoutSeconds } =
    resolved.options;
  logger.debug("server", "resolved options", {
    defaultModel,
    defaultMode,
    bashApproval,
    tiers: tiers.map((t) => `${t.tier}=${t.model}`),
    catalogOverrides: catalogOverrides.length,
    mcpConnectTimeoutSeconds,
  });
  try {
    await connection.closed;
    return 0;
  } catch (error) {
    logger.error("server", "connection failed", { error: error instanceof Error ? error.message : String(error) });
    return 1;
  } finally {
    // S5-2 shutdown (M-16): no running turn outlives its client.
    await registry.closeAll();
  }
}
