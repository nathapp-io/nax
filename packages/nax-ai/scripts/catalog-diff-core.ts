// scripts/catalog-diff-core.ts
/**
 * Diffs two snapshots of pi-ai's bundled provider catalog.
 *
 * This is the bump-review tool. pi-ai ships no CHANGELOG and releases roughly
 * ten times a month, so reviewing a bump by reading release notes does not
 * scale; reviewing it by diffing the data that actually reaches this package
 * does.
 *
 * Deliberately pure and pi-ai-free: it reads the shipped JSON as data, so it
 * can compare two versions without either being installed. The IO half lives
 * in catalog-diff.ts.
 *
 * Scope: the catalog only. It says nothing about wire behaviour — a provider
 * that changes its SSE framing without touching its catalog entry is invisible
 * here, and no offline check can see it.
 */

/** One model entry, as pi-ai ships it. Read as data; no shape is assumed beyond the watched fields. */
export type ModelEntry = Readonly<Record<string, unknown>>;

/** `api` -> model id -> entry, as one provider's JSON file is laid out. */
export type ProviderData = Readonly<Record<string, Readonly<Record<string, ModelEntry>>>>;

/** provider id -> its file's contents. */
export type Catalog = Readonly<Record<string, ProviderData>>;

export interface ModelRef {
  readonly provider: string;
  readonly api: string;
  readonly id: string;
}

export interface FieldChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface ModelChange {
  readonly provider: string;
  readonly id: string;
  readonly changes: readonly FieldChange[];
}

/** One model id served under more than one wire format by the same provider — see `byModelId`. */
export interface ModelCollision {
  readonly provider: string;
  readonly id: string;
  readonly apis: readonly string[];
}

export interface CatalogDiff {
  readonly providersAdded: readonly string[];
  readonly providersRemoved: readonly string[];
  readonly modelsAdded: readonly ModelRef[];
  readonly modelsRemoved: readonly ModelRef[];
  readonly modelsChanged: readonly ModelChange[];
  readonly collisions: readonly ModelCollision[];
}

/**
 * Fields whose change can alter a request, a route, or a bill.
 *
 * `name` is deliberately absent: a display string cannot affect a request, and
 * including it would bury the fields that can under routine churn.
 *
 * Order here is the order the report prints, so the fields that reroute
 * traffic come before the ones that only reprice it.
 */
const SCALAR_FIELDS = ["api", "baseUrl", "contextWindow", "maxTokens", "reasoning"] as const;

/** Compared per component: a cacheRead change must not be hidden by an unchanged input rate. */
const COST_COMPONENTS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/**
 * `cost.tiers` is compared whole rather than per component.
 *
 * It is an array of threshold/rate objects, and per-index flattening would
 * misreport an inserted tier as a change to every tier after it. 24 models
 * carry it and `providers/pi-catalog.ts` maps it into `pricing.tiers`, so a
 * rewrite here reprices real requests above a threshold while every flat rate
 * stays put.
 */
const COST_OBJECT_FIELD = "tiers";

/**
 * Compared whole, because their shape is the signal.
 *
 * `thinkingLevelMap` in particular is three-state per key — absent, `null`, and
 * a value each mean something different — so it is reported as a whole object
 * rather than flattened into per-key scalars that would lose the distinction.
 *
 * `headers` is here because `providers/pi-catalog.ts` lifts it onto the
 * resolved provider, where it is sent on every request: github-copilot gates
 * access on `Editor-Version` and `Copilot-Integration-Id`, so a bump that revs
 * them changes what reaches the wire without touching any other field.
 */
const OBJECT_FIELDS = ["thinkingLevelMap", "compat", "input", "headers"] as const;

