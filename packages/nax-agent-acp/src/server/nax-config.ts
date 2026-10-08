/**
 * The subset of nax's global `config.json` the ACP server reads (S5 spec §6.2,
 * master plan M-3). It is a local reader, not nax's config loader: nax-agent-acp
 * does not depend on nax. Any problem falls back to the defaults with one
 * warning; the server still starts.
 */
import { join } from "node:path";
import type { AgentSessionProfile, CredentialAuthConfig, CredentialsConfig } from "@nathapp/nax-agent";
import { z } from "zod";

export type ReadTextFile = (path: string, encoding: "utf8") => Promise<string>;

export type BashApproval = "gated" | "escalate" | "raw";

export const TIERS = ["fast", "balanced", "powerful"] as const;

export interface TierModel {
  readonly tier: (typeof TIERS)[number];
  readonly model: string;
  readonly contextWindow?: number;
}

export interface AgentServerSection {
  readonly defaultMode?: AgentSessionProfile;
  readonly bashApproval?: BashApproval;
  readonly sessionsDir?: string;
}

export interface NaxConfigSubset {
  readonly tiers: readonly TierModel[];
  readonly catalogOverrides: readonly Readonly<Record<string, unknown>>[];
  readonly auth: CredentialAuthConfig;
  readonly agentServer: AgentServerSection;
}

export interface LoadedNaxConfig {
  readonly config: NaxConfigSubset;
  readonly warning?: string;
}

export const MODES = ["none", "read", "ask", "full"] as const;
export const BASH_APPROVALS = ["gated", "escalate", "raw"] as const;

const ModelEntrySchema = z.union([
  z.string().min(1),
  z.object({ model: z.string().min(1), contextWindow: z.number().int().positive().optional() }),
]);

/** nax's AuthConfigSchema (packages/nax/src/config/schemas-auth.ts), same defaults. */
const AuthSchema = z
  .object({
    source: z.enum(["file", "exec"]).default("file"),
    exec: z
      .object({
        command: z.array(z.string().min(1)).min(1),
        timeoutMs: z.number().int().min(1000).max(60000).default(10000),
      })
      .optional(),
    onChange: z.enum(["warn", "refuse"]).default("warn"),
  })
  .superRefine((auth, ctx) => {
    if (auth.source === "exec" && auth.exec === undefined) {
      ctx.addIssue({ code: "custom", path: ["exec"], message: 'exec is required when auth.source is "exec"' });
    }
  });

const SubsetSchema = z.object({
  models: z.object({ native: z.record(z.string(), z.unknown()).optional() }).optional(),
  agent: z
    .object({
      native: z.object({ catalogOverrides: z.array(z.record(z.string(), z.unknown())).optional() }).optional(),
    })
    .optional(),
  auth: AuthSchema.optional(),
  agentServer: z
    .object({
      defaultMode: z.enum(MODES).optional(),
      bashApproval: z.enum(BASH_APPROVALS).optional(),
      sessionsDir: z.string().min(1).optional(),
    })
    .optional(),
});

const DEFAULT_AUTH: CredentialAuthConfig = { source: "file", onChange: "warn" };

export const EMPTY_NAX_CONFIG: NaxConfigSubset = {
  tiers: [],
  catalogOverrides: [],
  auth: DEFAULT_AUTH,
  agentServer: {},
};

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tiersFrom(native: Readonly<Record<string, unknown>> | undefined): { tiers: TierModel[]; issue?: string } {
  const tiers: TierModel[] = [];
  for (const tier of TIERS) {
    const raw = native?.[tier];
    if (raw === undefined) continue;
    const entry = ModelEntrySchema.safeParse(raw);
    if (!entry.success) return { tiers: [], issue: `models.native.${tier}: ${entry.error.issues[0]?.message}` };
    const value = entry.data;
    tiers.push(
      typeof value === "string"
        ? { tier, model: value }
        : {
            tier,
            model: value.model,
            ...(value.contextWindow !== undefined ? { contextWindow: value.contextWindow } : {}),
          },
    );
  }
  return { tiers };
}

function authFrom(auth: z.infer<typeof AuthSchema> | undefined): CredentialAuthConfig {
  if (auth === undefined) return DEFAULT_AUTH;
  return {
    source: auth.source,
    onChange: auth.onChange,
    ...(auth.exec !== undefined ? { exec: { command: auth.exec.command, timeoutMs: auth.exec.timeoutMs } } : {}),
  };
}

function fallback(path: string, reason: string): LoadedNaxConfig {
  return { config: EMPTY_NAX_CONFIG, warning: `ignoring ${path}: ${reason}; using built-in defaults` };
}

export async function loadNaxConfig(configDir: string, readFile: ReadTextFile): Promise<LoadedNaxConfig> {
  const path = join(configDir, "config.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { config: EMPTY_NAX_CONFIG };
    return fallback(path, message(error));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Not the parser's message: on Node it quotes the offending text, which may hold a key.
    return fallback(path, "invalid JSON");
  }
  const parsed = SubsetSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fallback(path, `${issue?.path.join(".")}: ${issue?.message}`);
  }
  const { tiers, issue } = tiersFrom(parsed.data.models?.native);
  if (issue !== undefined) return fallback(path, issue);
  return {
    config: {
      tiers,
      catalogOverrides: parsed.data.agent?.native?.catalogOverrides ?? [],
      auth: authFrom(parsed.data.auth),
      agentServer: parsed.data.agentServer ?? {},
    },
  };
}

/** Credentials read from `configDir` with the auth block re-read per call, as nax does (M-3). */
export function credentialsFor(configDir: string, readFile: ReadTextFile): CredentialsConfig {
  return {
    configDir: () => configDir,
    readAuthConfig: async () => (await loadNaxConfig(configDir, readFile)).config.auth,
  };
}
