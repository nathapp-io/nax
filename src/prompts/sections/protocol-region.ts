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

import { randomUUID } from "node:crypto";
import { NaxError } from "@/errors";

/** Everything the native diff renderer needs; ACP text remains the region body. */
export interface DiffAccessSpec {
  readonly ref: string;
  readonly fullExclude?: readonly string[];
  readonly productionExclude?: readonly string[];
  readonly testGlobs?: readonly string[];
  readonly testAudit?: boolean;
}

export type PromptProtocol = "native" | "acp";

function call(tool: string, input: Record<string, unknown>): string {
  return `${tool} ${JSON.stringify(input)}`;
}

function diffCall(ref: string, paths: readonly string[] | undefined, extra: Record<string, unknown> = {}): string {
  return call("Git", {
    subcommand: "diff",
    refs: [`${ref}..HEAD`],
    ...(paths ? { paths } : {}),
    ...extra,
  });
}

/** Native renderer for the diff-access registry entry and legacy adapter. */
export function renderNative(spec: DiffAccessSpec): string {
  const lines = [
    "## Diff Access",
    "",
    "Fetch the diff yourself with the `Git` tool — do NOT ask for it to be provided.",
    "",
    "`Git` takes structured fields, not a command line. Put **no command-line flags** in",
    "`refs` or `paths`; they are refused. Use the `nameOnly`, `diffFilter`, `oneline` and",
    "`maxCount` fields instead, and read a file with `Read` rather than a shell command.",
    "",
    `**Baseline ref (story start):** \`${spec.ref}\``,
    "",
    "Recommended calls:",
    "",
    "- Full diff including tests:",
    `  \`${diffCall(spec.ref, spec.fullExclude)}\``,
  ];

  if (spec.productionExclude) {
    lines.push("- Production diff only (excludes test files):", `  \`${diffCall(spec.ref, spec.productionExclude)}\``);
  }

  lines.push(
    "- Commit history for this story:",
    `  \`${call("Git", { subcommand: "log", refs: [`${spec.ref}..HEAD`], oneline: true })}\``,
  );

  if (spec.testAudit) {
    lines.push(
      "- Files added in this story (for the test-audit gap):",
      `  \`${diffCall(spec.ref, spec.fullExclude, { nameOnly: true, diffFilter: "A" })}\``,
    );
  }

  lines.push("- Read a specific file's full content:", `  \`${call("Read", { path: "path/to/file.ts" })}\``, "");

  if (spec.testAudit) {
    const guide =
      spec.testGlobs && spec.testGlobs.length > 0
        ? spec.testGlobs.map((glob) => `\`${glob}\``).join(", ")
        : "the resolved project test-file patterns";
    lines.push(
      "**Test audit workflow:**",
      `1. Call the added-files variant above (\`nameOnly\` with \`diffFilter: "A"\`).`,
      `2. For each new source file, check whether a matching test file was added (patterns: ${guide}).`,
      '3. If a new exported module has no test file, flag it as `"test-gap"`.',
      "4. To focus only on production deltas while auditing test coverage, use the production diff call above.",
      "",
    );
  }

  return lines.join("\n");
}

/** Kinds the marker grammar accepts: lowercase, kebab-cased. The grammar's
 *  `[a-z][a-z-]*` group only matches such kinds, so any other shape silently
 *  produces an opener that REGION can never read. */
const KIND_PATTERN = /^[a-z][a-z-]*$/;

/** Per-process nonce. Re-exported here so `wrapAffordance` and
 *  `applyProtocolRegions` produce markers with the same nonce as
 *  `wrapDiffAccess`. Both entry points can then substitute each other's
 *  regions in the same process. */
export const NONCE = randomUUID().slice(0, 8);

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
  readonly protocol: PromptProtocol;
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
 * The registry. Today: `diff-access`, `run-check`, `run-test`,
 * `commit`. The `requires` list is consulted when
 * `advertisedTools` is supplied. When `advertisedTools` is `undefined`,
 * gating is skipped (a caller that does not know which tools the agent
 * advertises must still get the native rendering).
 *
 * `run-check` and `run-test` render a `RunCommand` call
 * whose `command` is the declared key the spec carries. The `command` field
 * in the spec MUST be a key the project actually declared under
 * `quality.commands` — `RunCommand`'s own schema is the runtime check, and
 * a declared key the schema rejects is a shape error the model should never
 * see. Producers are responsible for shaping the spec correctly; the
 * renderer trusts them.
 *
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
  commit: {
    requires: ["GitCommit"],
    render: (spec) => renderGitCommit(spec as CommitSpec),
  },
};

/** Spec shape for `commit`: the commit message the role-task instruction names. */
export interface CommitSpec {
  readonly message: string;
}

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

/** US-005 — the `commit` renderer replaces `git commit -m '<message>'` shell
 *  text with a `GitCommit` call carrying the same message. No framing prose
 *  is added here because the surrounding role-task instruction (e.g. "stage
 *  and commit ALL changed files:") is left outside the region — only the
 *  shell string itself is wrapped, so that prose survives verbatim on both
 *  transports and this renderer only needs to substitute the call form.
 *
 *  Throws if the spec is missing or the message is not a non-empty string.
 *  The caller (applyProtocolRegions) catches and preserves the ACP body —
 *  a damaged spec must cost the native rendering, never the instructions. */
function renderGitCommit(spec: CommitSpec): string {
  if (typeof spec?.message !== "string" || spec.message.length === 0) {
    throw new NaxError(
      `[protocol-region] commit renderer requires a non-empty message, got ${JSON.stringify(spec)}`,
      "COMMIT_SPEC_INVALID",
      { stage: "protocol-region" },
    );
  }
  return `GitCommit {"message": ${JSON.stringify(spec.message)}}`;
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
 *  Failure paths (unknown kind, unparseable spec, damaged spec, foreign
 *  nonce, missing tool, unterminated region) keep the ACP body — a damaged
 *  marker must cost the native rendering, never the instructions. */
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

    // Native: look up the kind. Use Object.hasOwn to avoid prototype key
    // poisoning (constructor, __proto__, toString — all match the marker
    // grammar `[a-z][a-z-]*`).
    if (!Object.hasOwn(REGISTRY, kind)) return body;
    const renderer = REGISTRY[kind];

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

    // Render; a damaged or misproduced spec keeps the body, never silently
    // drops the instructions. Catches throw (e.g. missing required field in
    // the commit spec producing undefined instead of a valid message string).
    try {
      return renderer.render(spec);
    } catch {
      return body;
    }
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
