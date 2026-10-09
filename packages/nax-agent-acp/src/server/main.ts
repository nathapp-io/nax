/**
 * The `nax-agent` entry point as a function of its environment (S5 spec §6.1), so
 * the unit suite covers it without spawning a process. Exit codes: 0 clean stop,
 * 1 connection failure, 2 usage or option error.
 */
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { configureCredentials, createFileTranscriptStore, setAgentLogger } from "@nathapp/nax-agent";
import { type CliFlags, parseCli, USAGE } from "#src/server/cli";
import { buildAgentApp, serveStdio } from "#src/server/connection";
import { stderrLogger } from "#src/server/logger";
import { credentialsFor, loadNaxConfig, type ReadTextFile } from "#src/server/nax-config";
import { catalogOverridesFrom, nativeOpenSession } from "#src/server/open-session";
import { type Env, resolveConfigDir, resolveServerOptions } from "#src/server/options";
import { createSessionRegistry } from "#src/server/registry";
import { TURN_TIMEOUT_SECONDS } from "#src/server/server-session";
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
    case "acp":
      return serveAcp(command.flags, deps);
  }
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
  const registry = createSessionRegistry({
    options: resolved.options,
    openSession: nativeOpenSession({
      transcripts: createFileTranscriptStore(resolved.options.sessionsDir),
      catalogOverrides: catalogOverridesFrom(resolved.options.catalogOverrides, logger),
      turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
    }),
    newId: randomUUID,
    readOldText: fsReadOldText(),
    logger,
    turnTimeoutSeconds: TURN_TIMEOUT_SECONDS,
  });
  const connection = serveStdio(buildAgentApp({ version: packageVersion(), registry, logger }), deps);
  const stop = (): void => connection.close();
  deps.onSignal(stop);
  deps.stdin.once("end", stop);
  logger.info("server", "nax-agent ACP server started", { configDir, sessionsDir: resolved.options.sessionsDir });
  // Scalars only: catalog overrides can carry provider headers (API keys).
  const { defaultModel, defaultMode, bashApproval, tiers, catalogOverrides } = resolved.options;
  logger.debug("server", "resolved options", {
    defaultModel,
    defaultMode,
    bashApproval,
    tiers: tiers.map((t) => `${t.tier}=${t.model}`),
    catalogOverrides: catalogOverrides.length,
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
