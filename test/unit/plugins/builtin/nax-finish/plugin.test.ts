import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _naxFinishDeps,
  buildFlowArgv,
  finishAuditDir,
  finishResultPath,
  isTelegramConfigured,
  naxFinishPlugin,
  resolveFlowPath,
  telegramCreds,
} from "@/plugins";
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

describe("finish-audit location", () => {
  // The artifact records a run, not the source tree, so it belongs beside
  // prompt-audit/ and review-audit/ under the project's output dir — not in the
  // user's repo, where it was neither committable nor gitignorable.
  test("resolves under <outputDir>/finish-audit/<feature>, like prompt-audit and review-audit", () => {
    const ctx = baseCtx({ outputDir: "/home/u/.nax/proj" });
    expect(finishAuditDir(ctx)).toBe("/home/u/.nax/proj/finish-audit/x");
  });

  test("names the result file by run id, so two finishes of one feature do not collide", () => {
    const ctx = baseCtx({ outputDir: "/home/u/.nax/proj" });
    expect(finishResultPath(ctx, "run-a")).toBe("/home/u/.nax/proj/finish-audit/x/run-a.result.json");
    expect(finishResultPath(ctx, "run-b")).not.toBe(finishResultPath(ctx, "run-a"));
  });

  // outputDir is optional on PostRunContext for backward compatibility; the
  // flow applies the same repo-local fallback, so both sides agree on the path.
  test("falls back to the repo when the context carries no outputDir", () => {
    expect(finishAuditDir(baseCtx())).toBe("/repo/.nax/finish-audit/x");
  });

  test("passes the resolved audit dir and run id to the flow, and reads back the same path", async () => {
    let flowInput: Record<string, unknown> = {};
    let readFrom = "";
    let clearedFrom = "";
    _naxFinishDeps.run = async (cmd) => {
      flowInput = JSON.parse(cmd[cmd.indexOf("--input-json") + 1]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    _naxFinishDeps.clearResult = async (p) => {
      clearedFrom = p;
    };
    _naxFinishDeps.readResult = async (p) => {
      readFrom = p;
      return { feature: "x", status: "opened" };
    };
    _naxFinishDeps.exists = async () => true;
    const ctx = baseCtx({ outputDir: "/home/u/.nax/proj", runId: "run-42" });
    await action.execute(ctx);

    expect(flowInput.auditDir).toBe("/home/u/.nax/proj/finish-audit/x");
    expect(flowInput.runId).toBe("run-42");
    // The plugin must read back exactly where it told the flow to write.
    expect(readFrom).toBe("/home/u/.nax/proj/finish-audit/x/run-42.result.json");
    expect(clearedFrom).toBe(readFrom);
  });
});

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

  describe("no result file", () => {
    // PluginLogger is (message, data) — not the 3-arg src/logger API that
    // test/helpers' makeLogger() mocks — so the capture is local by necessity.
    const captureCtx = (): { ctx: PostRunContext; warns: { message: string; data?: Record<string, unknown> }[] } => {
      const warns: { message: string; data?: Record<string, unknown> }[] = [];
      const ctx = baseCtx({
        logger: {
          debug() {},
          info() {},
          warn: (message: string, data?: Record<string, unknown>) => {
            warns.push({ message, data });
          },
          error() {},
        },
      } as never);
      return { ctx, warns };
    };

    test("surfaces the flow's stderr in the failure message", async () => {
      _naxFinishDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "Bun is not defined\n" });
      _naxFinishDeps.readResult = async () => null;
      const { ctx } = captureCtx();
      const r = await action.execute(ctx);
      expect(r.success).toBe(false);
      expect(r.message).toContain("exited 1");
      expect(r.message).toContain("Bun is not defined");
    });

    test("notifies a failure in always mode before returning", async () => {
      const sent: string[] = [];
      _naxFinishDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "flow crashed" });
      _naxFinishDeps.readResult = async () => null;
      _naxFinishDeps.notify = async (_creds, message) => {
        sent.push(message);
        return true;
      };
      const config = {
        finish: { autoFlow: { enabled: true, notify: { mode: "always" } } },
        interaction: { plugin: "telegram", config: { botToken: "t", chatId: "c" } },
      };

      const result = await action.execute(baseCtx({ config } as never));

      expect(result.success).toBe(false);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("flow crashed");
    });

    test("logs the flow's full stdout and stderr", async () => {
      _naxFinishDeps.run = async () => ({ exitCode: 1, stdout: "step one\n", stderr: "boom\n" });
      _naxFinishDeps.readResult = async () => null;
      const { ctx, warns } = captureCtx();
      await action.execute(ctx);
      expect(warns).toHaveLength(1);
      expect(warns[0].data).toMatchObject({ exitCode: 1, stdout: "step one\n", stderr: "boom\n" });
    });

    test("truncates a long stderr hard in the message, loosely in the log", async () => {
      const long = `${"x".repeat(5000)}TAIL`;
      _naxFinishDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: long });
      _naxFinishDeps.readResult = async () => null;
      const { ctx, warns } = captureCtx();
      const r = await action.execute(ctx);
      expect(r.message).toContain("TAIL");
      expect(r.message.length).toBeLessThan(600);
      // Well under the log cap, so the log keeps it whole.
      expect(warns[0].data?.stderr).toBe(long);
    });

    test("caps a huge stream in the log and says how much was dropped", async () => {
      // acpx echoes every node's output on a full run; without a cap this lands
      // in the JSONL log as one multi-megabyte line.
      const huge = `HEAD${"y".repeat(50_000)}TAIL`;
      _naxFinishDeps.run = async () => ({ exitCode: 1, stdout: huge, stderr: "" });
      _naxFinishDeps.readResult = async () => null;
      const { ctx, warns } = captureCtx();
      await action.execute(ctx);
      const logged = warns[0].data?.stdout as string;
      expect(logged.length).toBeLessThan(21_000);
      expect(logged).toContain("chars truncated");
      expect(logged.endsWith("TAIL")).toBe(true);
      expect(logged).not.toContain("HEAD");
    });

    test("omits the separator when the flow wrote nothing to stderr", async () => {
      _naxFinishDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "   \n" });
      _naxFinishDeps.readResult = async () => null;
      const { ctx } = captureCtx();
      const r = await action.execute(ctx);
      expect(r.message).toBe("nax-finish flow exited 1 (no result file)");
    });

    test("reports failure even when the flow exited 0", async () => {
      // Both terminal nodes write the result file on every branch, so its
      // absence means the graph never reached one — exit 0 makes that worse,
      // not better. Reporting success logged the anomaly at info level.
      _naxFinishDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
      _naxFinishDeps.readResult = async () => null;
      const { ctx } = captureCtx();
      const r = await action.execute(ctx);
      expect(r.success).toBe(false);
      expect(r.message).toContain("exited 0 (no result file)");
    });
  });

  describe("escalation notification", () => {
    const CONFIG_WITH_TELEGRAM = {
      finish: { autoFlow: { enabled: true } },
      interaction: { plugin: "telegram", config: { botToken: "t", chatId: "c" } },
    };

    function stubRun(result: {
      feature: string;
      status: string;
      escalationReason?: string;
      findings?: { severity: string; title: string; problem: string; fix: string }[];
    }) {
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
      expect(sent[0].text).toBe("nax-finish escalated x: design call");
      expect(sent[0].creds).toEqual({ token: "t", chatId: "c" });
    });

    // Regression: the message carried only the reason ("3 finding(s) after 3 fix
    // attempts"), so the human had to dig through the acpx run bundle to learn
    // what the findings actually were (issue #1398).
    test("names each finding in the message, not just the count", async () => {
      const sent = stubRun({
        feature: "x",
        status: "escalated",
        escalationReason: "spec review still reporting 2 finding(s)",
        findings: [
          { severity: "HIGH", title: "holidays ignores timezone", problem: "no query param", fix: "add it" },
          { severity: "MEDIUM", title: "routes untyped", problem: "dict[str, Any]", fix: "add response_model" },
        ],
      });

      await action.execute(baseCtx({ config: CONFIG_WITH_TELEGRAM } as never));

      expect(sent[0].text).toContain("spec review still reporting 2 finding(s)");
      expect(sent[0].text).toContain("[HIGH] holidays ignores timezone");
      expect(sent[0].text).toContain("[MEDIUM] routes untyped");
    });

    test("caps the message so a long finding list cannot exceed Telegram's limit", async () => {
      const sent = stubRun({
        feature: "x",
        status: "escalated",
        escalationReason: "many findings",
        findings: Array.from({ length: 40 }, (_, n) => ({
          severity: "HIGH",
          title: `finding ${n} ${"x".repeat(300)}`,
          problem: "p",
          fix: "f",
        })),
      });

      await action.execute(baseCtx({ config: CONFIG_WITH_TELEGRAM } as never));

      expect(sent[0].text.length).toBeLessThanOrEqual(4096);
      expect(sent[0].text).toContain("more");
    });

    // Sent as plain text: under parse_mode Markdown these characters either 400
    // the whole message or, if stripped, rewrite `_calendar.py` to a filename
    // that isn't the one under discussion.
    test("delivers filenames and punctuation in a finding title verbatim", async () => {
      const sent = stubRun({
        feature: "x",
        status: "escalated",
        escalationReason: "r",
        findings: [{ severity: "HIGH", title: "`_calendar.py` ignores *timezone*", problem: "p", fix: "f" }],
      });

      await action.execute(baseCtx({ config: CONFIG_WITH_TELEGRAM } as never));

      expect(sent[0].text).toContain("`_calendar.py` ignores *timezone*");
    });

    test("still sends a reason-only message when the flow reported no findings", async () => {
      const sent = stubRun({ feature: "x", status: "escalated", escalationReason: "gates still failing (lint)" });

      await action.execute(baseCtx({ config: CONFIG_WITH_TELEGRAM } as never));

      expect(sent[0].text).toBe("nax-finish escalated x: gates still failing (lint)");
    });

    test("reports a rejected Telegram send instead of claiming the escalation landed", async () => {
      _naxFinishDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
      _naxFinishDeps.readResult = async () =>
        ({ feature: "x", status: "escalated", escalationReason: "design call" }) as never;
      _naxFinishDeps.notify = async () => false;

      const r = await action.execute(baseCtx({ config: CONFIG_WITH_TELEGRAM } as never));

      expect(r.success).toBe(false);
      expect(r.message).toContain("Telegram");
    });

    // The flow's deliveryError on the Telegram path means only that its URL
    // lookup failed — the comment is deliberately not posted there. Reporting
    // that as undelivered false-alarms on the path that actually worked.
    test("does not report undelivered when Telegram carried it despite a flow-side failure", async () => {
      _naxFinishDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
      _naxFinishDeps.readResult = async () =>
        ({
          feature: "x",
          status: "escalated",
          escalationReason: "design call",
          deliveryError: "Unable to determine forge",
        }) as never;
      _naxFinishDeps.notify = async () => true;

      const r = await action.execute(baseCtx({ config: CONFIG_WITH_TELEGRAM } as never));

      expect(r.success).toBe(true);
      expect(r.message).toBe("nax-finish: escalated");
    });

    test("reports an undelivered escalation the flow already flagged", async () => {
      _naxFinishDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
      _naxFinishDeps.readResult = async () =>
        ({
          feature: "x",
          status: "escalated",
          escalationReason: "design call",
          deliveryError: "rate limit exceeded",
        }) as never;
      _naxFinishDeps.notify = async () => true;

      const r = await action.execute(baseCtx());

      expect(r.success).toBe(false);
      expect(r.message).toContain("rate limit exceeded");
    });

    test("does not notify for a non-escalated status", async () => {
      const sent = stubRun({ feature: "x", status: "opened" });

      await action.execute(baseCtx({ config: CONFIG_WITH_TELEGRAM } as never));

      expect(sent).toHaveLength(0);
    });

    test("notifies successful terminal results in always mode", async () => {
      const sent = stubRun({ feature: "x", status: "opened" });
      const config = {
        finish: { autoFlow: { enabled: true, notify: { mode: "always" } } },
        interaction: CONFIG_WITH_TELEGRAM.interaction,
      };

      const result = await action.execute(baseCtx({ config } as never));

      expect(result.success).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain("nax-finish opened x");
    });

    test("ordinary notification rejection or exception does not change a successful result", async () => {
      const config = {
        finish: { autoFlow: { enabled: true, notify: { mode: "always" } } },
        interaction: CONFIG_WITH_TELEGRAM.interaction,
      };
      _naxFinishDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
      _naxFinishDeps.readResult = async () => ({ feature: "x", status: "opened" });
      _naxFinishDeps.notify = async () => false;
      expect((await action.execute(baseCtx({ config } as never))).success).toBe(true);
      _naxFinishDeps.notify = async () => {
        throw new Error("network down");
      };
      expect((await action.execute(baseCtx({ config } as never))).success).toBe(true);
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

  test("clears any stale result before starting the flow", async () => {
    const order: string[] = [];
    _naxFinishDeps.clearResult = async () => {
      order.push("clear");
    };
    _naxFinishDeps.run = async () => {
      order.push("run");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    _naxFinishDeps.readResult = async () => ({ feature: "x", status: "opened" });

    await action.execute(baseCtx());

    expect(order).toEqual(["clear", "run"]);
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

  test("execute forwards the narrative profile and leaves NAX_FINISH_NARRATIVE unset when enabled", async () => {
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
            autoFlow: { enabled: true, narrative: true, reviewers: { narrative: "narrator" } },
          },
        },
      }),
    );

    expect(capturedEnv?.NAX_FINISH_NARRATIVE_PROFILE).toBe("narrator");
    // Only the disabled case is signalled, so an unset var still means enabled.
    expect(capturedEnv?.NAX_FINISH_NARRATIVE).toBeUndefined();
  });

  test("execute sets NAX_FINISH_NARRATIVE=0 when the narrative is disabled", async () => {
    let capturedEnv: Record<string, string> | undefined;
    _naxFinishDeps.run = async (_cmd, opts) => {
      capturedEnv = opts.env;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    _naxFinishDeps.readResult = async () => ({ feature: "x", status: "opened" });

    await action.execute(
      baseCtx({ config: { finish: { autoFlow: { enabled: true, narrative: false } } } }),
    );

    expect(capturedEnv?.NAX_FINISH_NARRATIVE).toBe("0");
  });

  test("execute forwards the acceptance/gate budgets in the flow input and caps the flow itself", async () => {
    let capturedCmd: string[] = [];
    let capturedTimeout: number | undefined;
    _naxFinishDeps.run = async (cmd, opts) => {
      capturedCmd = cmd;
      capturedTimeout = opts.timeoutMs;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    _naxFinishDeps.readResult = async () => ({ feature: "x", status: "opened" });

    await action.execute(
      baseCtx({
        config: {
          finish: {
            autoFlow: { enabled: true, timeouts: { acceptanceMs: 111, gateMs: 222, flowMs: 333 } },
          },
        },
      } as never),
    );

    expect(capturedTimeout).toBe(333);
    const input = JSON.parse(capturedCmd[capturedCmd.indexOf("--input-json") + 1]);
    expect(input.timeouts).toEqual({ acceptanceMs: 111, gateMs: 222 });
  });

  test("execute tells the flow to prefer Telegram only when it is enabled AND credentialed", async () => {
    const inputsFor = async (config: Record<string, unknown>) => {
      let cmd: string[] = [];
      _naxFinishDeps.run = async (c) => {
        cmd = c;
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      _naxFinishDeps.readResult = async () => ({ feature: "x", status: "opened" });
      await action.execute(baseCtx({ config } as never));
      return JSON.parse(cmd[cmd.indexOf("--input-json") + 1]);
    };

    const credentialed = await inputsFor({
      finish: { autoFlow: { enabled: true } },
      interaction: { plugin: "telegram", config: { botToken: "t", chatId: "c" } },
    });
    expect(credentialed.escalateTelegram).toBe(true);

    // Enabled but with no credentials → the flow must fall back to a PR comment.
    const uncredentialed = await inputsFor({ finish: { autoFlow: { enabled: true } }, interaction: { plugin: "cli" } });
    expect(uncredentialed.escalateTelegram).toBe(false);

    const notificationsOff = await inputsFor({
      finish: { autoFlow: { enabled: true, notify: { mode: "off" } } },
      interaction: { plugin: "telegram", config: { botToken: "t", chatId: "c" } },
    });
    expect(notificationsOff.escalateTelegram).toBe(false);
  });

  test("execute reports a clear failure when the flow module cannot be found", async () => {
    let ran = false;
    _naxFinishDeps.exists = async () => false;
    _naxFinishDeps.run = async () => {
      ran = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const r = await action.execute(baseCtx());

    expect(ran).toBe(false);
    expect(r.success).toBe(false);
    expect(r.message).toContain("not found");
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

describe("buildFlowArgv", () => {
  test("puts --default-agent AFTER the flow file — acpx defines it on `flow run`, not the root", () => {
    const argv = buildFlowArgv("/pkg/flows/nax-finish/nax-finish.flow.ts", "{}", { defaultAgent: "claude" });
    expect(argv).toEqual([
      "acpx",
      "--approve-all",
      "flow",
      "run",
      "/pkg/flows/nax-finish/nax-finish.flow.ts",
      "--input-json",
      "{}",
      "--default-agent",
      "claude",
    ]);
    // Regression guard: `acpx --approve-all --default-agent x flow run …` exits
    // with "unknown option '--default-agent'".
    expect(argv.indexOf("--default-agent")).toBeGreaterThan(argv.indexOf("run"));
  });

  test("omits --default-agent entirely when unset", () => {
    expect(buildFlowArgv("/f.ts", "{}", {})).not.toContain("--default-agent");
  });

  test("puts --timeout (seconds) BEFORE `flow` — it is a top-level flag", () => {
    const argv = buildFlowArgv("/f.ts", "{}", { stepMs: 1_800_000 });
    expect(argv.slice(0, 4)).toEqual(["acpx", "--approve-all", "--timeout", "1800"]);
    expect(argv.indexOf("--timeout")).toBeLessThan(argv.indexOf("flow"));
  });

  test("omits --timeout when stepMs is unset, leaving acpx's own default", () => {
    expect(buildFlowArgv("/f.ts", "{}", { stepMs: null })).not.toContain("--timeout");
    expect(buildFlowArgv("/f.ts", "{}", {})).not.toContain("--timeout");
  });

  // acpx resolves a node's model as `node.model ?? agent.model ?? --model`, so
  // this flag is the run-wide floor: it reaches the fix_* nodes and cannot
  // override a reviewer whose agent entry pins its own model.
  test("puts --model BEFORE `flow` — it is a top-level flag, not a `flow run` option", () => {
    const argv = buildFlowArgv("/f.ts", "{}", { model: "sonnet" });
    expect(argv.slice(0, 4)).toEqual(["acpx", "--approve-all", "--model", "sonnet"]);
    expect(argv.indexOf("--model")).toBeLessThan(argv.indexOf("flow"));
  });

  test("omits --model when unset, so nothing changes for a repo that did not opt in", () => {
    expect(buildFlowArgv("/f.ts", "{}", {})).not.toContain("--model");
    expect(buildFlowArgv("/f.ts", "{}", { model: null })).not.toContain("--model");
  });

  test("--model and --timeout coexist, both ahead of `flow`", () => {
    const argv = buildFlowArgv("/f.ts", "{}", { defaultAgent: "claude", stepMs: 60_000, model: "sonnet" });
    expect(argv.indexOf("--model")).toBeLessThan(argv.indexOf("flow"));
    expect(argv.indexOf("--timeout")).toBeLessThan(argv.indexOf("flow"));
    expect(argv.indexOf("--default-agent")).toBeGreaterThan(argv.indexOf("run"));
  });
});

describe("resolveFlowPath", () => {
  const deps = (existing: string[], moduleDir: string) => ({
    moduleDir,
    exists: async (p: string) => existing.includes(p),
  });

  test("resolves a relative path against the nax install, not the user's repo", async () => {
    const resolved = await resolveFlowPath(
      "/user/repo",
      "flows/nax-finish/nax-finish.flow.ts",
      deps(["/nax/package.json", "/nax/flows/nax-finish/nax-finish.flow.ts"], "/nax/src/plugins/builtin/nax-finish"),
    );
    expect(resolved).toBe("/nax/flows/nax-finish/nax-finish.flow.ts");
  });

  test("works from a bundled dist/ layout", async () => {
    const resolved = await resolveFlowPath(
      "/user/repo",
      "flows/nax-finish/nax-finish.flow.ts",
      deps(["/nax/package.json", "/nax/flows/nax-finish/nax-finish.flow.ts"], "/nax/dist"),
    );
    expect(resolved).toBe("/nax/flows/nax-finish/nax-finish.flow.ts");
  });

  test("falls back to a repo-vendored flow when the install has none", async () => {
    const resolved = await resolveFlowPath(
      "/user/repo",
      "flows/nax-finish/nax-finish.flow.ts",
      deps(["/nax/package.json", "/user/repo/flows/nax-finish/nax-finish.flow.ts"], "/nax/dist"),
    );
    expect(resolved).toBe("/user/repo/flows/nax-finish/nax-finish.flow.ts");
  });

  test("honours an absolute override, and reports null when it is missing", async () => {
    expect(await resolveFlowPath("/user/repo", "/custom/my.flow.ts", deps(["/custom/my.flow.ts"], "/nax/dist"))).toBe(
      "/custom/my.flow.ts",
    );
    expect(await resolveFlowPath("/user/repo", "/custom/my.flow.ts", deps([], "/nax/dist"))).toBeNull();
  });

  test("returns null when the flow exists nowhere", async () => {
    expect(
      await resolveFlowPath(
        "/user/repo",
        "flows/nax-finish/nax-finish.flow.ts",
        deps(["/nax/package.json"], "/nax/dist"),
      ),
    ).toBeNull();
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

describe("model reaches the spawned acpx argv", () => {
  const spawnedArgv = async (autoFlow: Record<string, unknown>): Promise<string[]> => {
    let argv: string[] = [];
    _naxFinishDeps.run = async (cmd) => {
      argv = cmd;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    _naxFinishDeps.clearResult = async () => {};
    _naxFinishDeps.readResult = async () => ({ feature: "x", status: "opened" });
    _naxFinishDeps.exists = async () => true;
    await action.execute(baseCtx({ config: { finish: { autoFlow: { enabled: true, ...autoFlow } } } } as never));
    return argv;
  };

  test("a configured model is spawned as a top-level --model", async () => {
    const argv = await spawnedArgv({ model: "sonnet" });
    expect(argv.join(" ")).toContain("--model sonnet");
    expect(argv.indexOf("--model")).toBeLessThan(argv.indexOf("flow"));
  });

  // The default path must be byte-identical to before this feature existed —
  // an unconditional --model would override profile-pinned reviewers on an acpx
  // build that does not support a model on agent entries.
  test("no --model is spawned when the repo did not opt in", async () => {
    expect(await spawnedArgv({})).not.toContain("--model");
  });
});
