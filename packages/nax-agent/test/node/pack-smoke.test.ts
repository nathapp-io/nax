/**
 * The tarball smoke (S2 spec §7.3): build, stage, `npm pack .publish/`,
 * install into a clean Node project, import the packed package, run one tool
 * round-trip and one native session turn, then typecheck a consumer with
 * skipLibCheck:false. Only diagnostics under the installed package's dist/
 * fail; third-party ones are ignored (the S2-7 api-surface precedent).
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = join(PKG, "test/node/fixtures/packed-smoke.mjs");

function run(cmd: string, args: string[], cwd: string): string {
  const proc = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (proc.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} (cwd ${cwd}) failed with status ${proc.status}:\n${proc.stdout}${proc.stderr}`,
    );
  }
  return proc.stdout;
}

let consumer = "";
let packDir = "";

beforeAll(() => {
  run("bun", ["run", "build"], PKG);
  run("bun", ["scripts/stage-publish.ts"], PKG);
  packDir = mkdtempSync(join(tmpdir(), "nax-pack-"));
  run("npm", ["pack", ".publish/", "--pack-destination", packDir], PKG);
  const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  if (tgz === undefined) throw new Error(`npm pack produced no tarball in ${packDir}`);
  consumer = mkdtempSync(join(tmpdir(), "nax-consumer-"));
  run("npm", ["init", "-y"], consumer);
  run(
    "npm",
    ["install", "--no-audit", "--no-fund", join(packDir, tgz), "typescript@7.0.2", "@types/node@25.2.3"],
    consumer,
  );
}, 300_000);

afterAll(() => {
  if (packDir !== "") rmSync(packDir, { recursive: true, force: true });
  if (consumer !== "") rmSync(consumer, { recursive: true, force: true });
});

describe("the packed tarball", () => {
  test("runs one tool round-trip, one native turn and (on Linux) one sandboxed command", () => {
    cpSync(FIXTURE, join(consumer, "packed-smoke.mjs"));
    expect(run("node", ["packed-smoke.mjs"], consumer)).toContain("packed smoke ok");
  }, 180_000);

  test("typechecks for a skipLibCheck:false consumer; only third-party diagnostics are allowed", () => {
    writeFileSync(
      join(consumer, "index.ts"),
      [
        'import { NativeSessionAdapter, getAgentRuntime, globTool, nodeRuntime, setAgentRuntime } from "@nathapp/nax-agent";',
        'import { _clientDeps } from "@nathapp/nax-agent/internal";',
        "export const names = [typeof NativeSessionAdapter, typeof getAgentRuntime, typeof globTool, typeof nodeRuntime, typeof setAgentRuntime, typeof _clientDeps];",
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
    const tsc = spawnSync(join(consumer, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], {
      cwd: consumer,
      encoding: "utf8",
    });
    expect(tsc.error).toBeUndefined();
    expect(tsc.status).not.toBeNull();
    // tsc prints diagnostic paths relative to its cwd (Linux CI), so match the
    // fragment, never an absolute path — an absolute match is vacuous there.
    const ownDist = "node_modules/@nathapp/nax-agent/dist/";
    const errorLines = `${tsc.stdout}${tsc.stderr}`.split("\n").filter((line) => line.includes("error TS"));
    expect(errorLines.filter((line) => line.includes(ownDist))).toEqual([]);
    // A failure to resolve the package at all lands on the consumer's index.ts;
    // only third-party diagnostics may mention a package other than ours.
    expect(errorLines.filter((line) => line.includes("@nathapp/nax-agent") && !line.includes(ownDist))).toEqual([]);
  }, 120_000);
});
