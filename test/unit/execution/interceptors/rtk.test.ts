import { describe, expect, test } from "bun:test";
import type { InterceptorState } from "@/execution/interceptors/rtk";
import { createRtkInterceptor } from "@/execution/interceptors/rtk";
import type { LogEntry } from "@/logger";
import { addSink, initLogger, resetLogger } from "@/logger";

const req = (verb: string) => ({
  kind: "argv" as const,
  argv: ["git", verb, "--oneline"],
  cwd: "/repo",
  site: "git" as const,
});
const present = { which: () => "/usr/bin/rtk", version: () => "0.45.0", record: () => {} };
const make = (o: Partial<Parameters<typeof createRtkInterceptor>[0]> = {}) =>
  createRtkInterceptor({ enabled: true, verbs: ["log"], _deps: present, ...o });

describe("rtk interceptor", () => {
  test("rewrites a verb in the configured list", async () => {
    expect(await make().intercept(req("log"))).toEqual({
      kind: "rewritten",
      argv: ["rtk", "git", "log", "--oneline"],
      provider: "rtk",
    });
  });

  test("leaves a verb outside the list unchanged", async () => {
    expect((await make().intercept(req("diff"))).kind).toBe("unchanged");
  });

  test("an empty verb list intercepts nothing", async () => {
    expect((await make({ verbs: [] }).intercept(req("log"))).kind).toBe("unchanged");
  });

  test("never probes the binary when disabled", async () => {
    let probed = false;
    const i = make({
      enabled: false,
      _deps: {
        ...present,
        which: () => {
          probed = true;
          return "/usr/bin/rtk";
        },
      },
    });
    expect((await i.intercept(req("log"))).kind).toBe("unchanged");
    expect(probed).toBe(false);
  });

  test("records the real version at construction when enabled", () => {
    const states: InterceptorState[] = [];
    make({ _deps: { ...present, record: (s) => states.push(s) } });
    expect(states).toEqual([{ enabled: true, version: "0.45.0", verbs: ["log"] }]);
  });

  test("still records, with a null version, when disabled", () => {
    const states: InterceptorState[] = [];
    make({ enabled: false, _deps: { ...present, record: (s) => states.push(s) } });
    expect(states).toEqual([{ enabled: false, version: null, verbs: ["log"] }]);
  });

  test("a missing binary declines forever and is probed exactly once", async () => {
    let probes = 0;
    const i = make({
      _deps: {
        ...present,
        which: () => {
          probes += 1;
          return null;
        },
      },
    });
    expect((await i.intercept(req("log"))).kind).toBe("declined");
    expect((await i.intercept(req("log"))).kind).toBe("declined");
    expect(probes).toBe(1);
  });

  test("construction never throws, and a throwing probe degrades to declined", async () => {
    // A throw here would take down run setup (Task 6 installs this in setupRun).
    let i: ReturnType<typeof make> | undefined;
    expect(() => {
      i = make({
        _deps: {
          ...present,
          which: () => {
            throw new Error("boom");
          },
        },
      });
    }).not.toThrow();
    expect((await i?.intercept(req("log")))?.kind).toBe("declined");
  });

  test("construction never throws when the version probe is the thing that fails", async () => {
    let i: ReturnType<typeof make> | undefined;
    expect(() => {
      i = make({
        _deps: {
          ...present,
          version: () => {
            throw new Error("boom");
          },
        },
      });
    }).not.toThrow();
    expect((await i?.intercept(req("log")))?.kind).toBe("declined");
  });

  test("partial deps fall back to the real which probe without throwing", async () => {
    // rtk may or may not be installed; either way construction probes without
    // throwing and records once, and interception settles on a valid outcome.
    const states: InterceptorState[] = [];
    const i = createRtkInterceptor({
      enabled: true,
      verbs: ["log"],
      _deps: { record: (s) => states.push(s) },
    });
    expect(states).toHaveLength(1);
    expect(states[0].enabled).toBe(true);
    const result = await i.intercept(req("log"));
    expect(["rewritten", "declined"]).toContain(result.kind);
  });

  test("partial deps fall back to the real version probe without throwing", async () => {
    // `rtk --version` resolves on a machine with rtk installed (rewritten) and
    // throws ENOENT where rtk is absent (degraded to declined by construction).
    // Either outcome is valid; what matters is that construction did not throw.
    const states: InterceptorState[] = [];
    const i = createRtkInterceptor({
      enabled: true,
      verbs: ["log"],
      _deps: {
        which: () => "/usr/bin/rtk",
        record: (s) => states.push(s),
      },
    });
    expect(states).toHaveLength(1);
    expect(states[0].enabled).toBe(true);
    const result = await i.intercept(req("log"));
    expect(["rewritten", "declined"]).toContain(result.kind);
  });

  test("the default record writes one structured info line via the logger", () => {
    resetLogger();
    initLogger({ level: "silent" });
    const entries: LogEntry[] = [];
    addSink((entry) => entries.push(entry));
    try {
      createRtkInterceptor({
        enabled: true,
        verbs: ["log"],
        _deps: { which: () => "/usr/bin/rtk", version: () => "0.45.0" },
      });
    } finally {
      resetLogger();
    }
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("info");
    expect(entries[0].stage).toBe("execution");
    expect(entries[0].data).toEqual({ enabled: true, version: "0.45.0", verbs: ["log"] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// postProcess — strip rtk's appended hints from a tool result
// ─────────────────────────────────────────────────────────────────────────────

const postProcessReq = { kind: "argv" as const, argv: ["git", "log"], cwd: "/repo", site: "git" as const };

/** Narrows `postProcess?` once, so no test needs a non-null assertion. */
function postProcess() {
  const { postProcess: fn } = createRtkInterceptor({
    enabled: true,
    verbs: ["log"],
    _deps: present,
  });
  if (fn === undefined) throw new Error("rtk interceptor must define postProcess");
  return fn;
}

describe("rtk postProcess", () => {
  test("strips a full-diff hint and the newline before it", () => {
    expect(postProcess()("diff body\n[full diff: rtk git diff --no-compact]", postProcessReq).output).toBe("diff body");
  });

  test("strips a hidden-lines hint", () => {
    const { output } = postProcess()("body\n[+12 hidden: rtk recall 3f9c2a81d4e7]", postProcessReq);
    expect(output).toBe("body");
    expect(output).not.toContain("rtk recall");
  });

  test("strips a full-output hint", () => {
    // US-005 item 1 names `[full output: rtk recall <hash>]` as the third hint
    // shape rtk appends — the acceptance is "no rtk hint string survives into
    // a tool result".
    expect(postProcess()("body\n[full output: rtk recall 3f9c2a81d4e7]", postProcessReq).output).toBe("body");
  });

  test("leaves output with no hints untouched", () => {
    expect(postProcess()("plain body", postProcessReq).output).toBe("plain body");
  });

  test("does not eat trailing whitespace when there is no hint to strip", () => {
    // Stripping is hint-shaped, not a general trim: trimEnd happens later at
    // the call site, and postProcess must not pre-empt it.
    expect(postProcess()("plain body\n\n", postProcessReq).output).toBe("plain body\n\n");
  });
});
