/**
 * Client-supplied mcpServers (S5-5 spec §6, plan M-39..M-41). Structurally
 * invalid input fails the request (invalid_params); unsupported transports,
 * semantic problems and servers past the limit are skipped with a notice line.
 */
import { z } from "zod";
import { stripControl, stripInvisible } from "#src/client/text";
import { invalidParams } from "#src/server/errors";

export const MCP_MAX_SERVERS = 20;
/** Client-supplied lists in notices are shown at most this long, then `; and N more`. */
export const NOTICE_LIST_MAX = 10;

export type ParsedServer =
  | {
      readonly kind: "stdio";
      readonly name: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "http";
      readonly name: string;
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

export interface ParsedServers {
  readonly servers: readonly ParsedServer[];
  readonly skipped: readonly string[];
}

export const NO_SERVERS: ParsedServers = { servers: [], skipped: [] };

const NameValues = z.array(z.object({ name: z.string(), value: z.string() })).default([]);
const Base = z.object({ name: z.string(), type: z.string().optional() });
const Stdio = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: NameValues,
});
const Http = z.object({ name: z.string(), url: z.string(), headers: NameValues });

type Entry =
  | { readonly kind: "server"; readonly server: ParsedServer }
  | { readonly kind: "skip"; readonly line: string };

export function displayName(name: string): string {
  return stripInvisible(stripControl(name)).replace(/\s+/g, " ").trim();
}

/** At most NOTICE_LIST_MAX items; when longer, the last item carries `; and N more`. */
export function cappedItems(items: readonly string[]): string[] {
  if (items.length <= NOTICE_LIST_MAX) return [...items];
  const kept = items.slice(0, NOTICE_LIST_MAX);
  const last = kept.length - 1;
  return [...kept.slice(0, last), `${kept[last]}; and ${items.length - NOTICE_LIST_MAX} more`];
}

const record = (items: readonly { name: string; value: string }[]): Record<string, string> =>
  Object.fromEntries(items.map((item) => [item.name, item.value]));

function structural<T>(schema: z.ZodType<T>, value: unknown, index: number): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = [`mcpServers[${index}]`, ...(issue?.path ?? []).map(String)].join(".");
  throw invalidParams(`${path}: ${issue?.message ?? "invalid"}`);
}

function httpEntry(name: string, value: unknown, index: number): Entry {
  const http = structural(Http, value, index);
  let url: URL;
  try {
    url = new URL(http.url);
  } catch {
    return { kind: "skip", line: `\`${displayName(name)}\`: url is not valid` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { kind: "skip", line: `\`${displayName(name)}\`: url must be http or https` };
  return { kind: "server", server: { kind: "http", name, url: http.url, headers: record(http.headers) } };
}

function stdioEntry(name: string, value: unknown, index: number): Entry {
  const stdio = structural(Stdio, value, index);
  if (stdio.command.trim() === "") return { kind: "skip", line: `\`${displayName(name)}\`: empty command` };
  return {
    kind: "server",
    server: { kind: "stdio", name, command: stdio.command, args: stdio.args, env: record(stdio.env) },
  };
}

function entryOf(value: unknown, index: number): Entry {
  const base = structural(Base, value, index);
  const name = displayName(base.name);
  if (name === "") return { kind: "skip", line: "a server with an empty name was skipped" };
  switch (base.type) {
    case undefined:
    case "stdio":
      return stdioEntry(base.name, value, index);
    case "http":
      return httpEntry(base.name, value, index);
    case "sse":
      return { kind: "skip", line: `\`${name}\`: SSE transport is not supported` };
    case "acp":
      return { kind: "skip", line: `\`${name}\`: ACP-tunnelled MCP is not supported` };
    default:
      return { kind: "skip", line: `\`${name}\`: unsupported transport type ${JSON.stringify(base.type)}` };
  }
}

export function parseMcpServers(raw: readonly unknown[]): ParsedServers {
  const entries = raw.map(entryOf); // every structural check runs before anything is kept
  const servers: ParsedServer[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const overLimit: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "skip") {
      skipped.push(entry.line);
    } else if (seen.has(entry.server.name)) {
      skipped.push(`\`${displayName(entry.server.name)}\`: duplicate server name (the first one is used)`);
    } else if (servers.length >= MCP_MAX_SERVERS) {
      overLimit.push(`\`${displayName(entry.server.name)}\``);
    } else {
      seen.add(entry.server.name);
      servers.push(entry.server);
    }
  }
  if (overLimit.length > 0)
    skipped.push(`MCP server limit (${MCP_MAX_SERVERS}) reached; not started: ${cappedItems(overLimit).join(", ")}`);
  return { servers, skipped };
}
