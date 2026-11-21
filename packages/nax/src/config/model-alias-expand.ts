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
