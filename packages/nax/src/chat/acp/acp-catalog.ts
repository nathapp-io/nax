/**
 * The ACP agents a chat can pick, as the picker sees them.
 *
 * Persisted offers seed the catalog; each agent's offered models and effort
 * levels are learned from a successful open, an open that fails on login or
 * launch is remembered until the agent next opens, and whether the agent's
 * binary resolves on this machine is probed once.
 */
import { launchCandidateKind } from "@nathapp/nax-agent-acp/client";
import { NaxError } from "@/errors";
import type { Logger } from "@/logger";
import type { EffortLevel } from "../chat-effort";
import {
  ACP_CHAT_AGENTS,
  type AcpChatAgent,
  acpEffortLevels,
  acpModelRows,
  type ChatAcpModel,
  parseChatAcpModel,
} from "./acp-model";
import { type AcpOffer, acpOffersPath, createAcpOfferStore } from "./acp-offer-store";

/** Seam for tests: the binary probe. */
export const _acpCatalogDeps = { launchCandidateKind, createAcpOfferStore };

export interface AcpCatalog {
  /** Seed offers without replacing anything learned in this process. */
  load(): Promise<void>;
  /** `acp:<agent>` then that agent's learned `acp:<agent>/<model>` rows, per agent in picker order. */
  rows(): readonly string[];
  /** The levels the model's agent offers; `["default"]` until it reports some or for a non-ACP model. */
  effortLevels(model: string): readonly EffortLevel[];
  /** False only for an ACP model whose agent binary does not resolve; true for any other model. */
  installed(model: string): boolean;
  /** Why the model's ACP agent cannot be used right now, if it cannot. */
  unavailable(model: string): string | undefined;
  /** Learn from an ACP open that succeeded. */
  opened(model: string, capabilities: Readonly<Record<string, unknown>>): void;
  /** Remember an ACP open failure that means the agent is unusable. */
  failed(model: string, error: unknown): void;
}

const AUTH_REQUIRED = "AGENT_SESSION_AUTH_REQUIRED";
const BACKEND_UNAVAILABLE = "AGENT_SESSION_BACKEND_UNAVAILABLE";
const NOT_LOGGED_IN = "not logged in";
const NOT_INSTALLED = "not installed";
const UNAVAILABLE_FALLBACK = "backend unavailable";
const REASON_MAX_CHARS = 120;
const LINE_BREAK = /\r\n|\r|\n/;

/** The ACP target of a model string; `undefined` for a native or malformed string. */
function acpTarget(model: string): ChatAcpModel | undefined {
  try {
    return parseChatAcpModel(model);
  } catch {
    return undefined;
  }
}

/** The string elements of a reported list, only when it is an array holding at least one. */
function reportedStrings(report: unknown): readonly string[] | undefined {
  if (!Array.isArray(report)) return undefined;
  const strings = report.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

function backendReason(error: NaxError): string {
  const firstLine = error.message.split(LINE_BREAK)[0] ?? "";
  return firstLine.slice(0, REASON_MAX_CHARS) || UNAVAILABLE_FALLBACK;
}

/** The reason an open failure leaves an agent unavailable; `undefined` when it records nothing. */
function failureReason(error: unknown): string | undefined {
  if (!(error instanceof NaxError)) return undefined;
  if (error.code === AUTH_REQUIRED) return NOT_LOGGED_IN;
  if (error.code === BACKEND_UNAVAILABLE) return backendReason(error);
  return undefined;
}

export function createAcpCatalog(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sessionsDir?: string;
  readonly logger?: Pick<Logger, "warn" | "debug">;
}): AcpCatalog {
  const models = new Map<AcpChatAgent, readonly string[]>();
  const efforts = new Map<AcpChatAgent, readonly string[]>();
  const failures = new Map<AcpChatAgent, string>();
  let probed: ReadonlyMap<AcpChatAgent, boolean> | undefined;
  const learned = new Set<AcpChatAgent>();
  const store =
    input.sessionsDir === undefined
      ? undefined
      : _acpCatalogDeps.createAcpOfferStore({
          path: acpOffersPath(input.sessionsDir),
          logger: input.logger,
        });
  let saving = Promise.resolve();

  function saveOffers(): void {
    if (!store) return;
    const snapshot = new Map<AcpChatAgent, AcpOffer>();
    for (const agent of ACP_CHAT_AGENTS) {
      const offered = models.get(agent);
      if (offered?.length) snapshot.set(agent, { models: [...offered], efforts: [...(efforts.get(agent) ?? [])] });
    }
    saving = saving
      .then(() => store.save(snapshot))
      .catch((error) => {
        input.logger?.warn("chat", "Failed to save ACP offers", { error });
      });
  }

  function installedAgents(): ReadonlyMap<AcpChatAgent, boolean> {
    probed ??= new Map(
      ACP_CHAT_AGENTS.map((agent) => [agent, _acpCatalogDeps.launchCandidateKind(agent, input.env) !== undefined]),
    );
    return probed;
  }

  return {
    async load() {
      if (!store) return;
      try {
        for (const [agent, offer] of await store.load()) {
          if (learned.has(agent)) continue;
          models.set(agent, offer.models);
          efforts.set(agent, offer.efforts);
        }
      } catch (error) {
        input.logger?.warn("chat", "Failed to load ACP offers", { error });
      }
    },
    rows() {
      installedAgents();
      return ACP_CHAT_AGENTS.flatMap((agent) => [`acp:${agent}`, ...acpModelRows(agent, models.get(agent) ?? [])]);
    },
    effortLevels(model) {
      const target = acpTarget(model);
      return acpEffortLevels(target ? (efforts.get(target.agent) ?? []) : []);
    },
    installed(model) {
      const target = acpTarget(model);
      return target ? (installedAgents().get(target.agent) ?? false) : true;
    },
    unavailable(model) {
      const target = acpTarget(model);
      if (!target) return undefined;
      if (installedAgents().get(target.agent) === false) return NOT_INSTALLED;
      return failures.get(target.agent);
    },
    opened(model, capabilities) {
      const target = acpTarget(model);
      if (!target) return;
      const offeredModels = reportedStrings(capabilities.offeredModels);
      if (offeredModels) models.set(target.agent, offeredModels);
      const offeredEfforts = reportedStrings(capabilities.offeredEfforts);
      if (offeredEfforts) efforts.set(target.agent, offeredEfforts);
      if (offeredModels || offeredEfforts) learned.add(target.agent);
      failures.delete(target.agent);
      if (Array.isArray(capabilities.offeredModels) || Array.isArray(capabilities.offeredEfforts)) saveOffers();
    },
    failed(model, error) {
      const target = acpTarget(model);
      const reason = failureReason(error);
      if (target && reason !== undefined) failures.set(target.agent, reason);
    },
  };
}
