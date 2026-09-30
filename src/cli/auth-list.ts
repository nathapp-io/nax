import chalk from "chalk";
import { ambientShadows, listStoredProviders, naxCredentialStore, type StoredEntry, servedAuth } from "@/agents/native";
import { readGlobalAuthConfig } from "@/config";

export type AuthListExecStatus =
  | { status: "served"; account?: string }
  | { status: "declined"; account?: never }
  | { status: "error"; code: string; account?: never };

export interface AuthListProvider {
  providerId: string;
  stored: { kind: "api-key" | "oauth"; expires?: string; expired: boolean } | null;
  exec?: AuthListExecStatus;
  ambient: boolean;
  available: boolean;
}

export interface AuthListReport {
  source: "file" | "exec";
  helper?: { command: string[] };
  providers: AuthListProvider[];
}

export function errorCode(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return fallback;
}

export function skipAnsiSequence(value: string, start: number): number {
  const next = value.charCodeAt(start + 1);
  let index = start + 2;
  if (next === 91) {
    while (index < value.length) {
      const code = value.charCodeAt(index);
      if (code >= 64 && code <= 126) return index;
      index++;
    }
    return value.length - 1;
  }
  if (next === 93) {
    while (index < value.length) {
      const code = value.charCodeAt(index);
      if (code === 7) return index;
      if (code === 27 && value.charCodeAt(index + 1) === 92) return index + 1;
      index++;
    }
    return value.length - 1;
  }
  return Math.min(start + 1, value.length - 1);
}

export function safeAccountLabel(account: string): string {
  let clean = "";
  for (let index = 0; index < account.length; index++) {
    const code = account.charCodeAt(index);
    if (code === 27) {
      index = skipAnsiSequence(account, index);
    } else if (code < 32 || (code >= 127 && code <= 159)) {
      if (code === 9 || code === 10 || code === 13) clean += " ";
    } else {
      clean += account[index];
    }
  }
  return clean.replace(/\s+/g, " ").trim();
}

function publicStoredEntry(entry: StoredEntry | undefined): AuthListProvider["stored"] {
  if (entry === undefined) return null;
  const stored: NonNullable<AuthListProvider["stored"]> = {
    kind: entry.kind,
    expired: entry.expires === undefined ? false : entry.expires <= Date.now(),
  };
  if (entry.expires !== undefined) {
    const expiry = new Date(entry.expires);
    if (Number.isFinite(expiry.getTime())) stored.expires = expiry.toISOString();
  }
  return stored;
}

async function readExecStatus(providerId: string): Promise<AuthListExecStatus> {
  try {
    await naxCredentialStore().read(providerId);
    const stamp = servedAuth(providerId);
    if (stamp?.source !== "exec") return { status: "declined" };
    return stamp.account === undefined
      ? { status: "served" }
      : { status: "served", account: safeAccountLabel(stamp.account) };
  } catch (error) {
    return { status: "error", code: errorCode(error, "CREDENTIAL_HELPER_FAILED") };
  }
}

function renderExecStatus(exec: AuthListExecStatus | undefined): string {
  if (exec === undefined) return "";
  if (exec.status === "served") return ` exec${exec.account === undefined ? "" : ` (${exec.account})`}`;
  if (exec.status === "declined") return " file (declined)";
  return ` error: ${exec.code}`;
}

function renderExpiry(stored: AuthListProvider["stored"]): string {
  if (stored?.expires === undefined) return "";
  return stored.expired ? chalk.red(" expired") : chalk.dim(` expires ${new Date(stored.expires).toISOString()}`);
}

function renderProviderRow(provider: AuthListProvider): string {
  const stored = provider.stored;
  const shadow = provider.ambient ? chalk.yellow(" shadows an environment variable") : "";
  return `  ${provider.providerId.padEnd(20)} ${stored?.kind ?? ""}${renderExecStatus(provider.exec)}${renderExpiry(stored)}${shadow}`;
}

export function renderAuthListText(report: AuthListReport): string[] {
  const sourceLabel = report.source === "exec" ? `exec (${report.helper?.command.join(" ") ?? ""})` : "file";
  const lines = [`Credential source: ${sourceLabel}`];
  if (report.providers.length === 0) {
    lines.push("No credentials stored. Add one with `nax auth login <provider>`.");
    return lines;
  }
  return lines.concat(report.providers.map(renderProviderRow));
}

export function renderAuthListJson(report: AuthListReport): string {
  return JSON.stringify(report, null, 2);
}

export async function collectAuthList(providerIds: readonly string[]): Promise<AuthListReport> {
  const auth = await readGlobalAuthConfig();
  const entries = await listStoredProviders();
  const entriesByProvider = new Map(entries.map((entry) => [entry.providerId, entry]));
  const requested = providerIds.map((id) => id.trim()).filter((id) => id.length > 0);
  const providers = [...new Set([...entries.map((entry) => entry.providerId), ...requested])].sort();
  const [ambientProviders, execStatuses] = await Promise.all([
    ambientShadows(providers),
    auth.source === "exec" ? Promise.all(providers.map(readExecStatus)) : Promise.resolve([]),
  ]);
  const ambientSet = new Set(ambientProviders);
  const reportProviders = providers.map((providerId, index): AuthListProvider => {
    const stored = publicStoredEntry(entriesByProvider.get(providerId));
    const ambient = ambientSet.has(providerId);
    const exec = auth.source === "exec" ? execStatuses[index] : undefined;
    const available =
      auth.source === "file"
        ? stored !== null || ambient
        : exec?.status === "served" || (exec?.status === "declined" && (stored !== null || ambient));
    return {
      providerId,
      stored,
      ...(exec !== undefined ? { exec } : {}),
      ambient,
      available,
    };
  });

  return {
    source: auth.source,
    ...(auth.source === "exec" && auth.exec !== undefined ? { helper: { command: auth.exec.command } } : {}),
    providers: reportProviders,
  };
}
