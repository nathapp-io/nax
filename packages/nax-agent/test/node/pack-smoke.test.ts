/**
 * The tarball smoke (S2 spec §7.3): build, stage, `npm pack .publish/`,
 * install into a clean Node project, import the packed package, run one tool
 * round-trip and one native session turn, then typecheck a consumer with
 * skipLibCheck:false. Only diagnostics under the installed package's dist/
 * fail; third-party ones are ignored (the S2-7 api-surface precedent).
 * `@nathapp/nax-ai` is packed from the workspace at the shared lockstep
 * version too, so the install resolves its pin locally instead of from npm.
 */
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runSmokeCommand as run } from "./helpers/process";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = join(PKG, "test/node/fixtures/packed-smoke.mjs");
const AI_PKG = join(PKG, "../nax-ai");

let consumer = "";
let packDir = "";
let aiPackDir = "";

beforeAll(() => {
  run("bun", ["run", "build"], PKG);
  run("bun", ["scripts/stage-publish.ts"], PKG);
  packDir = mkdtempSync(join(tmpdir(), "nax-pack-"));
  run("npm", ["pack", ".publish/", "--pack-destination", packDir], PKG);
  const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  if (tgz === undefined) throw new Error(`npm pack produced no tarball in ${packDir}`);
  // The packed nax-agent pins @nathapp/nax-ai at the shared lockstep version,
  // which is not on npm until the release runs; pack it from the workspace so
  // the install resolves the pin locally instead of from the registry.
  run("bun", ["run", "build"], AI_PKG);
  aiPackDir = mkdtempSync(join(tmpdir(), "nax-ai-pack-"));
  run("npm", ["pack", AI_PKG, "--pack-destination", aiPackDir, "--ignore-scripts"], PKG);
  const aiTgz = readdirSync(aiPackDir).find((f) => f.endsWith(".tgz"));
  if (aiTgz === undefined) throw new Error(`npm pack nax-ai produced no tarball in ${aiPackDir}`);
  consumer = mkdtempSync(join(tmpdir(), "nax-consumer-"));
  run("npm", ["init", "-y"], consumer);
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      join(packDir, tgz),
      join(aiPackDir, aiTgz),
      "typescript@7.0.2",
      "@types/node@25.2.3",
    ],
    consumer,
    120_000,
  );
}, 300_000);

afterAll(() => {
  if (packDir !== "") rmSync(packDir, { recursive: true, force: true });
  if (aiPackDir !== "") rmSync(aiPackDir, { recursive: true, force: true });
  if (consumer !== "") rmSync(consumer, { recursive: true, force: true });
});

describe("the packed tarball", () => {
  test("runs one tool round-trip, one native turn, the S3 chat round-trip and (on Linux) one sandboxed command", () => {
    cpSync(FIXTURE, join(consumer, "packed-smoke.mjs"));
    cpSync(join(PKG, "test/node/fixtures/packed-mcp-server.mjs"), join(consumer, "packed-mcp-server.mjs"));
    expect(run("node", ["packed-smoke.mjs"], consumer, 120_000)).toContain("packed smoke ok");
  }, 180_000);

  test("typechecks for a skipLibCheck:false consumer; only third-party diagnostics are allowed", () => {
    writeFileSync(
      join(consumer, "index.ts"),
      [
        'import { NativeSessionAdapter, createAgentSession, getAgentRuntime, globTool, nodeRuntime, resumeAgentSession, setAgentRuntime, type SessionEvent } from "@nathapp/nax-agent";',
        'import { _clientDeps } from "@nathapp/nax-agent/internal";',
        'import { connectMcp, type McpConnection } from "@nathapp/nax-agent/mcp";',
        "export type Event = SessionEvent;",
        "export const names = [typeof NativeSessionAdapter, typeof createAgentSession, typeof getAgentRuntime, typeof globTool, typeof nodeRuntime, typeof resumeAgentSession, typeof setAgentRuntime, typeof _clientDeps];",
        "export type Mcp = McpConnection;",
        "export const mcp = typeof connectMcp;",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "nodenext",
          moduleResolution: "nodenext",
          lib: ["ES2023"],
          types: ["node"],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        include: ["index.ts"],
      }),
    );
    // Type errors are filtered below; spawn failures and deadlines still fail.
    const output = run(join(consumer, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], consumer, 90_000, [0, 1, 2]);
    // tsc prints diagnostic paths relative to its cwd (Linux CI), so match the
    // fragment, never an absolute path — an absolute match is vacuous there.
    const ownDist = "node_modules/@nathapp/nax-agent/dist/";
    const errorLines = output.split("\n").filter((line) => line.includes("error TS"));
    expect(errorLines.filter((line) => line.includes(ownDist))).toEqual([]);
    // A failure to resolve the package at all lands on the consumer's index.ts;
    // only third-party diagnostics may mention a package other than ours.
    expect(errorLines.filter((line) => line.includes("@nathapp/nax-agent") && !line.includes(ownDist))).toEqual([]);
  }, 120_000);
});
