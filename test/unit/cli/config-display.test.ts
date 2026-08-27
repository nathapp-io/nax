/**
 * Tests for src/cli/config-display.ts
 *
 * SEC-05: `nax config` (default view) printed the fully resolved config,
 * including resolved secrets (e.g. models.<agent>.<tier>.env values), as
 * plaintext JSON. Verify the default view masks sensitive keys/values the
 * same way `nax config profile show` already does.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { configCommand } from "@/cli";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";

describe("configCommand — SEC-05: default view masks secrets", () => {
  let consoleOutput: string[];
  const originalLog = console.log;

  beforeEach(() => {
    consoleOutput = [];
    console.log = mock((message: string) => {
      consoleOutput.push(message);
    });
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test("masks a resolved API key nested under models.<agent>.<tier>.env", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      models: {
        ...DEFAULT_CONFIG.models,
        claude: {
          fast: { model: "claude-fast", provider: "anthropic", env: { OPENAI_API_KEY: "sk-live-super-secret-value" } },
        },
      },
    };

    await configCommand(config, {});

    const output = consoleOutput.join("\n");
    expect(output).not.toContain("sk-live-super-secret-value");
    expect(output).toContain("***");
  });

  test("non-sensitive fields are still printed in plain form", async () => {
    const config = { ...DEFAULT_CONFIG } as NaxConfig;

    await configCommand(config, {});

    const output = consoleOutput.join("\n");
    expect(output).toContain("nax Configuration");
  });
});
