import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("auth command wiring", () => {
  test("the native barrel re-exports the auth surface", async () => {
    const barrel = await import("@/agents/native");
    expect(typeof barrel.runLogin).toBe("function");
    expect(typeof barrel.importPiCredentials).toBe("function");
    expect(typeof barrel.listStoredProviders).toBe("function");
    expect(typeof barrel.removeStoredProvider).toBe("function");
    expect(typeof barrel.ambientShadows).toBe("function");
    expect(typeof barrel.naxCredentialStore).toBe("function");
  });

  test("the cli barrel exports the four commands", async () => {
    const barrel = await import("@/cli");
    expect(typeof barrel.authLoginCommand).toBe("function");
    expect(typeof barrel.authImportCommand).toBe("function");
    expect(typeof barrel.authListCommand).toBe("function");
    expect(typeof barrel.authRmCommand).toBe("function");
  });

  test("bin registers all four subcommands under an auth group", () => {
    const source = readFileSync(join(ROOT, "bin", "nax.ts"), "utf8");
    expect(source).toContain('program.command("auth")');
    expect(source).toContain('.command("login <provider>")');
    expect(source).toContain('.command("import")');
    expect(source).toContain('.command("list")');
    expect(source).toContain('.command("rm <provider>")');
  });

  test("the preload scrubs ambient provider keys, so probes cannot pass for the wrong reason", () => {
    const source = readFileSync(join(ROOT, "test", "preload.ts"), "utf8");
    // Scrubbed by pattern, not a fixed provider list — see the comment above
    // the loop in preload.ts for why. Assert the pattern itself is present,
    // and that it actually took effect on the environment this process saw.
    expect(source).toMatch(/_API_KEY\$/);
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });
});
