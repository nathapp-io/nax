/**
 * `memory` config block — the repository-wide memory settings.
 *
 * `.strict()` throughout, like `schemas-mcp.ts`: an unknown key must fail
 * loudly. The keys a later feature owns (`stages` for memory-run-stages) are
 * rejected until that feature widens this schema, because a silently stripped
 * key reads at runtime as "memory is broken" rather than "this build does not
 * have that feature yet".
 *
 * `NaxConfig.memory` is optional on the hand-written interface, so readers go
 * through `memoryConfigOf` rather than reaching for `config.memory` directly.
 *
 * `inRun` is the workflow-run switch, separate from `enabled`: chat keeps the
 * memory host and index either way, while `nax run` gets neither when it is
 * false. The design's `memory.stages` list is not built — the run tools always
 * attach to `run`-stage sessions only.
 *
 * `koda` is the third provider's block (`memory-koda-provider`): the koda
 * project a repo links to, and the global-only url/headers that reach it. It
 * has no default, so it is absent from `NaxConfigSchema.parse({}).memory`.
 */
import { z } from "zod";
import type { NaxConfig } from "./runtime-types";
import type { MemoryConfig } from "./runtime-types-memory";
import { MCP_SERVER_ID_RE } from "./schemas-mcp";
import { isRemotePlainHttp } from "./schemas-model";

/** Floor for the injected index's byte cap — small enough that omission is observable. */
export const MEMORY_INDEX_BYTES_MIN = 512;
/** Ceiling for the injected index's byte cap (256 KiB): the index is prompt text, not a corpus. */
export const MEMORY_INDEX_BYTES_MAX = 262_144;
/** Default index byte cap (24 KiB). */
export const MEMORY_INDEX_BYTES_DEFAULT = 24_576;

const NonEmptyNameSchema = z.string().min(1);

/** The rules an `mcp.servers` key already follows (`schemas-mcp.ts`): the id charset, and no `__`. */
const MemoryMcpServerSchema = z
  .string()
  .regex(MCP_SERVER_ID_RE)
  .refine((id) => !id.includes("__"), { message: "server id may not contain '__' (the tool-name separator)" });

/**
 * `memory.mcp` — which `mcp.servers` entry holds the memories and what its tools are called.
 * The defaults are OpenMemory's names (`tools`/`args` use `.prefault({})` so their inner defaults apply, Zod 4). `tools.forget` and `args.id` have none: OpenMemory has no
 * single-memory delete tool, so both are whatever the user's own server provides, and
 * `validateMemoryProvider` requires them together.
 */
