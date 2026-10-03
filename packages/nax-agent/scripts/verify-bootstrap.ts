#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { assertBootstrapArtifact } from "./lib/bootstrap-artifact.ts";

const temp = mkdtempSync(join(tmpdir(), "nax-agent-bootstrap-"));
try {
  const output = execFileSync("npm", ["pack", "@nathapp/nax-agent@0.1.0", "--json", "--ignore-scripts"], {
    cwd: temp,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const filename: unknown = JSON.parse(output)[0]?.filename;
  if (typeof filename !== "string" || basename(filename) !== filename || !filename.endsWith(".tgz")) {
    throw new Error("bootstrap: npm pack returned an invalid filename");
  }
  const tarball = join(temp, filename);
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", timeout: 30_000 });
  for (const entry of entries.trim().split("\n")) {
    if (!entry.startsWith("package/") || entry.split("/").includes("..")) {
      throw new Error(`bootstrap: unsafe tar entry ${entry}`);
    }
  }
  execFileSync("tar", ["-xzf", tarball, "-C", temp], { timeout: 30_000 });
  assertBootstrapArtifact(resolve(import.meta.dirname, "../.publish"), join(temp, "package"));
  console.log("bootstrap: registry 0.1.0 matches the prepared artifact; upload already complete");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
