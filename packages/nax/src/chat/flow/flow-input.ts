/**
 * flow-input.ts — what `nax-flow__send` accepts, checked before anything moves.
 *
 * These are the koda checks that are cheap to repeat on nax's side, so a bad
 * request fails before a branch is pushed or a flow is created. koda stays the
 * authority and re-checks every rule; a `specPath` is sent exactly as given and
 * normalised on koda's side.
 *
 * The check collects every violation rather than stopping at the first, so one
 * round of retries fixes a request with several mistakes. Errors name the field
 * (`features[1].specPath`) and quote the offending value through `quoted()`, which
 * escapes a NUL byte instead of copying a control character into a tool result.
 */
/** koda's ceiling on a flow's feature list. */
export const FLOW_MAX_FEATURES = 20;
/** A spec path is a repository-relative path to one file, not a document. */
export const FLOW_MAX_SPEC_PATH_CHARS = 300;
/** koda refuses a larger cap; a flow's billing stops somewhere. */
export const FLOW_MAX_COST_CAP_USD = 1000;
/** koda compares the cap's `String()` form, so it carries at most four decimals. */
export const FLOW_COST_CAP_DECIMALS = 4;
/** A feature name koda accepts: a letter or digit first, then letters, digits, `.`, `_` and `-`. */
export const FLOW_FEATURE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
/** A role model string (`acp:codex`) as koda's runner receives it — not a nax alias name. */
export const FLOW_ROLE_RE = /^[A-Za-z0-9._:/\[\]=,-]{1,200}$/;

const COST_CAP_RE = /^\d+(\.\d{1,4})?$/;
const SPEC_PATH_SUFFIX = ".md";
const PARENT_SEGMENT = "..";
const NUL = "\u0000";
const SEPARATOR = "/";
const TOP_LEVEL_KEYS = ["features", "roles", "costCapUsd"] as const;
const FEATURE_KEYS = ["feature", "specPath", "dependsOn"] as const;
const ROLE_KEYS = ["reviewer", "supervisor"] as const;

/** One feature of the flow, in dependency order. */
export interface FlowSendFeature {
  /** The feature's name; its specs live under `.nax/features/<feature>/`. */
  readonly feature: string;
  /** The spec file, repository-relative, sent exactly as the request wrote it. */
  readonly specPath: string;
  /** Features this one waits for — always present, `[]` when the request omitted it. */
  readonly dependsOn: readonly string[];
}

/** The two model strings koda passes to its review steps. */
export interface FlowSendRoles {
  readonly reviewer: string;
  readonly supervisor: string;
}

/** A request that passed every check. */
export interface FlowSendInput {
  readonly features: readonly FlowSendFeature[];
  readonly roles: FlowSendRoles;
  readonly costCapUsd: number;
}

/** The parsed request, or every rule it broke. */
export type FlowSendParseResult = FlowSendInput | { errors: string[] };

/** A section's best-effort value beside the rules it broke. */
interface Collected<T> {
  readonly value: T;
  readonly errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value as the request wrote it, JSON-escaped so a control byte cannot reach a tool result. */
function quoted(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/** One error per key the request carries that the schema does not declare. */
function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${where} has an unknown key ${quoted(key)}`);
}

/** The feature's name rules: the charset, and that no earlier feature already uses the name. */
function featureNameErrors(value: unknown, index: number, earlier: ReadonlySet<string>): string[] {
  const where = `features[${index}].feature`;
  if (typeof value !== "string") return [`${where} must be a string`];
  const errors = FLOW_FEATURE_NAME_RE.test(value)
    ? []
    : [`${where} ${quoted(value)} must match ${FLOW_FEATURE_NAME_RE.source}`];
  if (earlier.has(value)) errors.push(`${where} ${quoted(value)} is already used by an earlier feature`);
  return errors;
}

/** The spec path rules: a short, relative, `.md` path with no `..` segment and no NUL byte. */
function specPathErrors(value: unknown, index: number): string[] {
  const where = `features[${index}].specPath`;
  if (typeof value !== "string") return [`${where} must be a string`];
  if (value.length === 0 || value.length > FLOW_MAX_SPEC_PATH_CHARS) {
    return [`${where} must be 1 to ${FLOW_MAX_SPEC_PATH_CHARS} characters, and the request's is ${value.length}`];
  }
  const errors: string[] = [];
  if (!value.endsWith(SPEC_PATH_SUFFIX)) errors.push(`${where} ${quoted(value)} must end in ${SPEC_PATH_SUFFIX}`);
  if (value.startsWith(SEPARATOR)) errors.push(`${where} ${quoted(value)} must not start with ${SEPARATOR}`);
  if (value.includes(NUL)) errors.push(`${where} ${quoted(value)} must not contain a NUL character`);
  if (value.split(SEPARATOR).includes(PARENT_SEGMENT)) {
    errors.push(`${where} ${quoted(value)} must not have a ${quoted(PARENT_SEGMENT)} segment`);
  }
  return errors;
}

/** The `dependsOn` rules that need no other feature: a list of names, absent meaning `[]`. */
function dependsOnShape(value: unknown, index: number): Collected<readonly string[]> {
  const where = `features[${index}].dependsOn`;
  if (value === undefined) return { value: [], errors: [] };
  if (!Array.isArray(value)) return { value: [], errors: [`${where} must be an array of feature names`] };
  const names = value.filter((entry): entry is string => typeof entry === "string");
  const errors = names.length === value.length ? [] : [`${where} entries must be feature names`];
  return { value: names, errors };
}

