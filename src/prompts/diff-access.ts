/**
 * How a reviewer is told to obtain the story diff, rendered per protocol.
 *
 * The problem this solves (#1800, #1818): the review prompts hand the agent
 * literal `git diff --unified=3 <ref>..HEAD -- . ':!.nax/'` strings. Under ACP
 * that is correct — the agent has a shell. On the native path there is no
 * shell, only a `Git` tool taking structured refs and pathspecs, and
 * `buildGitArgv` refuses any element beginning with "-". A model handed the
 * shell text transliterates it into the structured fields and is refused: 12 of
 * the 19 Git failures across the tool-audit ledgers are exactly that shape.
 *
 * Why the text is substituted at dispatch rather than chosen in the builder:
 * `operations/call.ts:55` joins the prompt before `:69` resolves the dispatch
 * agent, and a fallback swap can change the protocol after the prompt string
 * already exists. The builder cannot know which protocol will receive its text.
 * `agents/tool-preamble.ts` is the existing precedent for that branch and
 * carries this one too.
 *
 * Why a delimited region rather than a placeholder token: the body between the
 * markers IS the ACP text, so if substitution never runs the prompt degrades to
 * exactly what shipped before this change. A placeholder would degrade to a
 * prompt with no diff instructions at all, which is the worse failure and the
 * harder one to notice.
 */

/** Everything the native rendering needs; the ACP rendering is the body itself. */
export interface DiffAccessSpec {
  /** Baseline ref for the story, as a bare revision. */
  readonly ref: string;
  /** Pathspecs for the "everything except nax metadata" diff. Omit for an unfiltered diff. */
  readonly fullExclude?: readonly string[];
  /** Pathspecs for the production-only diff. Omitted when the prompt does not offer one. */
  readonly productionExclude?: readonly string[];
  /** Test-file globs, quoted into the test-gap step. */
  readonly testGlobs?: readonly string[];
  /** Emit the added-files call and the test-audit workflow. */
  readonly testAudit?: boolean;
}

export type PromptProtocol = "native" | "acp";

const OPEN = "<!--nax:diff-access ";
const CLOSE = "<!--/nax:diff-access-->";
const REGION = /<!--nax:diff-access (\{.*?\})-->\n([\s\S]*?)<!--\/nax:diff-access-->\n?/g;

/**
 * Wrap the protocol-agnostic body so dispatch can swap it.
 *
 * The spec is JSON on the opening marker. A pathspec containing "-->" would
 * break the region; none can, because git pathspecs here are built from
 * configured test globs and the fixed nax metadata paths, never from model
 * input.
 */
export function wrapDiffAccess(spec: DiffAccessSpec, shellBody: string): string {
  return `${OPEN}${JSON.stringify(spec)}-->\n${shellBody}${CLOSE}\n`;
}

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

function renderNative(spec: DiffAccessSpec): string {
  const lines = [
    "## Diff Access",
    "",
    "Fetch the diff yourself with the `Git` tool — do NOT ask for it to be provided.",
    "",
    "`Git` takes structured fields, not a command line. Put **no command-line flags** in",
    "`refs` or `paths`; they are refused. Use the `nameOnly`, `diffFilter` and `oneline`",
    "fields instead, and read a file with `Read` rather than a shell command.",
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

/**
 * Render every diff-access region for the protocol actually being dispatched.
 *
 * A region whose spec will not parse keeps its body: a damaged marker must cost
 * the native rendering, never the instructions.
 */
export function applyDiffAccess(prompt: string, protocol: PromptProtocol): string {
  if (!prompt.includes(OPEN)) return prompt;

  return prompt.replace(REGION, (_whole, json: string, body: string) => {
    if (protocol === "acp") return body;
    try {
      return renderNative(JSON.parse(json) as DiffAccessSpec);
    } catch {
      return body;
    }
  });
}
