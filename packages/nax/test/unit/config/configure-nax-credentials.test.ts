import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsConfig } from "@/agents/infra";
import { credentialFilePath } from "@/agents/native";
import { configureNaxCredentials } from "@/config";

describe("configureNaxCredentials", () => {
  let previous: string | undefined;
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    previous = process.env.NAX_GLOBAL_CONFIG_DIR;
    dirA = mkdtempSync(join(tmpdir(), "nax-cred-a-"));
    dirB = mkdtempSync(join(tmpdir(), "nax-cred-b-"));
    configureNaxCredentials();
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = previous;
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  test("follows NAX_GLOBAL_CONFIG_DIR live", () => {
    process.env.NAX_GLOBAL_CONFIG_DIR = dirA;
    expect(credentialFilePath()).toBe(join(dirA, "credentials"));
    process.env.NAX_GLOBAL_CONFIG_DIR = dirB;
    expect(credentialFilePath()).toBe(join(dirB, "credentials"));
  });

  test("re-reads the auth config on every call", async () => {
    process.env.NAX_GLOBAL_CONFIG_DIR = dirA;
    expect((await credentialsConfig().readAuthConfig()).onChange).toBe("warn");
    writeFileSync(join(dirA, "config.json"), JSON.stringify({ auth: { onChange: "refuse" } }));
    expect((await credentialsConfig().readAuthConfig()).onChange).toBe("refuse");
  });
});