/** Strict structural equality. `undefined` (absent) and `null` are NOT equal — that distinction is load-bearing. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  // Key sets are compared before values so a key that vanished is caught even
  // when every surviving key still matches. Order is not compared.
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

interface Located {
  readonly api: string;
  readonly entry: ModelEntry;
}

/**
 * Flattens one provider to model id -> { api, entry }, plus any id that was
 * served under more than one wire format.
 *
 * Keying by id alone rather than by (api, id) is what lets a wire-format change
 * surface as a reroute instead of a removal plus an addition. It holds because
 * no provider in the bundled catalog serves one id under two apis — 1,393
 * entries, zero collisions.
 *
 * That assumption is self-policing rather than a comment that can rot: a
 * collision is collected and reported, never swallowed. The winner is the
 * alphabetically first api rather than whichever the file listed first,
 * because `Object.entries` follows insertion order — so a generator that
 * merely reordered its keys would otherwise fabricate a reroute, which in a
 * review tool is worse than missing one.
 */
function byModelId(data: ProviderData): { models: Map<string, Located>; collisions: Map<string, string[]> } {
  const models = new Map<string, Located>();
  const collisions = new Map<string, string[]>();

  for (const api of Object.keys(data).sort()) {
    const entries = data[api];
    if (entries === null || typeof entries !== "object") continue;
    for (const [id, entry] of Object.entries(entries)) {
      const existing = models.get(id);
      if (existing === undefined) {
        models.set(id, { api, entry });
        continue;
      }
      collisions.set(id, [...(collisions.get(id) ?? [existing.api]), api]);
    }
  }

  return { models, collisions };
}

function changedFields(before: ModelEntry, after: ModelEntry): FieldChange[] {
  const changes: FieldChange[] = [];

  for (const field of SCALAR_FIELDS) {
    if (!deepEqual(before[field], after[field])) {
      changes.push({ field, before: before[field], after: after[field] });
    }
  }

  const beforeCost = (before.cost ?? {}) as Record<string, unknown>;
  const afterCost = (after.cost ?? {}) as Record<string, unknown>;
  for (const component of COST_COMPONENTS) {
    if (!deepEqual(beforeCost[component], afterCost[component])) {
      changes.push({ field: `cost.${component}`, before: beforeCost[component], after: afterCost[component] });
    }
  }
  if (!deepEqual(beforeCost[COST_OBJECT_FIELD], afterCost[COST_OBJECT_FIELD])) {
    changes.push({
      field: `cost.${COST_OBJECT_FIELD}`,
      before: beforeCost[COST_OBJECT_FIELD],
      after: afterCost[COST_OBJECT_FIELD],
    });
  }

  for (const field of OBJECT_FIELDS) {
    if (!deepEqual(before[field], after[field])) {
      changes.push({ field, before: before[field], after: after[field] });
    }
  }

  return changes;
}

export function diffCatalogs(before: Catalog, after: Catalog): CatalogDiff {
  const beforeProviders = Object.keys(before);
  const afterProviders = Object.keys(after);

  const providersAdded = afterProviders.filter((id) => !Object.hasOwn(before, id)).sort();
  const providersRemoved = beforeProviders.filter((id) => !Object.hasOwn(after, id)).sort();

  const modelsAdded: ModelRef[] = [];
  const modelsRemoved: ModelRef[] = [];
  const modelsChanged: ModelChange[] = [];
  // Keyed so the same collision seen on both sides is reported once.
  const collisions = new Map<string, ModelCollision>();

  // Only providers present on both sides are walked. A whole provider arriving
  // or leaving is already reported above, and listing its several hundred
  // models again would bury every other line in the report.
  for (const provider of beforeProviders.filter((id) => Object.hasOwn(after, id)).sort()) {
    const beforeSide = byModelId(before[provider] as ProviderData);
    const afterSide = byModelId(after[provider] as ProviderData);
    const beforeModels = beforeSide.models;
    const afterModels = afterSide.models;

    for (const side of [beforeSide, afterSide]) {
      for (const [id, apis] of side.collisions) {
        collisions.set(`${provider}\u0000${id}`, { provider, id, apis: [...apis].sort() });
      }
    }

    for (const [id, located] of beforeModels) {
      if (!afterModels.has(id)) modelsRemoved.push({ provider, api: located.api, id });
    }
    for (const [id, located] of afterModels) {
      if (!beforeModels.has(id)) modelsAdded.push({ provider, api: located.api, id });
    }
    for (const [id, beforeLocated] of beforeModels) {
      const afterLocated = afterModels.get(id);
      if (afterLocated === undefined) continue;
      const changes = changedFields(beforeLocated.entry, afterLocated.entry);
      if (changes.length > 0) modelsChanged.push({ provider, id, changes });
    }
  }

  return {
    providersAdded,
    providersRemoved,
    modelsAdded,
    modelsRemoved,
    modelsChanged,
    collisions: [...collisions.values()],
  };
}

