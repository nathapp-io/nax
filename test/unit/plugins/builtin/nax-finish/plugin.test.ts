import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _naxFinishDeps, isTelegramConfigured, naxFinishPlugin, telegramCreds } from "@/plugins";
import type { PostRunContext } from "@/plugins/types";

const action = naxFinishPlugin.extensions.postRunAction!;

// _naxFinishDeps is module-level state shared across every test file in this
// process — restore it after each test so a stub cannot leak sideways.
const origDeps = { ...(_naxFinishDeps as Record<string, unknown>) };
afterEach(() => {
  Object.assign(_naxFinishDeps, origDeps);
});
const baseCtx = (over: Partial<PostRunContext> = {}): PostRunContext =>
  ({
    runId: "r",
    feature: "x",
    workdir: "/repo",
    prdPath: "/repo/.nax/features/x/prd.json",
    branch: "feat/x",
    totalDurationMs: 1,
    totalCost: 0,
    storySummary: { completed: 2, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    config: { finish: { autoFlow: { enabled: true } } },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    ...over,
  }) as unknown as PostRunContext;

describe("nax-finish post-run action", () => {
  test("shouldRun=false when disabled", async () => {
    expect(await action.shouldRun(baseCtx({ config: { finish: { autoFlow: { enabled: false } } } } as never))).toBe(
      false,
    );
  });

  test("shouldRun=false on main branch", async () => {
    expect(await action.shouldRun(baseCtx({ branch: "main" }))).toBe(false);
  });

  test("shouldRun=false when a story failed", async () => {
    expect(await action.shouldRun(baseCtx({ storySummary: { completed: 1, failed: 1, skipped: 0, paused: 0 } }))).toBe(
      false,
    );
  });

  test("shouldRun=true when enabled + clean + feature branch", async () => {
    expect(await action.shouldRun(baseCtx())).toBe(true);
  });

  test("execute shells acpx flow run and maps the escalated result", async () => {
    const calls: string[][] = [];
    _naxFinishDeps.run = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    _naxFinishDeps.readResult = async () => ({ feature: "x", status: "escalated", escalationReason: "design call" });
    // Without this stub an escalated status reaches the real Bot API whenever the
    // developer running the suite has Telegram env vars exported.
    _naxFinishDeps.notify = async () => true;
    const r = await action.execute(baseCtx());
    expect(calls[0].join(" ")).toContain("acpx");
    expect(calls[0].join(" ")).toContain("flow run");
    expect(calls[0].join(" ")).toContain("--input-json");
    expect(r.success).toBe(true);
    expect(r.message).toContain("escalated");
  });

  describe("escalation notification", () => {
    const CONFIG_WITH_TELEGRAM = {
      finish: { autoFlow: { enabled: true } },
      interaction: { plugin: "telegram", config: { botToken: "t", chatId: "c" } },
    };

    function stubRun(result: { feature: string; status: string; escalationReason?: string }) {
      const sent: Array<{ creds: { token: string; chatId: string }; text: string }> = [];
      _naxFinishDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
      _naxFinishDeps.readResult = async () => result as never;
      _naxFinishDeps.notify = async (creds, text) => {
        sent.push({ creds, text });
        return true;
      };
      return sent;
    }

    test("notifies with the feature and escalation reason when the flow escalates", async () => {
      const sent = stubRun({ feature: "x", status: "escalated", escalationReason: "design call" });

      await action.execute(baseCtx({ config: CONFIG_WITH_TELEGRAM } as never));

      expect(sent).toHaveLength(1);
      expect(sent[0].text).toBe("nax-finish escalated *x*: design call");
      expect(sent[0].creds).toEqual({ token: "t", chatId: "c" });
    });

    test("does not notify for a non-escalated status", async () => {
      const sent = stubRun({ feature: "x", status: "opened" });

      await action.execute(baseCtx({ config: CONFIG_WITH_TELEGRAM } as never));

      expect(sent).toHaveLength(0);
    });

    test("does not notify when escalate.telegram is disabled", async () => {
      const sent = stubRun({ feature: "x", status: "escalated", escalationReason: "design call" });
      const config = {
        finish: { autoFlow: { enabled: true, escalate: { telegram: false } } },
        interaction: CONFIG_WITH_TELEGRAM.interaction,
      };

      await action.execute(baseCtx({ config } as never));

      expect(sent).toHaveLength(0);
    });

    test("does not notify when no credentials resolve", async () => {
      const sent = stubRun({ feature: "x", status: "escalated", escalationReason: "design call" });

      await action.execute(baseCtx());

      expect(sent).toHaveLength(0);
    });
  });

  test("execute sets reviewer profile env vars from config.finish.autoFlow.reviewers", async () => {
    let capturedEnv: Record<string, string> | undefined;
    _naxFinishDeps.run = async (_cmd, opts) => {
      capturedEnv = opts.env;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    _naxFinishDeps.readResult = async () => ({ feature: "x", status: "opened" });

    await action.execute(
      baseCtx({
        config: {
          finish: {
            autoFlow: {
              enabled: true,
              reviewers: { spec: "spec-profile", quality: "quality-profile" },
            },
          },
        },
      }),
    );

    expect(capturedEnv?.NAX_FINISH_SPEC_PROFILE).toBe("spec-profile");
    expect(capturedEnv?.NAX_FINISH_QUALITY_PROFILE).toBe("quality-profile");
  });

  test("execute omits reviewer profile env vars when reviewers are null", async () => {
    let capturedEnv: Record<string, string> | undefined;
    _naxFinishDeps.run = async (_cmd, opts) => {
      capturedEnv = opts.env;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    _naxFinishDeps.readResult = async () => ({ feature: "x", status: "opened" });

    await action.execute(baseCtx());

    expect(capturedEnv?.NAX_FINISH_SPEC_PROFILE).toBeUndefined();
    expect(capturedEnv?.NAX_FINISH_QUALITY_PROFILE).toBeUndefined();
  });
});

describe("telegramCreds / isTelegramConfigured", () => {
  let savedToken: string | undefined;
  let savedChatId: string | undefined;
  let savedBotToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.NAX_TELEGRAM_TOKEN;
    savedChatId = process.env.NAX_TELEGRAM_CHAT_ID;
    savedBotToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.NAX_TELEGRAM_TOKEN;
    delete process.env.NAX_TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken !== undefined) process.env.NAX_TELEGRAM_TOKEN = savedToken;
    else delete process.env.NAX_TELEGRAM_TOKEN;
    if (savedChatId !== undefined) process.env.NAX_TELEGRAM_CHAT_ID = savedChatId;
    else delete process.env.NAX_TELEGRAM_CHAT_ID;
    if (savedBotToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = savedBotToken;
    else delete process.env.TELEGRAM_BOT_TOKEN;
  });

  test("returns token+chatId when interaction.plugin is telegram with config", () => {
    const config = { interaction: { plugin: "telegram", config: { botToken: "t", chatId: "c" } } };
    expect(telegramCreds(config)).toEqual({ token: "t", chatId: "c" });
    expect(isTelegramConfigured(config)).toBe(true);
  });

  test("returns null when active interaction plugin is not telegram", () => {
    const config = { interaction: { plugin: "cli" } };
    expect(telegramCreds(config)).toBeNull();
    expect(isTelegramConfigured(config)).toBe(false);
  });

  test("returns null when there is no interaction config at all", () => {
    const config = {};
    expect(telegramCreds(config)).toBeNull();
    expect(isTelegramConfigured(config)).toBe(false);
  });
});
