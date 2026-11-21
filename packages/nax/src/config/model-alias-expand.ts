/**
 * Model alias references: `@name` / `@name[effort]` -> the literal
 * `provider/model[effort]` id an `agent.modelAliases` entry stands for.
 * One level only: alias values must be literal ids, never references.
 */

import { parseModelSpec } from "@nathapp/nax-agent";
import { NaxError } from "../errors";

export const MODEL_ALIAS_PREFIX = "@";

const MODEL_ALIAS_INVALID = "MODEL_ALIAS_INVALID";
const ACP_PREFIX = "acp:";

/** `@<name>` with an optional single trailing `[<effort>]`, whole-string. */
const REFERENCE = /^@([^\s[\]]+)(?:\[([^\s[\]]+)\])?$/;
/** `@[<effort>]` — a reference with no name. */
const NAMELESS_REFERENCE = /^@\[[^\s[\]]+\]$/;
/** Mirrors the provider/model shape `ModelAliasesSchema` accepts. */
const LITERAL_MODEL_ID = /^[^\s/[\]]+\/[^\s[\]]+(\[[^\s[\]]+\])?$/;

function fail(path: string, message: string, alias?: string): never {
  throw new NaxError(`${path}: ${message}`, MODEL_ALIAS_INVALID, { stage: "config", path, alias });
}

/** Own-property lookup, matching keys as trimmed (as `ModelAliasesSchema` does). */
function lookupAlias(aliases: Readonly<Record<string, string>>, name: string): unknown {
  for (const key of Object.keys(aliases)) {
    if (key.trim() === name) return aliases[key];
  }
  return undefined;
}

function checkLiteralValue(value: unknown, name: string, path: string): string {
  if (typeof value === "string") {
    if (value.startsWith(MODEL_ALIAS_PREFIX)) {
      fail(path, `model alias "${name}" must be a literal model id, not another alias`, name);
    }
    if (value.startsWith(ACP_PREFIX)) {
      fail(path, `model alias "${name}" is an acp: target, usable only from agent files`, name);
    }
    if (LITERAL_MODEL_ID.test(value)) return value;
  }
  return fail(path, `model alias "${name}" is not a provider/model id`, name);
}

/** One `@name[effort]` reference -> the literal id it stands for. Throws MODEL_ALIAS_INVALID. */
export function expandModelAliasRef(
  ref: string,
  aliases: Readonly<Record<string, string>>,
  path: string, // config path or "--model", named in the error
): string {
  if (ref === MODEL_ALIAS_PREFIX || NAMELESS_REFERENCE.test(ref)) fail(path, "empty model alias reference");
  const match = REFERENCE.exec(ref);
  if (!match) return fail(path, `malformed model alias reference "${ref}"`);
  const name = match[1] as string;
  const effort = match[2];
  const map = aliases !== null && typeof aliases === "object" ? aliases : {};
  const raw = lookupAlias(map, name);
  if (raw === undefined) fail(path, `unknown model alias "${name}"`, name);
  const value = checkLiteralValue(raw, name, path);
  return effort === undefined ? value : `${parseModelSpec(value).model}[${effort}]`;
}

type Json = Record<string, unknown>;

/** Full config-root paths the object-selector rule never walks. */
const EXCLUDED_PATHS: ReadonlySet<string> = new Set(["models", "agent.modelAliases", "routing.agents", "chat"]);

function isPlainObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReference(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(MODEL_ALIAS_PREFIX);
}

interface WalkState {
  aliases: Readonly<Record<string, string>>;
  errors: NaxError[];
}

function expandRef(ref: string, path: string, state: WalkState): string {
  try {
    return expandModelAliasRef(ref, state.aliases, path);
  } catch (err) {
    if (!(err instanceof NaxError)) throw err;
    state.errors.push(err);
    return ref;
  }
}

/** `{ model: "@x" }`-bearing object: expand its `model` field, copy the rest. */
function expandModelField(obj: Json, path: string, state: WalkState): Json {
  if (!isReference(obj.model)) return obj;
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) setOwn(out, k, v);
  setOwn(out, "model", expandRef(obj.model, `${path}.model`, state));
  return out;
}

/** Legacy flat `models.<tier>` is a ModelDef: string `provider` and string `model`. */
function isLegacyModelDef(value: Json): boolean {
  return typeof value.model === "string" && typeof value.provider === "string";
}

/** Own data property, so a `__proto__` key survives instead of setting the prototype. */
function setOwn(target: Json, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function expandModels(models: unknown, state: WalkState): unknown {
  if (!isPlainObject(models)) return models;
  const out: Json = {};
  for (const [agent, tiers] of Object.entries(models)) {
    // Legacy flat shape (models.<tier> = ModelDef) is left alone.
    if (!isPlainObject(tiers) || isLegacyModelDef(tiers)) {
      setOwn(out, agent, tiers);
      continue;
    }
    const mapped: Json = {};
    for (const [tier, entry] of Object.entries(tiers)) {
      const path = `models.${agent}.${tier}`;
      if (isReference(entry)) setOwn(mapped, tier, expandRef(entry, path, state));
      else setOwn(mapped, tier, isPlainObject(entry) ? expandModelField(entry, path, state) : entry);
    }
    setOwn(out, agent, mapped);
  }
  return out;
}

function walk(value: unknown, path: string, state: WalkState): unknown {
  if (Array.isArray(value)) return value.map((item, i) => walk(item, `${path}[${i}]`, state));
  if (!isPlainObject(value)) return value;
  const selector = typeof value.agent === "string" && typeof value.model === "string";
  const base = selector ? expandModelField(value, path, state) : value;
  const out: Json = {};
  for (const [key, child] of Object.entries(base)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    setOwn(out, key, EXCLUDED_PATHS.has(childPath) ? child : walk(child, childPath, state));
  }
  return out;
}

/** The raw merged config with every model-position reference expanded. Never mutates `raw`. */
export function expandConfigModelAliases(raw: Record<string, unknown>): Record<string, unknown> {
  const agent = raw.agent;
  const declared = isPlainObject(agent) ? agent.modelAliases : undefined;
  const aliases = (isPlainObject(declared) ? declared : {}) as Record<string, string>;
  const state: WalkState = { aliases, errors: [] };
  const walked = walk(raw, "", state) as Json;
  const result = "models" in raw ? { ...walked, models: expandModels(raw.models, state) } : walked;
  if (state.errors.length > 0) {
    const paths = state.errors.map((e) => e.context?.path as string);
    throw new NaxError(state.errors.map((e) => e.message).join("\n"), MODEL_ALIAS_INVALID, { stage: "config", paths });
  }
  return result;
}
