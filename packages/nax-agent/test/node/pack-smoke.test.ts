/**
 * The tarball smoke (S2 spec §7.3): build, stage, `npm pack .publish/`,
 * install into a clean Node project, import the packed package, run one tool
 * round-trip and one native session turn, then typecheck a consumer with
 * skipLibCheck:false. Only diagnostics under the installed package's dist/
 * fail; third-party ones are ignored (the S2-7 api-surface precedent).
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = join(PKG, "test/node/fixtures/packed-smoke.mjs");

function run(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    throw new Error(
      `${cmd} ${args.join(" ")} (cwd ${cwd}) failed with status ${e.status}:\n${e.stdout ?? ""}${e.stderr ?? ""}`,
    );
  }
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
    let output = "";
    try {
      output = run(join(consumer, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], consumer);
    } catch (error) {
      output = (error as Error).message;
    }
    const ownDist = join(consumer, "node_modules/@nathapp/nax-agent/dist/");
    expect(output.split("\n").filter((line) => line.includes(ownDist))).toEqual([]);
  }, 120_000);
});
