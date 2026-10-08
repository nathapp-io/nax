/**
 * The `nax-agent` command line (S5 spec §6.1). S5-0 knows the ACP server only;
 * S5-4 adds `login <provider>`.
 */
import { parseArgs } from "node:util";

export interface CliFlags {
  readonly configDir?: string;
  readonly sessionsDir?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly bashApproval?: string;
}

export type CliCommand =
  | { readonly kind: "acp"; readonly flags: CliFlags }
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  | { readonly kind: "usage-error"; readonly message: string };

export const USAGE = [
  "Usage: nax-agent [acp] [options]",
  "",
  "Runs the nax-agent ACP server on stdio.",
  "",
  "Options:",
  "  --config-dir <dir>                    nax config directory (default ~/.nax)",
  "  --sessions-dir <dir>                  session storage (default <config-dir>/.agent-server/sessions)",
  "  --model <provider/model[effort]>      default model for new sessions",
  "  --mode <none|read|ask|full>           default mode for new sessions (default ask)",
  "  --bash-approval <gated|escalate|raw>  default bash approval (default gated)",
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
  version: { type: "boolean" },
  help: { type: "boolean" },
} as const;

function flag<K extends keyof CliFlags>(key: K, value: string | undefined): Pick<CliFlags, K> {
  return (value === undefined ? {} : { [key]: value }) as Pick<CliFlags, K>;
}

function parse(argv: readonly string[]) {
  return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
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
  const [command, ...rest] = positionals;
  if ((command !== undefined && command !== "acp") || rest.length > 0) {
    return { kind: "usage-error", message: `unknown command: ${positionals.join(" ")}` };
  }
  return {
    kind: "acp",
    flags: {
      ...flag("configDir", values["config-dir"]),
      ...flag("sessionsDir", values["sessions-dir"]),
      ...flag("model", values.model),
      ...flag("mode", values.mode),
      ...flag("bashApproval", values["bash-approval"]),
    },
  };
}
