import { describe, expect, test } from "bun:test";
import * as chat from "@/chat";
import {
  ACP_CHAT_AGENTS,
  ACP_RUN_COMMAND_UNSUPPORTED,
  acpAgentLabel,
  acpEffortLevels,
  acpModelLabel,
  acpModelRows,
  isChatAcpModel,
  parseChatAcpModel,
} from "@/chat/acp/acp-model";
import { NaxError } from "@/errors";

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

function expectInvalid(model: string): void {
  const err = thrownBy(() => parseChatAcpModel(model));
  expect(err).toBeInstanceOf(NaxError);
  if (!(err instanceof NaxError)) return;
  expect(err.code).toBe("CHAT_ACP_MODEL_INVALID");
  expect(err.context?.stage).toBe("chat");
}

describe("parseChatAcpModel", () => {
  test("AC-1: a bare agent", () => {
    expect(parseChatAcpModel("acp:claude")).toEqual({ agent: "claude" });
  });

  test("AC-2: an agent and a model", () => {
    expect(parseChatAcpModel("acp:codex/gpt-5.5")).toEqual({ agent: "codex", model: "gpt-5.5" });
  });

  test("AC-3: an agent, a model and an effort", () => {
    expect(parseChatAcpModel("acp:codex/gpt-5.5[high]")).toEqual({
      agent: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
  });

  test("AC-4: an agent and an effort", () => {
    expect(parseChatAcpModel("acp:codex[high]")).toEqual({ agent: "codex", effort: "high" });
  });

  test("AC-5: a native model string is not an ACP model", () => {
    expect(parseChatAcpModel("openai/gpt-6")).toBeUndefined();
  });

  test("AC-6: another agent is refused", () => {
    expectInvalid("acp:gemini");
  });

  test("AC-7: an empty model after the slash is refused", () => {
    expectInvalid("acp:claude/");
  });

  test("AC-8: a model with a stray bracket is refused", () => {
    expectInvalid("acp:claude/x]y");
  });

  test("AC-22: the empty namespace is refused with stage chat", () => {
    expectInvalid("acp:");
  });

  test.each([
    ["an opening bracket", "acp:codex/gpt[5"],
    ["a bracket left after the effort suffix", "acp:codex/a[b][high]"],
    ["an empty effort group", "acp:codex/gpt-5.5[]"],
    ["a bracket inside the agent part", "acp:codex[high]/x"],
  ])("AC-23: %s is refused", (_name, model) => {
    expectInvalid(model);
  });

  test("lists exactly the chat agents", () => {
    expect(ACP_CHAT_AGENTS).toEqual(["claude", "codex", "cursor"]);
  });
});

describe("isChatAcpModel", () => {
  test("AC-9: recognises the acp: namespace only", () => {
    expect(isChatAcpModel("acp:cursor")).toBe(true);
    expect(isChatAcpModel("anthropic/claude-sonnet-4-5")).toBe(false);
  });
});

describe("acpAgentLabel", () => {
  test.each([
    ["AC-10a", "codex", "Codex"],
    ["AC-10b", "cursor", "Cursor"],
    ["claude", "claude", "Claude Code"],
  ] as const)("%s: %s", (_ac, agent, label) => {
    expect(acpAgentLabel(agent)).toBe(label);
  });
});

describe("acpModelLabel", () => {
  test.each([
    ["AC-11", "acp:claude", "Claude Code"],
    ["AC-12", "acp:codex/gpt-5.5[high]", "Codex · gpt-5.5[high]"],
    ["AC-13", "acp:codex[high]", "Codex[high]"],
    ["model without effort", "acp:codex/gpt-5.5", "Codex · gpt-5.5"],
    ["AC-14 unknown agent", "acp:gemini", "acp:gemini"],
    ["malformed model", "acp:claude/x]y", "acp:claude/x]y"],
    ["empty namespace", "acp:", "acp:"],
    ["native string", "openai/gpt-6", "openai/gpt-6"],
  ])("%s: %s", (_ac, model, label) => {
    expect(acpModelLabel(model)).toBe(label);
  });

  test("AC-21: is reachable from @/chat", () => {
    expect(chat.acpModelLabel("acp:cursor")).toBe("Cursor");
    expect(chat.acpAgentLabel("codex")).toBe("Codex");
    expect(chat.isChatAcpModel("acp:claude")).toBe(true);
    expect(chat.parseChatAcpModel("acp:claude")).toEqual({ agent: "claude" });
    expect(chat.ACP_RUN_COMMAND_UNSUPPORTED).toBe(ACP_RUN_COMMAND_UNSUPPORTED);
  });
});

describe("acpModelRows", () => {
  test("AC-15: codex ids are listed as offered", () => {
    expect(acpModelRows("codex", ["gpt-5.5", "gpt-5.4"])).toEqual(["acp:codex/gpt-5.5", "acp:codex/gpt-5.4"]);
  });

  test("AC-16: claude ids with brackets are not listed", () => {
    expect(acpModelRows("claude", ["sonnet", "sonnet[1m]", "opus"])).toEqual(["acp:claude/sonnet", "acp:claude/opus"]);
  });

  test("AC-17: cursor ids lose one trailing group and duplicates collapse", () => {
    expect(acpModelRows("cursor", ["default[]", "sonnet-4.5[thinking=true]", "auto", "auto"])).toEqual([
      "acp:cursor/default",
      "acp:cursor/sonnet-4.5",
      "acp:cursor/auto",
    ]);
  });

  test("AC-18: a cursor bare name shared by two ids is not listed", () => {
    expect(acpModelRows("cursor", ["gpt-5.5[reasoning=low]", "gpt-5.5[reasoning=high]", "auto"])).toEqual([
      "acp:cursor/auto",
    ]);
  });

  test("a duplicated cursor id with settings stays listed once", () => {
    expect(acpModelRows("cursor", ["gpt-5.5[a=1]", "gpt-5.5[a=1]"])).toEqual(["acp:cursor/gpt-5.5"]);
  });

  test("a cursor id whose reduced name still has a bracket is not listed", () => {
    expect(acpModelRows("cursor", ["a[b]c[d]", "x"])).toEqual(["acp:cursor/x"]);
  });

  test("an empty or fully bracketed cursor id is not listed", () => {
    expect(acpModelRows("cursor", ["[x=1]", "", "ok"])).toEqual(["acp:cursor/ok"]);
  });

  test("an empty claude id is not listed and duplicates collapse", () => {
    expect(acpModelRows("claude", ["", "opus", "opus"])).toEqual(["acp:claude/opus"]);
  });

  test("every listed row parses", () => {
    for (const row of acpModelRows("cursor", ["default[]", "auto"])) {
      expect(parseChatAcpModel(row)?.agent).toBe("cursor");
    }
  });
});

describe("acpEffortLevels", () => {
  test("AC-19: drops unknown values and keeps canonical order", () => {
    expect(acpEffortLevels(["low", "high", "turbo"])).toEqual(["default", "low", "high"]);
  });

  test("canonical order wins over offer order", () => {
    expect(acpEffortLevels(["high", "low"])).toEqual(["default", "low", "high"]);
  });

  test("AC-20: nothing offered leaves the default", () => {
    expect(acpEffortLevels([])).toEqual(["default"]);
  });
});

describe("ACP_RUN_COMMAND_UNSUPPORTED", () => {
  test("names the limitation", () => {
    expect(ACP_RUN_COMMAND_UNSUPPORTED).toBe(
      "! commands run on nax's own models only; the agent runs commands with its own tools",
    );
  });
});
