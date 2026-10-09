/**
 * The `nax-agent` command line (S5 spec §6.1). S5-0 knows the ACP server only;
 * `login <provider>` (S5-4).
 */
import { parseArgs } from "node:util";
import type { AuthMethod } from "@nathapp/nax-agent";

export interface CliFlags {
  readonly configDir?: string;
  readonly sessionsDir?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly bashApproval?: string;
}

export type CliCommand =
  | { readonly kind: "acp"; readonly flags: CliFlags }
  | {
      readonly kind: "login";
      readonly provider: string;
      readonly method?: AuthMethod;
      readonly flags: CliFlags;
    }
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  | { readonly kind: "usage-error"; readonly message: string };

export const USAGE = [
  "Usage: nax-agent [acp] [options]",
  "       nax-agent login <provider> [--method api-key|oauth] [--config-dir <dir>]",
  "",
  "Runs the nax-agent ACP server on stdio, or logs in to a model provider",
  "(the credential is stored in <config-dir>, shared with `nax auth login`).",
  "",
  "Options:",
  "  --config-dir <dir>                    nax config directory (default ~/.nax)",
  "  --sessions-dir <dir>                  session storage (default <config-dir>/.agent-server/sessions)",
  "  --model <provider/model[effort]>      default model for new sessions",
  "  --mode <none|read|ask|full>           default mode for new sessions (default ask)",
  "  --bash-approval <gated|escalate|raw>  default bash approval (default gated)",
  "  --method <api-key|oauth>              login method (login only; default: ask)",
  "  --version                             print the version",
  "  --help                                print this help",
  "",
  "Each option can also be set as NAX_AGENT_<OPTION>, for example NAX_AGENT_MODEL.",
].join("\n");

const OPTIONS = {
  "config-dir": { type: "string" },
  "sessions-dir": { type: "string" },
  model: { type: "string" },
  mode: { type: "string" },
  "bash-approval": { type: "string" },
  method: { type: "string" },
  version: { type: "boolean" },
  help: { type: "boolean" },
} as const;

function flag<K extends keyof CliFlags>(key: K, value: string | undefined): Pick<CliFlags, K> {
  return (value === undefined ? {} : { [key]: value }) as Pick<CliFlags, K>;
}

function parse(argv: readonly string[]) {
  return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
}

const LOGIN_METHODS: readonly AuthMethod[] = ["api-key", "oauth"];

function flagsOf(values: ReturnType<typeof parse>["values"]): CliFlags {
  return {
    ...flag("configDir", values["config-dir"]),
    ...flag("sessionsDir", values["sessions-dir"]),
    ...flag("model", values.model),
    ...flag("mode", values.mode),
    ...flag("bashApproval", values["bash-approval"]),
  };
}

function loginCommand(words: readonly string[], method: string | undefined, flags: CliFlags): CliCommand {
  const [, provider, ...extra] = words;
  if (provider === undefined || extra.length > 0) {
    return { kind: "usage-error", message: "login takes one provider: nax-agent login <provider>" };
  }
  if (method === undefined) return { kind: "login", provider, flags };
  const known = LOGIN_METHODS.find((m) => m === method);
  if (known === undefined) {
    return { kind: "usage-error", message: `invalid --method "${method}"; expected api-key or oauth` };
  }
  return { kind: "login", provider, method: known, flags };
}

export function parseCli(argv: readonly string[]): CliCommand {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return { kind: "usage-error", message: error instanceof Error ? error.message : String(error) };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: "help" };
  if (values.version === true) return { kind: "version" };
  const flags = flagsOf(values);
  // An editor's terminal login appends `login <provider>` to the server invocation (M-34).
  const words = positionals[0] === "acp" ? positionals.slice(1) : positionals;
  if (words[0] === "login") return loginCommand(words, values.method, flags);
  if (words.length > 0) return { kind: "usage-error", message: `unknown command: ${positionals.join(" ")}` };
  if (values.method !== undefined) return { kind: "usage-error", message: "--method is only valid with login" };
  return { kind: "acp", flags };
}
