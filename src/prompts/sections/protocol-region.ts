/**
 * Single prompt-affordance registry, nonce-protected marker grammar, and
 * ACP-safe rendering APIs.
 *
 * Why a delimited region rather than a placeholder token: the body between
 * the markers IS the ACP text, so if substitution never runs the prompt
 * degrades to the pre-change text plus two visible HTML-comment markers. A
 * placeholder would degrade to a prompt with no instructions at all, which
 * is the worse failure and the harder one to notice.
 *
 * Why the marker carries a per-process nonce: a prompt is not all trusted
 * text. `buildPriorIterationsBlock` splices LLM-authored findings from earlier
 * iterations into the same string, ahead of the region, and an embedded diff
 * can carry the contents of any file in the repository. Without a nonce, one
 * forged opener in that content captures everything up to the genuine close
 * — deleting the genuine region's body and substituting an attacker-chosen
 * spec. Content cannot forge a marker it cannot predict.
 *
 * Why one marker grammar for every kind, with `kind` inside the marker: a
 * placeholder would have to be aware of every affordance's syntax, and the
 * dispatch site has only the protocol to act on. The grammar below covers
 * every registered kind uniformly, and `PROTOCOL_REGION_MARKER_PREFIX`
 * makes "no marker survives dispatch" checkable in one place.
 */

import { NONCE as DIFF_NONCE, type DiffAccessSpec, renderNative } from "./diff-access";

/** Per-process nonce. Re-exported here so `wrapAffordance` and
 *  `applyProtocolRegions` produce markers with the same nonce as
 *  `wrapDiffAccess`. Both entry points can then substitute each other's
 *  regions in the same process. */
export const NONCE = DIFF_NONCE;

/** Every registered kind's opener begins with this prefix — the single
 *  check for "no marker survived dispatch". */
export const PROTOCOL_REGION_MARKER_PREFIX = "<!--nax:";

/** What the native side renders when every required tool is present. */
export interface AffordanceNativeRenderer {
  /** Tools whose advertisedTools must include them for native rendering to apply. */
  readonly requires: readonly string[];
  /** Build the native rendering text from the parsed spec. */
  readonly render: (spec: unknown) => string;
}

/** Type the tests use to construct an entry. */
export type ApplyProtocolRegionsOpts = {
  readonly protocol: "native" | "acp";
  readonly advertisedTools?: ReadonlySet<string>;
};

/**
 * The body may not span another opener. Belt and braces beside the nonce: the
 * negative lookahead excludes any opener of any kind and any nonce, so a
 * forged opener with the correct kind but a guessed nonce still cannot
 * bracket across the genuine close. The kind in the close is back-referenced
 * to the opener's kind, so a forged opener cannot be closed by another
 * kind's terminator.
 */
const REGION = new RegExp(
  `<!--nax:([a-z][a-z-]*):([a-f0-9]+) (\\{.*?\\})-->\\n` +
    `((?:(?!<!--nax:[a-z][a-z-]*:[a-f0-9]+ )[\\s\\S])*?)` +
    `<!--\\/nax:\\1-->\\n?`,
  "g",
);

/**
 * The registry. Today: `diff-access` only — US-002 will add the next kind,
 * US-003 / US-004 will register their producers, and US-005 will persist.
 *
 * The `requires` list is consulted when `advertisedTools` is supplied. When
 * `advertisedTools` is `undefined`, gating is skipped (a caller that does
 * not know which tools the agent advertises must still get the native
 * rendering).
 */
const REGISTRY: Record<string, AffordanceNativeRenderer> = {
  "diff-access": {
    requires: ["Git", "Read"],
    render: (spec) => renderNative(spec as DiffAccessSpec),
  },
};

/** Wrap ACP text behind opening/closing markers carrying the spec and kind.
 *
 *  The spec is JSON-encoded into the opening marker. A spec containing the
 *  literal "-->" would break the region; none of the registered specs can
 *  produce one (specs are built from configured test globs and the fixed
 *  nax metadata paths, never from model input). */
export function wrapAffordance(kind: string, spec: unknown, acpBody: string): string {
  return `<!--nax:${kind}:${NONCE} ${JSON.stringify(spec)}-->\n${acpBody}<!--/nax:${kind}-->\n`;
}

/** Substitute every matching region for the protocol being dispatched.
 *
 *  Failure paths (unknown kind, unparseable spec, foreign nonce, missing
 *  tool, unterminated region) keep the ACP body — a damaged marker must
 *  cost the native rendering, never the instructions. */
export function applyProtocolRegions(prompt: string, opts: ApplyProtocolRegionsOpts): string {
  if (!prompt.includes(PROTOCOL_REGION_MARKER_PREFIX)) return prompt;

  return prompt.replace(REGION, (whole, kind: string, nonce: string, json: string, body: string) => {
    // Foreign nonce — leave byte-for-byte untouched.
    if (nonce !== NONCE) return whole;

    // ACP: strip markers, return the body.
    if (opts.protocol === "acp") return body;

    // Native: look up the kind.
    const renderer = REGISTRY[kind];
    if (!renderer) return body;

    // Tool gating — only enforced when the caller supplied a tool set.
    if (opts.advertisedTools !== undefined) {
      for (const tool of renderer.requires) {
        if (!opts.advertisedTools.has(tool)) return body;
      }
    }

    // Parse the spec; a damaged marker keeps the body, never silently drops it.
    let spec: unknown;
    try {
      spec = JSON.parse(json);
    } catch {
      return body;
    }

    return renderer.render(spec);
  });
}

/** Extract each ACP body from a prompt that may carry regions.
 *
 *  Returns the bodies in source order. Foreign-nonce regions are skipped —
 *  they are not "our" regions and any text they contain was authored by
 *  someone else (a prior iteration's finding, an embedded diff, etc.). */
export function unwrapProtocolRegions(text: string): readonly string[] {
  if (!text.includes(PROTOCOL_REGION_MARKER_PREFIX)) return [];

  const bodies: string[] = [];
  for (const match of text.matchAll(REGION)) {
    if (match[2] !== NONCE) continue;
    bodies.push(match[4] as string);
  }
  return bodies;
}
