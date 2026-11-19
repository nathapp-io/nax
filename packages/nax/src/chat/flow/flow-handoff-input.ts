/**
 * flow-handoff-input.ts — the handoff form of `nax-flow__send`: one feature the
 * chat already ran, handed to koda to publish and finish.
 *
 * The specs of such a feature are already on the branch and its run record is
 * local, so the form carries no spec paths: just the feature name, beside the same
 * two role models and the same cap the spec form sends. The role and cost-cap
 * checks come from `flow-input.ts` rather than being restated, because koda bills
 * one cap against one pair of model strings whatever the form — a second copy would
 * drift from the first.
 *
 * Like the spec form, this collects every violation instead of stopping at the
 * first, so one round of retries fixes a request with several mistakes.
 */
import { featureIdInvalidReason } from "@/config";
import {
  type Collected,
  collectCostCap,
  collectRoles,
  FLOW_FEATURE_NAME_RE,
  type FlowSendRoles,
  isRecord,
  quoted,
  unknownKeys,
} from "./flow-input";

/**
 * The qualified tool name a chain step's argv starts with. Spelled here rather than
 * imported from `flow-provider.ts`: the provider is the caller of this fixed leaf, so
 * an import back would close a cycle.
 */
const HANDOFF_TOOL_NAME = "nax-flow__send";
/** The flag that makes a chain step the handoff form rather than a spec-form send. */
const HANDOFF_FLAG = "--handoff";
/** The three flags that carry the roles and the cap, as the step's argv spells them. */
const REVIEWER_FLAG = "--reviewer";
const SUPERVISOR_FLAG = "--supervisor";
const COST_CAP_FLAG = "--cost-cap";
/** The keys the handoff form declares at the top level: the feature, the roles, the cap. */
const HANDOFF_INPUT_KEYS = ["handoff", "roles", "costCapUsd"] as const;
/** The handoff object declares the feature and nothing else: a spec path is the other form's. */
const HANDOFF_KEYS = ["feature"] as const;

/** One feature handed to koda, with the roles and cap its flow runs under. */
export interface FlowHandoffInput {
  readonly feature: string;
  readonly roles: FlowSendRoles;
  readonly costCapUsd: number;
}

/** The parsed handoff, or every rule it broke. */
export type FlowHandoffParseResult = FlowHandoffInput | { readonly errors: string[] };

/**
 * The feature's name: the charset koda accepts, then the rules its run directory obeys.
 *
 * koda's wire charset is the wider of the two — it allows `a..b` and names longer than the
 * 64 characters a feature directory holds — so a handoff that checked only the wire rules
 * would pass approval and then fail in `featureDir`, unable to find the record it promised
 * to send. The second rule is `featureDir`'s own, reported here as a field error.
 */
function handoffFeatureErrors(value: unknown): string[] {
  const where = "handoff.feature";
  if (typeof value !== "string") return [`${where} must be a string`];
  if (!FLOW_FEATURE_NAME_RE.test(value)) {
    return [`${where} ${quoted(value)} must match ${FLOW_FEATURE_NAME_RE.source}`];
  }
  const unusable = featureIdInvalidReason(value);
  return unusable === undefined ? [] : [`${where} ${quoted(value)} is not a usable feature name: ${unusable}`];
}

/** The `handoff` object: its declared keys, then the feature name. */
function collectHandoff(value: unknown): Collected<string> {
  if (!isRecord(value)) return { value: "", errors: ["handoff must be an object"] };
  const feature = value.feature;
  const errors = [...unknownKeys(value, HANDOFF_KEYS, "handoff"), ...handoffFeatureErrors(feature)];
  return { value: typeof feature === "string" ? feature : "", errors };
}

/**
 * Check a handoff-form `nax-flow__send` request before anything is read or pushed.
 *
 * @param raw - The tool input as the model produced it; the shape is checked here
 * @returns The parsed handoff, or every error it must be retried with
 */
export function parseFlowHandoffInput(raw: Record<string, unknown>): FlowHandoffParseResult {
  const handoff = collectHandoff(raw.handoff);
  const roles = collectRoles(raw.roles);
  const costCap = collectCostCap(raw.costCapUsd);
  const errors = [
    ...unknownKeys(raw, HANDOFF_INPUT_KEYS, "the handoff input"),
    ...handoff.errors,
    ...roles.errors,
    ...costCap.errors,
  ];
  if (errors.length > 0) return { errors };
  return { feature: handoff.value, roles: roles.value, costCapUsd: costCap.value };
}

/**
 * The token list a chain step and the tool call are compared by: the handoff form's
 * input as the argv a `handoff` step declares, so admission compares one spelling.
 *
 * @param input - A parsed handoff input
 */
export function handoffStepArgv(input: FlowHandoffInput): readonly string[] {
  return [
    HANDOFF_TOOL_NAME,
    HANDOFF_FLAG,
    input.feature,
    REVIEWER_FLAG,
    input.roles.reviewer,
    SUPERVISOR_FLAG,
    input.roles.supervisor,
    COST_CAP_FLAG,
    String(input.costCapUsd),
  ];
}

/** The most decimals a whole-cent amount carries: `5`, `5.1` and `5.25` are all whole cents. */
const WHOLE_CENT_DECIMALS = 2;

/**
 * The cap as a handoff card prints it, exactly as the request authorizes it.
 *
 * `toFixed(2)` rounds, so a card for `5.004` would read `$5.00` while the request sends
 * `5.004` — the user would approve a cap they were not shown. A whole-cent amount keeps two
 * decimals (`$5.00`, `$5.10`); any other cap the parser accepts keeps every significant
 * digit (`$5.004`). Both handoff cards print the cap through here, so they cannot drift.
 *
 * @param costCapUsd - A cap `collectCostCap` accepted
 */
export function formatHandoffCostCap(costCapUsd: number): string {
  const written = String(costCapUsd);
  const decimals = written.includes(".") ? written.length - written.indexOf(".") - 1 : 0;
  return decimals <= WHOLE_CENT_DECIMALS ? costCapUsd.toFixed(WHOLE_CENT_DECIMALS) : written;
}
