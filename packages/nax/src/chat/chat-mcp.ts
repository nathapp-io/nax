/**
 * MCP servers for `nax chat`: configured and catalog servers composed into one lazily
 * connected pool, attached as discovered tool providers. The chat owns the pool's lifetime.
 */
import type { ToolProvider } from "@nathapp/nax-agent";
import type { McpServerConfig, NaxConfig } from "@/config";
import {
  createMcpPool,
  createMcpProviders,
  type McpLockFile,
  type McpPool,
  type McpServerEvent,
  type McpWithheldEntry,
  resolveMcpLock,
} from "@/mcp";
import {
  type McpServerSource,
  mergeCatalogMcpServers,
  type ResourceCatalog,
  type ResourceDiagnostic,
} from "@/resources";

/** One attempt per server: session open resolves providers one after another, so retries would stall the start. */
export const CHAT_MCP_RETRY = { maxAttempts: 1, baseDelayMs: 0 } as const;

/** Built-in provider ids; an MCP server may not shadow them. */
const RESERVED_SERVER_IDS: ReadonlySet<string> = new Set(["nax-skills", "nax-agents", "nax-workflow"]);

export interface ChatMcpServerRow {
  readonly id: string;
  readonly source: McpServerSource;
  readonly plugin?: string;
  readonly transport: "stdio" | "http";
  /** False for a catalog server the lock does not list; it is not connected. */
  readonly locked: boolean;
}

export interface ChatMcpState {
  readonly servers: readonly ChatMcpServerRow[];
  readonly diagnostics: readonly ResourceDiagnostic[];
  /** Pool connection events, read live for /mcp. */
  events(): readonly McpServerEvent[];
  /** Tools the lock withheld so far, read live for /mcp. */
  withheld(): readonly McpWithheldEntry[];
}

export interface ChatMcp {
  readonly state: ChatMcpState;
  readonly providers: readonly ToolProvider[];
  close(): Promise<void>;
}

export const _chatMcpDeps = {
  createMcpPool,
  createMcpProviders,
  readLock: (repoRoot: string): Promise<McpLockFile | undefined> => resolveMcpLock(repoRoot),
};

type Env = Readonly<Record<string, string | undefined>>;

const CATALOG_DIAGNOSTIC_SUFFIXES = [".mcp.json", ".claude.json"] as const;

function reservedDiagnostic(id: string): ResourceDiagnostic {
  return {
    severity: "error",
    // No file owns this finding; name the configuration surface instead.
    path: `mcp.servers.${id}`,
    origin: { kind: "claude-project" },
    message: `[resources] mcp server id ${id} is reserved`,
  };
}

/** A catalog server is attached only once `nax mcp lock` has pinned it; configured servers are not gated. */
function isLocked(lock: McpLockFile | undefined, id: string, source: McpServerSource): boolean {
  return source === "config" || (lock !== undefined && Object.hasOwn(lock.servers, id));
}

function noop(): Promise<void> {
  return Promise.resolve();
}

export async function createChatMcp(input: {
  readonly config: NaxConfig;
  readonly catalog: ResourceCatalog;
  readonly repoRoot: string;
  readonly env: Env;
}): Promise<ChatMcp> {
  const merged = mergeCatalogMcpServers({ mcp: input.config.mcp, catalog: input.catalog, env: input.env });
  const lock = await _chatMcpDeps.readLock(input.repoRoot);
  const diagnostics: ResourceDiagnostic[] = [...merged.diagnostics];
  const rows: ChatMcpServerRow[] = [];
  const attached: Record<string, McpServerConfig> = {};

  for (const [id, server] of Object.entries(merged.config.servers)) {
    if (!server.enabled) continue;
    if (RESERVED_SERVER_IDS.has(id)) {
      diagnostics.push(reservedDiagnostic(id));
      continue;
    }
    const origin = merged.sources.get(id) ?? { source: "config" as const };
    const locked = isLocked(lock, id, origin.source);
    rows.push({
      id,
      source: origin.source,
      ...(origin.plugin === undefined ? {} : { plugin: origin.plugin }),
      transport: server.url === undefined ? "stdio" : "http",
      locked,
    });
    // `stages` picks `nax run` stages; a chat session is not one.
    if (locked) attached[id] = { ...server, stages: ["*"] };
  }
  diagnostics.push(
    ...input.catalog.diagnostics.filter((d) => CATALOG_DIAGNOSTIC_SUFFIXES.some((suffix) => d.path.endsWith(suffix))),
  );

  const withheld = new Map<string, McpWithheldEntry>();
  let pool: McpPool | undefined;
  let providers: readonly ToolProvider[] = [];
  if (Object.keys(attached).length > 0) {
    pool = _chatMcpDeps.createMcpPool({ servers: attached, retry: CHAT_MCP_RETRY });
    providers = _chatMcpDeps.createMcpProviders({
      config: { servers: attached },
      pool,
      projectRoot: input.repoRoot,
      // The lock that decided which servers attach also decides which tools do.
      readLock: async () => lock,
      // Every session reopen resolves providers again and re-reports; one entry per tool.
      onWithheld: (entry) => withheld.set(JSON.stringify([entry.serverId, entry.name]), entry),
    });
  }

  let closing: Promise<void> | undefined;
  return {
    state: {
      servers: rows,
      diagnostics,
      events: () => pool?.events() ?? [],
      withheld: () => [...withheld.values()],
    },
    providers,
    close: () => (closing ??= pool?.close() ?? noop()),
  };
}
