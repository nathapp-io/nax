/**
 * The secret values of a session's MCP servers (S5-5 spec §6.1): env values
 * whose names look secret (the ACP client's SECRET_KEY rule), every HTTP header
 * value plus the token after an auth scheme, and an http url's password and
 * query values. Scrubbing is value-based (min 8 chars) on top of redactSecrets.
 */
import { redactSecrets } from "@nathapp/nax-agent";
import { secretValues } from "#src/client/env";
import { scrubSecrets } from "#src/client/text";
import type { ParsedServer } from "#src/server/mcp/parse";

export type Scrub = (text: string) => string;

const AUTH_SCHEME = /^\s*[A-Za-z][A-Za-z0-9._~+/-]*\s+(\S+)\s*$/;

function headerSecrets(headers: Readonly<Record<string, string>>): string[] {
  return Object.values(headers).flatMap((value) => {
    const token = AUTH_SCHEME.exec(value)?.[1];
    return token === undefined ? [value] : [value, token];
  });
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function urlSecrets(raw: string): string[] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [];
  }
  const query = [...url.searchParams.values()];
  return url.password === "" ? query : [decoded(url.password), url.password, ...query];
}

export function mcpSecrets(servers: readonly ParsedServer[]): readonly string[] {
  const all = servers.flatMap((server) =>
    server.kind === "stdio"
      ? [...secretValues(server.env)]
      : [...headerSecrets(server.headers), ...urlSecrets(server.url)],
  );
  return [...new Set(all.filter((value) => value !== ""))];
}

export function scrubber(secrets: readonly string[]): Scrub {
  return (text) => scrubSecrets(redactSecrets(text), secrets);
}
