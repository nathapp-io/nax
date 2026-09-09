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

import { NaxError } from "@/errors";
import { NONCE as DIFF_NONCE, type DiffAccessSpec, renderNative } from "./diff-access";

/** Kinds the marker grammar accepts: lowercase, kebab-cased. The grammar's
 *  `[a-z][a-z-]*` group only matches such kinds, so any other shape silently
 *  produces an opener that REGION can never read. */
const KIND_PATTERN = /^[a-z][a-z-]*$/;

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

/** `<!--nax:<kind>:<own nonce> ` — an opening marker written by this process. */
const OWN_OPEN = new RegExp(`<!--nax:[a-z][a-z-]*:${NONCE} `, "g");

/**
 * The registry. Today: `diff-access`, `run-check`, `run-test`, `test-scope`.
 * US-005 will add `commit`. The `requires` list is consulted when
 * `advertisedTools` is supplied. When `advertisedTools` is `undefined`,
 * gating is skipped (a caller that does not know which tools the agent
 * advertises must still get the native rendering).
 *
 * `run-check` and `run-test` and `test-scope` render a `RunCommand` call
 * whose `command` is the declared key the spec carries. The `command` field
 * in the spec MUST be a key the project actually declared under
 * `quality.commands` — `RunCommand`'s own schema is the runtime check, and
 * a declared key the schema rejects is a shape error the model should never
 * see. Producers are responsible for shaping the spec correctly; the
 * renderer trusts them.
 *
 * `test-scope` is the kind the isolation section and the escalated
 * rectification prompt use to wrap shell-form test instructions whose
 * native rendering is "run only the named test files". The framing differs
 * from `run-test` because the agent is not re-running a failing acceptance
 * test — it is scoping a routine test invocation to its own changed files.
 */
const REGISTRY: Record<string, AffordanceNativeRenderer> = {
  "diff-access": {
    requires: ["Git", "Read"],
    render: (spec) => renderNative(spec as DiffAccessSpec),
  },
  "run-check": {
    requires: ["RunCommand"],
    render: (spec) => renderRunCommandCheck(spec as RunCommandSpec),
  },
  "run-test": {
    requires: ["RunCommand"],
    render: (spec) => renderRunCommandTest(spec as RunCommandTestSpec),
  },
  "test-scope": {
    requires: ["RunCommand"],
    render: (spec) => renderRunCommandTestScope(spec as RunCommandTestSpec),
  },
};

/** Spec shape for `run-check`: a declared key the project's
 *  `quality.commands` map carries. */
export interface RunCommandSpec {
  readonly command: string;
}

/** Spec shape for `run-test`: a declared scoped-test key (one whose template
 *  carries the `{{files}}` placeholder) and the path the model passes for it. */
export interface RunCommandTestSpec {
  readonly command: string;
  readonly files: string;
}

function renderRunCommandCheck(spec: RunCommandSpec): string {
  // The prose that frames the call is not optional: the native agent receives
  // ONLY this renderer output (the ACP body is dropped at substitution), so
  // a context-less "RunCommand ..." would leave it without an instruction.
  // The framing mirrors the prose the ACP body carried before US-003, so the
  // two transports read the same intent in their own affordance.
  return (
    `Run the project's declared \`${spec.command}\` check:\n` +
    `RunCommand {"command": ${JSON.stringify(spec.command)}}`
  );
}

function renderRunCommandTest(spec: RunCommandTestSpec): string {
  // Same shape as run-check: the prose that frames the call survives only
  // here, not in the ACP body. The framing tells the native agent what the
  // call is for and what file it should target.
  // JSON.stringify, not interpolation: the rendered call is a JSON literal
  // the agent copies, and a path holding a quote or a backslash would
  // otherwise produce something it cannot parse.
  return (
    "Re-run the failing acceptance test before you finish:\n" +
    `RunCommand {"command": ${JSON.stringify(spec.command)}, "values": {"files": ${JSON.stringify(spec.files)}}}`
  );
}

/** US-004 — framing for `test-scope`: the isolation section's "scope each
 *  run to the files you changed" rule and the escalated rectification
 *  prompt's per-failing-file lines. Distinct from `run-test`'s framing
 *  ("Re-run the failing acceptance test...") because the agent is not
 *  re-running a failing acceptance test — it is invoking the project's
 *  scoped test command on a specific file. */