/**
 * Narrows a catalog to the named providers.
 *
 * A full-catalog diff of one pi-ai bump runs to thousands of lines, which is
 * not a review — it is the same unread wall of text the release notes were.
 * Naming the providers a consumer actually routes to is what turns it back
 * into a glance.
 *
 * The cost of using it: a change at an unnamed provider is not merely
 * unreported, it is invisible. That is the right trade for a routine bump and
 * the wrong one before adding a provider, so it is opt-in rather than default.
 */
export function filterCatalog(catalog: Catalog, providers: readonly string[]): Catalog {
  if (providers.length === 0) return catalog;
  const wanted = new Set(providers);
  return Object.fromEntries(Object.entries(catalog).filter(([id]) => wanted.has(id)));
}

export function hasChanges(diff: CatalogDiff): boolean {
  return (
    diff.providersAdded.length > 0 ||
    diff.providersRemoved.length > 0 ||
    diff.modelsAdded.length > 0 ||
    diff.modelsRemoved.length > 0 ||
    diff.modelsChanged.length > 0 ||
    diff.collisions.length > 0
  );
}

function render(value: unknown): string {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}

export function formatDiff(diff: CatalogDiff): string {
  if (!hasChanges(diff)) return "No catalog changes.";

  const lines: string[] = [];
  const section = (title: string, body: readonly string[]): void => {
    if (body.length === 0) return;
    lines.push(`## ${title}`, ...body, "");
  };

  // First, because it invalidates the rest: while an id is served under two
  // apis, one of its entries is not being compared at all.
  section(
    "Model id collisions — THIS DIFF IS INCOMPLETE for these",
    diff.collisions.map((c) => `  ! ${c.provider}/${c.id} served under: ${c.apis.join(", ")}`),
  );

  section(
    "Providers added",
    diff.providersAdded.map((id) => `  + ${id}`),
  );
  section(
    "Providers removed",
    diff.providersRemoved.map((id) => `  - ${id}`),
  );

  // Reroutes are lifted out of the general field-change list: a model whose
  // wire format moved is a different class of event from one that was
  // repriced, and reading it as a pricing line would miss that every request
  // for it now takes another code path.
  const reroutes = diff.modelsChanged.flatMap((change) =>
    change.changes
      .filter((field) => field.field === "api")
      .map((field) => `  ~ ${change.provider}/${change.id}: ${render(field.before)} -> ${render(field.after)}`),
  );
  section("Wire-format reroutes", reroutes);

  section(
    "Models added",
    diff.modelsAdded.map((ref) => `  + ${ref.provider}/${ref.id} (${ref.api})`),
  );
  section(
    "Models removed",
    diff.modelsRemoved.map((ref) => `  - ${ref.provider}/${ref.id} (${ref.api})`),
  );

  const fieldLines = diff.modelsChanged.flatMap((change) => {
    const rest = change.changes.filter((field) => field.field !== "api");
    if (rest.length === 0) return [];
    return [
      `  ${change.provider}/${change.id}`,
      ...rest.map((field) => `      ${field.field}: ${render(field.before)} -> ${render(field.after)}`),
    ];
  });
  section("Field changes", fieldLines);

  return lines.join("\n").trimEnd();
}
