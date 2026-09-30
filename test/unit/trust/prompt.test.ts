import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadTrustModule } from "@test/helpers";

const trust = await loadTrustModule();
let originalAsk: typeof trust._trustPromptDeps.ask | undefined;

beforeEach(() => {
  expect(typeof trust._trustPromptDeps).toBe("object");
  originalAsk = trust._trustPromptDeps.ask;
});

afterEach(() => {
  if (originalAsk) trust._trustPromptDeps.ask = originalAsk;
});

describe("promptTrustChoice", () => {
  test("US-002 AC14: treats a trimmed uppercase Y as yes", async () => {
    trust._trustPromptDeps.ask = async () => "Y";

    await expect(trust.promptTrustChoice("/r/p", "/r")).resolves.toBe("yes");
  });

  test("US-002 AC15: treats a trimmed parent answer as parent", async () => {
    trust._trustPromptDeps.ask = async () => " parent ";

    await expect(trust.promptTrustChoice("/r/p", "/r")).resolves.toBe("parent");
  });

  test("US-002 AC16: treats an empty answer as no", async () => {
    trust._trustPromptDeps.ask = async () => "";

    await expect(trust.promptTrustChoice("/r/p", "/r")).resolves.toBe("no");
  });

  test("US-002 AC17: treats end of input as no", async () => {
    trust._trustPromptDeps.ask = async () => null;

    await expect(trust.promptTrustChoice("/r/p", "/r")).resolves.toBe("no");
  });

  test("US-002 AC18: asks the exact question when a parent can be trusted", async () => {
    let asked: string | undefined;
    trust._trustPromptDeps.ask = async (question) => {
      asked = question;
      return "no";
    };

    await trust.promptTrustChoice("/r/p", "/r");

    expect(asked).toBe(
      "Trust /r/p? nax will run this project's plugins, hooks, MCP servers and test commands. [y]es / [p]arent (/r) / [N]o ",
    );
  });

  test("US-002 AC19: refuses the parent choice when no parent was offered", async () => {
    trust._trustPromptDeps.ask = async () => "p";

    await expect(trust.promptTrustChoice("/r/p", null)).resolves.toBe("no");
  });

  test("US-002 AC20: asks the exact question without a parent choice", async () => {
    let asked: string | undefined;
    trust._trustPromptDeps.ask = async (question) => {
      asked = question;
      return "no";
    };

    await trust.promptTrustChoice("/home/u/p", null);

    expect(asked).toBe(
      "Trust /home/u/p? nax will run this project's plugins, hooks, MCP servers and test commands. [y]es / [N]o ",
    );
  });
});
