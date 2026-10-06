/**
 * The tarball smoke for both packages (S4 spec §9, §11.1). Builds and stages
 * nax-agent and nax-agent-acp into temporary directories at one version (D6-i:
 * the staged nax-agent copy takes nax-agent-acp's version until the release PR
 * bumps both; the source tree is never touched), packs both, installs them into
 * a clean Node project, runs the fake-agent chat and resume there, then
 * typechecks a consumer with skipLibCheck:false. Only diagnostics under the
 * installed nax-agent-acp's dist/ fail; third-party ones are ignored.
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runSmokeCommand as run } from "#test/helpers/smoke-command";
// biome-ignore lint/style/noRestrictedImports: the package's own staging lib, not an outside package
import { buildStagedManifest } from "../../scripts/lib/stage-manifest.ts";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const AGENT_PKG = join(PKG, "../nax-agent");
const REPOSITORY = "git+https://github.com/nathapp-io/nax.git";

const temps: string[] = [];
let consumer = "";

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** npm pack `dir` into a fresh directory; the tarball's path. */
function pack(dir: string): string {
  const into = temp("acp-pack-");
  run("npm", ["pack", dir, "--pack-destination", into], PKG, 60_000);
  const tgz = readdirSync(into).find((f) => f.endsWith(".tgz"));
  if (tgz === undefined) throw new Error(`npm pack produced no tarball in ${into}`);
  return join(into, tgz);
}

/** nax-agent's own stage-publish, copied out and given `version` (D6-i). */
function stageAgent(version: string): string {
  run("bun", ["run", "build"], AGENT_PKG, 180_000);
  run("bun", ["scripts/stage-publish.ts"], AGENT_PKG, 60_000);
  const out = temp("acp-stage-agent-");
  cpSync(join(AGENT_PKG, ".publish"), out, { recursive: true });
  const manifest = readJson(join(out, "package.json"));
  writeFileSync(join(out, "package.json"), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  return out;
}

/** nax-agent-acp staged as stage-publish stages it, with the peer range on `version`. */
function stageAcp(version: string): string {
  run("bun", ["run", "build"], PKG, 180_000);
  const out = temp("acp-stage-acp-");
  cpSync(join(PKG, "dist"), join(out, "dist"), { recursive: true });
  for (const file of ["README.md", "CHANGELOG.md", "LICENSE"]) cpSync(join(PKG, file), join(out, file));
  const manifest = buildStagedManifest(readJson(join(PKG, "package.json")), {
    repository: REPOSITORY,
    directory: "packages/nax-agent-acp",
    naxAgentVersion: version,
  });
  writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return out;
}

beforeAll(() => {
  const version = String(readJson(join(PKG, "package.json")).version);
  const agentTgz = pack(stageAgent(version));
  const acpTgz = pack(stageAcp(version));
  consumer = temp("acp-consumer-");
  run("npm", ["init", "-y"], consumer);
  // npm init -y leaves no "type", so Node 24 loads the fake agent's .ts entry as CJS and fails.
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ ...readJson(join(consumer, "package.json")), type: "module" }, null, 2)}\n`,
  );
  run(
    "npm",
    ["install", "--no-audit", "--no-fund", agentTgz, acpTgz, "typescript@7.0.2", "@types/node@25.2.3"],
    consumer,
    240_000,
  );
  cpSync(join(PKG, "test/fixtures/fake-agent"), join(consumer, "fake-agent"), { recursive: true });
}, 600_000);

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the packed tarballs", () => {
  test("a fake-agent turn, a close and a resume in a new process", () => {
    cpSync(join(PKG, "test/node/fixtures/packed-smoke.mjs"), join(consumer, "packed-smoke.mjs"));
    expect(run("node", ["packed-smoke.mjs"], consumer, 120_000)).toContain("packed smoke ok");
  }, 180_000);

  test("typechecks for a skipLibCheck:false consumer; only third-party diagnostics are allowed", () => {
    writeFileSync(
      join(consumer, "index.ts"),
      [
        'import { ACP_STOP_CODES, acpBackend, type AcpBackendOptions, type AcpStopCode } from "@nathapp/nax-agent-acp/client";',
        'import * as server from "@nathapp/nax-agent-acp/server";',
        "export type Options = AcpBackendOptions;",
        "export type Stop = AcpStopCode;",
        "export const names = [typeof acpBackend, ACP_STOP_CODES, server];",
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
          lib: ["ES2023", "DOM"],
          types: ["node"],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        include: ["index.ts"],
      }),
    );
    const output = run(join(consumer, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], consumer, 120_000, [0, 1, 2]);
    // tsc prints paths relative to its cwd (Linux CI): match the fragment, never an absolute path.
    const ownDist = "node_modules/@nathapp/nax-agent-acp/dist/";
    const errorLines = output.split("\n").filter((line) => line.includes("error TS"));
    expect(errorLines.filter((line) => line.includes(ownDist))).toEqual([]);
    expect(errorLines.filter((line) => line.includes("@nathapp/nax-agent-acp") && !line.includes(ownDist))).toEqual([]);
  }, 180_000);
});
