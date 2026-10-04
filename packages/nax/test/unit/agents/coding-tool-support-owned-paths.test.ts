/**
 * S3-2 characterization: nax's owned-path refusals, end to end through the real
 * dispatch entry. Written before the OwnedPathsPolicy port exists and kept
 * green through the move: if nax ever stops injecting its OwnedPathsPolicy,
 * the nax-agent default (no owned paths) makes every one of these writable and
 * this fails.
 *
 * Adapted from the brief's draft in three places (rulings in task-1-report.md):
 * - Exec is not a registered tool (its argv branch runs under RunCommand), so
 *   the positional-path case calls RunCommand with `argv`.
 * - The argv positional-path conflict surfaces as kind "error" (isError tool
 *   result from normalizeExec), not kind "denied".
 * - "RunCommand" joins declaredTools so the argv branch is reachable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _resetSandboxRegistryForTests, type CodingToolName } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support-resolve";

let root: string;
beforeEach(() => {
  root = makeTempDir("nax-owned-paths-");
  mkdirSync(join(root, ".nax", "features", "f"), { recursive: true });
  writeFileSync(join(root, ".nax", "config.json"), "{}");
  writeFileSync(join(root, ".nax", "features", "f", "prd.json"), "{}");
  writeFileSync(join(root, ".queue.txt"), "");
});
afterEach(() => {
  cleanupTempDir(root);
  _resetSandboxRegistryForTests();
});

const DECLARED: readonly CodingToolName[] = ["Read", "Write", "Bash", "Glob", "Exec", "RunCommand"];

async function denialFor(tool: string, input: Record<string, unknown>, bashApproval?: "raw"): Promise<string> {
  const support = await resolveCodingToolSupport({
    declaredTools: DECLARED,
    codingToolRoot: root,
    pipelineStage: "run",
    config: makeNaxConfig({
      execution: {
        permissionProfile: "unrestricted",
        sandbox: { enabled: false },
        ...(bashApproval !== undefined ? { bashApproval } : {}),
      },
    }),
  });
  const outcome = await support?.runtime.callTool(tool, input);
  if (outcome?.kind !== "denied") throw new Error(`expected ${tool} to be denied, got ${outcome?.kind}`);
  return outcome.reason;
}

async function okContent(tool: string, input: Record<string, unknown>): Promise<string> {
  const support = await resolveCodingToolSupport({
    declaredTools: DECLARED,
    codingToolRoot: root,
    pipelineStage: "run",
    config: makeNaxConfig({ execution: { permissionProfile: "unrestricted", sandbox: { enabled: false } } }),
  });
  const outcome = await support?.runtime.callTool(tool, input);
  if (outcome?.kind !== "ok") throw new Error(`expected ${tool} to run, got ${outcome?.kind}`);
  return JSON.stringify(outcome);
}

const CONFIG_REASON =
  'path ".nax/config.json" is one of nax\'s own config files, which every tool is refused regardless of grant -- ' +
  "`quality.commands` and `acceptance.command` are run through a shell WITHOUT passing the permission gate " +
  "because a human wrote them, so editing this file is a route to running an ungated command on the next run";

describe("nax owned paths through resolveCodingToolSupport (S3-2 byte-identity pin)", () => {
  test("Write to the PRD", async () => {
    expect(await denialFor("Write", { path: ".nax/features/f/prd.json", content: "x" })).toBe(
      'Write may not modify ".nax/features/f/prd.json" is nax\'s own run state: it holds the acceptance criteria this story is judged against, so no tool may modify it. Change the code, not the criteria.',
    );
  });

  test("Write to the queue file", async () => {
    expect(await denialFor("Write", { path: ".queue.txt", content: "ABORT" })).toBe(
      'Write may not modify ".queue.txt" is nax\'s own run state: it carries the PAUSE/ABORT/SKIP commands that control this run, so no tool may modify it. Change the run through the queue command, not by writing its file.',
    );
  });

  test("Write to other .nax state", async () => {
    expect(await denialFor("Write", { path: ".nax/features/f/context.md", content: "x" })).toBe(
      "Write may not modify \".nax/features/f/context.md\" is nax's own state, which agents do not modify. Under .nax/, write only to your scratchpad (.nax/scratchpad/) or to a feature's acceptance test file. A human can open a path for a story by listing it in execution.sandbox.filesystem.allowWrite in the project config.",
    );
  });

  test("Read of nax config is refused like a write", async () => {
    expect(await denialFor("Read", { path: ".nax/config.json" })).toBe(CONFIG_REASON);
  });

  test("raw Bash naming the queue file", async () => {
    // `cat` maps to the READ intent, so the runtime appends a redirect to Read
    // (runtime-calltool.ts resolveDenialOutcome, denial-redirect.ts).
    expect(await denialFor("Bash", { command: "cat .queue.txt" }, "raw")).toBe(
      'Bash command names ".queue.txt", which is nax\'s run-control queue. Bash commands naming it are refused, reads included -- change the run through the queue command.' +
        " -- this session already has `Read` -- Read returns file contents, by line range with offset/limit",
    );
  });

  test("raw Bash redirecting into nax config", async () => {
    expect(await denialFor("Bash", { command: "echo x > .nax/config.json" }, "raw")).toBe(
      'Bash command redirects into ".nax/config.json", which is nax configuration. Bash commands naming it are refused, reads included -- nax configuration is not changed from inside a run.',
    );
  });

  test("Glob does not list nax config (ToolRunContext.ownedPaths)", async () => {
    // Glob's node runtime never descends into a dot segment, so `.nax/` itself
    // is unlistable regardless of ownership; a symlink named without a dot
    // segment is the only spelling that reaches resolveWithin with a nax-owned
    // target. A symlink to an ordinary file is listed; a symlink to nax config
    // is discarded by resolveWithin's owned-config branch.
    writeFileSync(join(root, ".nax", "notes.json"), "{}");
    symlinkSync(".nax/notes.json", join(root, "plain.json"));
    symlinkSync(".nax/config.json", join(root, "naxcfg.json"));
    const listed = await okContent("Glob", { pattern: "plain.json" });
    expect(listed).toContain("plain.json");
    const refused = await okContent("Glob", { pattern: "naxcfg.json" });
    expect(refused).toContain("no matches");
  });

  test("Exec refuses a positional path to nax config (ToolRunContext.ownedPaths)", async () => {
    // Exec is the identity of a RunCommand call carrying `argv` (no "Exec"
    // tool is registered), the positional-path screen fires only on
    // path-SHAPED tokens (`./`-prefixed counts; a bare `.nax/...` does not),
    // and the conflict from normalizeExec surfaces as an isError tool result:
    // kind "error".
    const support = await resolveCodingToolSupport({
      declaredTools: DECLARED,
      codingToolRoot: root,
      pipelineStage: "run",
      config: makeNaxConfig({ execution: { permissionProfile: "unrestricted", sandbox: { enabled: false } } }),
    });
    const outcome = await support?.runtime.callTool("RunCommand", { argv: ["bun", "add", "./.nax/config.json"] });
    if (outcome?.kind !== "error") throw new Error(`expected RunCommand(Exec) to error, got ${outcome?.kind}`);
    expect(outcome.content).toContain(
      'argv contains a path-shaped argument "./.nax/config.json" that resolves outside the permitted root',
    );
  });
});
