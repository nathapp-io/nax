import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { NaxError } from "@/errors";
import type { Logger } from "@/logger";
import { ACP_CHAT_AGENTS, type AcpChatAgent } from "./acp-model";

export interface AcpOffer {
  readonly models: readonly string[];
  readonly efforts: readonly string[];
}
export interface AcpOfferStore {
  load(): Promise<ReadonlyMap<AcpChatAgent, AcpOffer>>;
  save(offers: ReadonlyMap<AcpChatAgent, AcpOffer>): Promise<void>;
}
export const ACP_OFFERS_FILE = "acp-offers.json";
const OFFER_VERSION = 1;
export const _acpOfferStoreDeps = {
  read: (path: string): Promise<unknown> => Bun.file(path).json(),
  write: (path: string, content: string): Promise<number> => Bun.write(path, content),
  rename: renameSync,
  mkdir: mkdirSync,
  unlink: unlinkSync,
  randomUUID: (): string => crypto.randomUUID(),
};

export function acpOffersPath(sessionsDir: string): string {
  return join(sessionsDir, ACP_OFFERS_FILE);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
function decode(value: unknown): ReadonlyMap<AcpChatAgent, AcpOffer> {
  if (!record(value) || value.version !== OFFER_VERSION) {
    throw new NaxError("[chat] Unsupported ACP offers version", "ACP_OFFERS_INVALID", { stage: "chat" });
  }
  const offers = new Map<AcpChatAgent, AcpOffer>();
  if (!record(value.agents)) return offers;
  for (const agent of ACP_CHAT_AGENTS) {
    const offer = value.agents[agent];
    if (record(offer) && Array.isArray(offer.models)) {
      offers.set(agent, { models: strings(offer.models), efforts: strings(offer.efforts) });
    }
  }
  return offers;
}

export function createAcpOfferStore(input: {
  readonly path: string;
  readonly logger?: Pick<Logger, "warn">;
}): AcpOfferStore {
  return {
    async load() {
      try {
        return decode(await _acpOfferStoreDeps.read(input.path));
      } catch (error) {
        if (!(record(error) && error.code === "ENOENT")) {
          input.logger?.warn("chat", `Failed to load ACP offers from ${input.path}`, { error });
        }
        return new Map();
      }
    },
    async save(offers) {
      const temp = `${input.path}.${_acpOfferStoreDeps.randomUUID()}.tmp`;
      try {
        _acpOfferStoreDeps.mkdir(dirname(input.path), { recursive: true });
        const agents = Object.fromEntries([...offers].filter(([, offer]) => offer.models.length > 0));
        await _acpOfferStoreDeps.write(temp, JSON.stringify({ version: OFFER_VERSION, agents }, null, 2));
        _acpOfferStoreDeps.rename(temp, input.path);
      } catch (error) {
        try {
          _acpOfferStoreDeps.unlink(temp);
        } catch {
          // Cleanup is best-effort: preserve the original write/rename error for the catalog.
        }
        throw error;
      }
    },
  };
}