/** Each dependency must name one earlier feature, once, and never the feature itself. */
function dependsOnOrderErrors(
  dependsOn: readonly string[],
  index: number,
  name: unknown,
  earlier: ReadonlySet<string>,
): string[] {
  const where = `features[${index}].dependsOn`;
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const dependency of dependsOn) {
    if (seen.has(dependency)) errors.push(`${where} lists ${quoted(dependency)} more than once`);
    else if (dependency === name) errors.push(`${where} ${quoted(dependency)} names the feature itself`);
    else if (!earlier.has(dependency)) errors.push(`${where} ${quoted(dependency)} is not an earlier feature`);
    seen.add(dependency);
  }
  return errors;
}

/** One feature entry: its declared keys, its name, its spec path and its dependencies. */
function featureEntry(value: unknown, index: number, earlier: ReadonlySet<string>): Collected<FlowSendFeature | null> {
  if (!isRecord(value)) return { value: null, errors: [`features[${index}] must be an object`] };
  const name = value.feature;
  const specPath = value.specPath;
  const dependsOn = dependsOnShape(value.dependsOn, index);
  const errors = [
    ...unknownKeys(value, FEATURE_KEYS, `features[${index}]`),
    ...featureNameErrors(name, index, earlier),
    ...specPathErrors(specPath, index),
    ...dependsOn.errors,
    ...dependsOnOrderErrors(dependsOn.value, index, name, earlier),
  ];
  if (typeof name !== "string" || typeof specPath !== "string") return { value: null, errors };
  return { value: { feature: name, specPath, dependsOn: dependsOn.value }, errors };
}

/** The `features` list: its size, then every entry in the order the request lists them. */
function collectFeatures(value: unknown): Collected<FlowSendFeature[]> {
  if (!Array.isArray(value)) return { value: [], errors: ["features must be an array of feature entries"] };
  if (value.length === 0) return { value: [], errors: ["features must list at least one feature"] };
  if (value.length > FLOW_MAX_FEATURES) {
    return { value: [], errors: [`features must list at most ${FLOW_MAX_FEATURES} features, not ${value.length}`] };
  }
  const features: FlowSendFeature[] = [];
  const errors: string[] = [];
  const earlier = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const collected = featureEntry(entry, index, earlier);
    if (collected.value !== null) {
      earlier.add(collected.value.feature);
      features.push(collected.value);
    }
    errors.push(...collected.errors);
  }
  return { value: features, errors };
}

/** One role's model string: required, and inside koda's charset. */
function roleModel(value: unknown, where: string): Collected<string> {
  const rule = `must be a model string matching ${FLOW_ROLE_RE.source}`;
  if (typeof value !== "string") return { value: "", errors: [`${where} ${rule}`] };
  return FLOW_ROLE_RE.test(value) ? { value, errors: [] } : { value, errors: [`${where} ${rule}`] };
}

/** The two role model strings, both required and both inside koda's charset. */
function collectRoles(value: unknown): Collected<FlowSendRoles> {
  if (!isRecord(value)) return { value: { reviewer: "", supervisor: "" }, errors: ["roles must be an object"] };
  const reviewer = roleModel(value.reviewer, "roles.reviewer");
  const supervisor = roleModel(value.supervisor, "roles.supervisor");
  const errors = [...unknownKeys(value, ROLE_KEYS, "roles"), ...reviewer.errors, ...supervisor.errors];
  return { value: { reviewer: reviewer.value, supervisor: supervisor.value }, errors };
}

/** The cap: a JSON number above 0 and at most 1000, whose `String()` form koda accepts. */
function collectCostCap(value: unknown): Collected<number> {
  if (typeof value !== "number") return { value: 0, errors: ["costCapUsd must be a number"] };
  if (!(value > 0)) return { value, errors: [`costCapUsd ${value} must be greater than 0`] };
  if (value > FLOW_MAX_COST_CAP_USD) {
    return { value, errors: [`costCapUsd ${value} must be at most ${FLOW_MAX_COST_CAP_USD}`] };
  }
  if (!COST_CAP_RE.test(String(value))) {
    return { value, errors: [`costCapUsd ${value} must have at most ${FLOW_COST_CAP_DECIMALS} decimals`] };
  }
  return { value, errors: [] };
}

/** Every section's errors and its best-effort value; the value is only used when `errors` is empty. */
function collectInput(raw: Record<string, unknown>): Collected<FlowSendInput> {
  const features = collectFeatures(raw.features);
  const roles = collectRoles(raw.roles);
  const costCap = collectCostCap(raw.costCapUsd);
  const errors = [
    ...unknownKeys(raw, TOP_LEVEL_KEYS, "the flow input"),
    ...features.errors,
    ...roles.errors,
    ...costCap.errors,
  ];
  return { value: { features: features.value, roles: roles.value, costCapUsd: costCap.value }, errors };
}

/**
 * Check a `nax-flow__send` request before the approval card is shown.
 *
 * @param raw - The tool input as the model produced it; of unknown shape on purpose
 * @returns The parsed input with every `dependsOn` defaulted to `[]`, or every error
 */
export function parseFlowSendInput(raw: unknown): FlowSendParseResult {
  if (!isRecord(raw)) return { errors: ["the flow input must be an object"] };
  const collected = collectInput(raw);
  return collected.errors.length > 0 ? { errors: collected.errors } : collected.value;
}