function renderRunCommandTestScope(spec: RunCommandTestSpec): string {
  return (
    "Run only the test files related to your changes:\n" +
    `RunCommand {"command": ${JSON.stringify(spec.command)}, "values": {"files": ${JSON.stringify(spec.files)}}}`
  );
}

/** Wrap ACP text behind opening/closing markers carrying the spec and kind.
 *
 *  The spec is JSON-encoded into the opening marker. A spec containing the
 *  literal "-->" would break the region; none of the registered specs can
 *  produce one (specs are built from configured test globs and the fixed
 *  nax metadata paths, never from model input).
 *
 *  Validation: the kind must match the marker grammar (`[a-z][a-z-]*`) and
 *  the spec must be a JSON object — the grammar's `(\{.*?\})` group only
 *  matches an object-literal JSON. Without this guard a producer passing an
 *  uppercase kind or a non-object spec (array, string, number, null) silently
 *  emits an opener that REGION cannot match: `applyProtocolRegions` will not
 *  strip it under ACP, `unwrapProtocolRegions` will not strip it for
 *  persistence, and the AC9 freeze will not even recognise the opener as one
 *  of ours. Marker text would ship into dispatched and persisted prompts with
 *  no error. Throw at the wrap site so the producer fixes the call. */
export function wrapAffordance(kind: string, spec: unknown, acpBody: string): string {
  if (typeof kind !== "string" || !KIND_PATTERN.test(kind)) {
    throw new NaxError(
      `wrapAffordance: kind must match ${KIND_PATTERN.source} (got ${JSON.stringify(kind)})`,
      "AFFORDANCE_KIND_INVALID",
      { stage: "protocol-region", kind },
    );
  }
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new NaxError(
      `wrapAffordance: spec must be a JSON object so REGION can parse it (got ${spec === null ? "null" : typeof spec})`,
      "AFFORDANCE_SPEC_INVALID",
      { stage: "protocol-region", kind },
    );
  }
  return `<!--nax:${kind}:${NONCE} ${JSON.stringify(spec)}-->\n${acpBody}<!--/nax:${kind}-->\n`;
}

/** True when the prompt carries an own-nonce opener that never closes.
 *
 *  AC9 mandates that such a prompt is returned whole. Content spliced from
 *  other sources (prior findings, embedded diffs) cannot forge this process's
 *  nonce, so an own-nonce opener without a matching close can only be genuine
 *  damage — the freeze suppresses no legitimate rendering and cannot be
 *  triggered by untrusted text. */
function hasUnterminatedOwnOpener(prompt: string): boolean {
  const ownOpeners = Array.from(prompt.matchAll(OWN_OPEN)).length;
  if (ownOpeners === 0) return false;

  // Every well-formed own opener yields exactly one own REGION match; one
  // that never closes (or closes under the wrong kind) matches nothing.
  const matched = Array.from(prompt.matchAll(REGION)).filter((m) => m[2] === NONCE).length;
  return matched < ownOpeners;
}

/** Substitute every matching region for the protocol being dispatched.
 *
 *  Failure paths (unknown kind, unparseable spec, foreign nonce, missing
 *  tool, unterminated region) keep the ACP body — a damaged marker must
 *  cost the native rendering, never the instructions. */
export function applyProtocolRegions(prompt: string, opts: ApplyProtocolRegionsOpts): string {
  if (!prompt.includes(PROTOCOL_REGION_MARKER_PREFIX)) return prompt;

  // AC9: an own-nonce opener with no matching close leaves the whole prompt
  // unchanged — nothing is substituted and no characters are removed. Scoped
  // to our own nonce, so foreign-nonce forgeries never trigger the freeze.
  if (hasUnterminatedOwnOpener(prompt)) return prompt;

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

/** Strip every region marker from a prompt, returning the full unwrapped text.
 *
 *  Each region (of any kind and any nonce) is replaced by its ACP body, so
 *  every surrounding character is preserved byte-for-byte. The result contains
 *  every ACP body and no region marker at all — which is what a caller that
 *  persists a prompt to disk needs: the marker grammar is internal bookkeeping
 *  and must not ship with the recorded text.
 *
 *  A marker written by another process is not interpreted (its nonce is not
 *  ours) — only its HTML-comment wrapper is removed and its content kept,
 *  exactly as it appeared in the prompt. */
export function unwrapProtocolRegions(text: string): string {
  if (!text.includes(PROTOCOL_REGION_MARKER_PREFIX)) return text;
  return text.replace(REGION, (_whole, _kind, _nonce, _spec, body) => body);
}