export const MemoryMcpConfigSchema = z
  .object({
    server: MemoryMcpServerSchema,
    tools: z
      .object({
        search: NonEmptyNameSchema.default("search_memory"),
        add: NonEmptyNameSchema.default("add_memories"),
        forget: NonEmptyNameSchema.optional(),
      })
      .strict()
      .prefault({}),
    args: z
      .object({
        query: NonEmptyNameSchema.default("query"),
        text: NonEmptyNameSchema.default("text"),
        id: NonEmptyNameSchema.optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict();

/** koda's project slug rule: lowercase letters, digits and dashes, no leading dash. */
export const KODA_PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** Plain http is accepted only to a loopback host, because the bearer key travels with every request. */
const KODA_URL_HTTPS_MESSAGE = "memory.koda.url must use https unless the host is loopback";
const KODA_URL_SCHEME_MESSAGE = "memory.koda.url must be an http or https URL";
const KODA_PROJECT_MESSAGE = "memory.koda.project must be a koda project slug (lowercase letters, digits and dashes)";

/** Whether `value` parses as an http or https URL — a bare `z.string().url()` admits any scheme. */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    // Not a URL at all: the scheme message covers it.
    return false;
  }
}

/**
 * `memory.koda.url`: an http or https URL, and plain http only to a loopback host. One issue per
 * bad value — a remote plain-http url would otherwise also report the scheme.
 */
const KodaUrlSchema = z.string().superRefine((value, ctx) => {
  if (!isHttpUrl(value)) {
    ctx.addIssue({ code: "custom", message: KODA_URL_SCHEME_MESSAGE });
    return;
  }
  if (isRemotePlainHttp(value)) ctx.addIssue({ code: "custom", message: KODA_URL_HTTPS_MESSAGE });
});

/**
 * `memory.koda` — the koda project that holds the memories, and how to reach it.
 *
 * `url` and `headers` are global-only (`rejectGlobalOnlyKeys`); `project` is what
 * `nax memory link` writes into the project layer. No default: the block is
 * absent until a user configures koda, and `validateMemoryProvider` requires
 * `url` and `project` once `memory.provider` is `"koda"`.
 */
export const MemoryKodaConfigSchema = z
  .object({
    /** koda's API root *including* its global prefix (`https://koda.example/api`). */
    url: KodaUrlSchema.optional(),
    project: z.string().regex(KODA_PROJECT_SLUG_RE, KODA_PROJECT_MESSAGE).optional(),
    /** Static request headers (the bearer agent key), carried literally — no `${VAR}` expansion, no `auth` source. */
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const MemoryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    provider: z.enum(["local", "mcp", "koda"]).default("local"),
    mcp: MemoryMcpConfigSchema.optional(),
    koda: MemoryKodaConfigSchema.optional(),
    writeMode: z.enum(["direct", "proposal"]).default("direct"),
    indexBytes: z
      .number()
      .int()
      .min(MEMORY_INDEX_BYTES_MIN)
      .max(MEMORY_INDEX_BYTES_MAX)
      .default(MEMORY_INDEX_BYTES_DEFAULT),
    askOnSave: z.boolean().default(true),
    inRun: z.boolean().default(true),
  })
  .strict();

/**
 * The memory block for a resolved config. `NaxConfig.memory` is optional, so
 * every reader resolves through here and the schema stays the single source of
 * the defaults.
 */
export function memoryConfigOf(config: Pick<NaxConfig, "memory">): MemoryConfig {
  return config.memory ?? MemoryConfigSchema.parse({});
}

/** The slice of the parsed config `validateMemoryProvider` reads; partly-checked input, so all optional. */
interface MemoryProviderInput {
  readonly memory?: {
    readonly provider?: string;
    readonly writeMode?: string;
    readonly mcp?: {
      readonly server: string;
      readonly tools?: { readonly forget?: string };
      readonly args?: { readonly id?: string };
    };
    readonly koda?: { readonly url?: string; readonly project?: string };
  };
  readonly mcp?: { readonly servers?: Record<string, unknown> };
}

/**
 * Cross-section rules for `memory.provider`, called from the `NaxConfigSchema` `superRefine`.
 * The rules are independent: one config can raise several issues. An absent `mcp` block has no
 * servers. A `memory.mcp` block under `provider: "local"` is valid and unused, so only the server
 * and forget/id rules look at it regardless of the provider.
 *
 * `provider: "koda"` requires both the url (global, the API root) and the project (written by
 * `nax memory link`): without either the provider is unreachable, and the pinned messages name
 * the file to edit. Proposal write mode is allowed with koda — koda holds pending writes itself.
 */
export function validateMemoryProvider(data: MemoryProviderInput, ctx: z.RefinementCtx): void {
  const memory = data.memory;
  if (memory === undefined) return;
  const isMcp = memory.provider === "mcp";
  const isKoda = memory.provider === "koda";
  if (isMcp && memory.mcp === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["memory", "mcp"],
      message: 'memory.provider "mcp" needs a memory.mcp block naming the server',
    });
  }
  if (isKoda && memory.koda?.url === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["memory", "koda", "url"],
      message: 'memory.provider "koda" needs memory.koda.url in ~/.nax/config.json',
    });
  }
  if (isKoda && memory.koda?.project === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["memory", "koda", "project"],
      message: 'memory.provider "koda" needs memory.koda.project (run nax memory link <koda-project>)',
    });
  }
  if (memory.mcp !== undefined && !Object.hasOwn(data.mcp?.servers ?? {}, memory.mcp.server)) {
    ctx.addIssue({
      code: "custom",
      path: ["memory", "mcp", "server"],
      message: `memory.mcp.server "${memory.mcp.server}" is not defined in mcp.servers`,
    });
  }
  if (isMcp && memory.writeMode === "proposal") {
    ctx.addIssue({
      code: "custom",
      path: ["memory", "writeMode"],
      message: 'memory.writeMode "proposal" needs a provider that holds pending writes; provider "mcp" does not',
    });
  }
  if (memory.mcp?.tools?.forget !== undefined && memory.mcp.args?.id === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["memory", "mcp", "args", "id"],
      message: "memory.mcp.args.id is required when memory.mcp.tools.forget is set",
    });
  }
}
