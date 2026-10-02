/**
 * US-001 — Plugins can declare loop handlers.
 *
 * The `loop-handlers` plugin extension: what `validatePlugin()` accepts and
 * rejects (AC1–AC3), and what `PluginRegistry.getLoopHandlers()` stages, in what
 * order, frozen and memoised, with per-plugin failure isolation (AC4–AC11).
 */

import { describe, expect, type Mock, test } from "bun:test";
import {
  type ExternalHandlerOf,
  LOOP_EVENTS,
  type LoopHandlerContext,
  type LoopHandlerEntry,
  type LoopHandlerSet,
} from "@nathapp/nax-agent/internal";
import { assertDefined, withWarnSpy } from "@test/helpers";
import type { Logger } from "@/logger";
import {
  type ILoopHandlerProvider,
  type LoopHandlerRegistrar,
  type NaxPlugin,
  PluginRegistry,
  validatePlugin,
} from "@/plugins";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A plugin declaring `loop-handlers` and nothing else. */
function makeLoopHandlerPlugin(name: string, register: ILoopHandlerProvider["register"]): NaxPlugin {
  return {
    name,
    version: "1.0.0",
    provides: ["loop-handlers"],
    extensions: { loopHandlers: { register } },
  };
}

/** A plugin providing an unrelated type — the set builder must skip it. */
function makeNonProvider(name: string): NaxPlugin {
  return { name, version: "1.0.0", provides: ["reporter"], extensions: { reporter: { name } } };
}

/**
 * Call the registrar with an event outside `LoopEvent`. A plugin cannot reach
 * this through the typed API — that is what AC10's registrar type buys — so the
 * call goes through `Reflect.apply` instead of a cast.
 */
function registerUnknownEvent(on: LoopHandlerRegistrar, event: string): void {
  Reflect.apply(on, undefined, [event, () => undefined]);
}

/** Every `plugins`-stage warning the spy captured, as one searchable blob. */
function pluginWarnings(spy: Mock<Logger["warn"]>): string {
  return spy.mock.calls
    .filter((call) => call[0] === "plugins")
    .map((call) => JSON.stringify(call))
    .join("\n");
}

/**
 * A handler whose identity is the observable — the tests below assert that a
 * staged entry carries the very function the plugin registered, so each fixture
 * declares its own. No parameters, so the function is assignable to
 * `ExternalHandlerOf<E>` for every event and comparable with `toBe`; AC11
 * carries the payload-and-context-typed handler.
 */

// ─────────────────────────────────────────────────────────────────────────────
// validatePlugin — the loop-handlers extension (AC1–AC3)
// ─────────────────────────────────────────────────────────────────────────────

describe("validatePlugin with loop-handlers", () => {
  test("AC1: returns the plugin when provides is ['loop-handlers'] and extensions.loopHandlers.register is a function", () => {
    const plugin = {
      name: "loop-hooks",
      version: "1.0.0",
      provides: ["loop-handlers"],
      extensions: { loopHandlers: { register: () => {} } },
    };

    const result = validatePlugin(plugin);

    expect(result?.name).toBe("loop-hooks");
    expect(result?.provides).toEqual(["loop-handlers"]);
  });

  test("AC1: validates loop-handlers when the plugin also provides another type", () => {
    const plugin = {
      name: "reporter-with-hooks",
      version: "1.0.0",
      provides: ["reporter", "loop-handlers"],
      extensions: { reporter: { name: "noop-reporter" }, loopHandlers: { register: () => {} } },
    };

    expect(validatePlugin(plugin)?.name).toBe("reporter-with-hooks");
  });

  const absentLoopHandlers: Array<[string, unknown]> = [
    ["loopHandlers absent", {}],
    ["loopHandlers explicitly undefined", { loopHandlers: undefined }],
  ];

  test.each(absentLoopHandlers)(
    "AC2: returns null and logs a plugins warning when extensions.loopHandlers is %s",
    async (_label, extensions) => {
      await withWarnSpy(async (warnSpy) => {
        const plugin = { name: "no-hooks-plugin", version: "1.0.0", provides: ["loop-handlers"], extensions };

        expect(validatePlugin(plugin)).toBeNull();
        expect(pluginWarnings(warnSpy)).toContain("no-hooks-plugin");
      });
    },
  );

  const invalidRegister: Array<[string, unknown]> = [
    ["register absent", {}],
    ["register not a function", { register: "not-a-function" }],
    ["register null", { register: null }],
  ];

  test.each(invalidRegister)(
    "AC3: returns null and logs a plugins warning when extensions.loopHandlers.register is %s",
    async (_label, loopHandlers) => {
      await withWarnSpy(async (warnSpy) => {
        const plugin = {
          name: "bad-hooks-plugin",
          version: "1.0.0",
          provides: ["loop-handlers"],
          extensions: { loopHandlers },
        };

        expect(validatePlugin(plugin)).toBeNull();
        expect(pluginWarnings(warnSpy)).toContain("bad-hooks-plugin");
      });
    },
  );

  test("AC2: rejects a non-object loopHandlers extension", async () => {
    await withWarnSpy(async (warnSpy) => {
      const plugin = {
        name: "string-hooks-plugin",
        version: "1.0.0",
        provides: ["loop-handlers"],
        extensions: { loopHandlers: "register everything" },
      };

      expect(validatePlugin(plugin)).toBeNull();
      expect(pluginWarnings(warnSpy)).toContain("string-hooks-plugin");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginRegistry.getLoopHandlers — staging, ordering, freezing (AC4–AC8, AC11)
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginRegistry.getLoopHandlers", () => {
  test("AC4: returns an empty array when no loaded plugin provides 'loop-handlers'", () => {
    const noPlugins = new PluginRegistry([]).getLoopHandlers();
    expect(Array.isArray(noPlugins)).toBe(true);
    expect(noPlugins).toHaveLength(0);
    expect(Object.isFrozen(noPlugins)).toBe(true);

    const otherTypesOnly = new PluginRegistry([makeNonProvider("reporter-plugin"), makeNonProvider("another")]);
    expect(otherTypesOnly.getLoopHandlers()).toHaveLength(0);
  });

  test("AC5: stages one LoopHandlerEntry { plugin, event, handler } per on(event, handler) call", () => {
    const afterToolHandler = (): undefined => undefined;
    const beforeTurnHandler = (): undefined => undefined;
    const registry = new PluginRegistry([
      makeLoopHandlerPlugin("hooks-plugin", (on) => {
        on("after_tool", afterToolHandler);
        on("before_turn", beforeTurnHandler);
      }),
    ]);

    const set = registry.getLoopHandlers();

    expect(set).toHaveLength(2);
    const afterToolEntry = set[0];
    const beforeTurnEntry = set[1];
    assertDefined(afterToolEntry, "after_tool entry");
    assertDefined(beforeTurnEntry, "before_turn entry");

    expect(afterToolEntry.plugin).toBe("hooks-plugin");
    expect(afterToolEntry.event).toBe("after_tool");
    expect(afterToolEntry.handler).toBe(afterToolHandler);
    expect(beforeTurnEntry.plugin).toBe("hooks-plugin");
    expect(beforeTurnEntry.event).toBe("before_turn");
    expect(beforeTurnEntry.handler).toBe(beforeTurnHandler);
    // The entry carries the plugin identity, the event and the handler — no more.
    expect(Object.keys(afterToolEntry).sort()).toEqual(["event", "handler", "plugin"]);
  });

  test("AC5 (US-001): stages a registration for every event in the loop-event vocabulary", () => {
    // The registry validates a plugin's event name against the runtime
    // vocabulary, so a missing entry would silently drop a legitimate
    // registration. Pin the vocabulary against all eight events.
    const vocabulary = [
      "before_tool",
      "after_tool",
      "before_turn",
      "transform_context",
      "before_request",
      "after_response",
      "before_compaction",
      "before_turn_end",
    ] as const;
    const registry = new PluginRegistry([
      makeLoopHandlerPlugin("all-events-plugin", (on) => {
        for (const event of vocabulary) {
          on(event, () => undefined);
        }
      }),
    ]);

    expect(registry.getLoopHandlers().map((entry) => entry.event)).toEqual([...vocabulary]);
    expect(LOOP_EVENTS).toEqual([...vocabulary]);
  });

  test("AC6: orders entries by registry.plugins order, then by on() call order within a plugin", () => {
    const registry = new PluginRegistry([
      makeLoopHandlerPlugin("first-plugin", (on) => {
        on("before_turn", (): undefined => undefined);
        on("after_tool", (): undefined => undefined);
      }),
      // A plugin providing something else sits between them and contributes nothing.
      makeNonProvider("middle-plugin"),
      makeLoopHandlerPlugin("second-plugin", (on) => {
        on("after_tool", (): undefined => undefined);
      }),
    ]);

    expect(registry.getLoopHandlers().map((entry) => `${entry.plugin}:${entry.event}`)).toEqual([
      "first-plugin:before_turn",
      "first-plugin:after_tool",
      "second-plugin:after_tool",
    ]);
  });

  test("AC7: returns an array for which Object.isFrozen is true", () => {
    const registry = new PluginRegistry([
      makeLoopHandlerPlugin("frozen-plugin", (on) => on("after_tool", () => undefined)),
    ]);

    const set = registry.getLoopHandlers();

    expect(set).toHaveLength(1);
    expect(Object.isFrozen(set)).toBe(true);
  });

  test("AC8: calls each plugin's register exactly once, and returns the same array instance on a second call", () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const registry = new PluginRegistry([
      makeLoopHandlerPlugin("first-plugin", (on) => {
        firstCalls += 1;
        on("after_tool", () => undefined);
      }),
      makeLoopHandlerPlugin("second-plugin", (on) => {
        secondCalls += 1;
        on("before_turn", () => undefined);
      }),
    ]);

    const first = registry.getLoopHandlers();
    const second = registry.getLoopHandlers();

    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    expect(second).toBe(first);
    expect(second).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PluginRegistry.getLoopHandlers — failure isolation (AC9, AC10)
// ─────────────────────────────────────────────────────────────────────────────

describe("PluginRegistry.getLoopHandlers failure isolation", () => {
  test("AC9: a throwing register drops only that plugin's entries and warns with its name", async () => {
    await withWarnSpy(async (warnSpy) => {
      const survivor = (): undefined => undefined;
      const doomed = (): undefined => undefined;
      const registry = new PluginRegistry([
        makeLoopHandlerPlugin("boom-plugin", (on) => {
          // Staged BEFORE the throw — the plugin's entries are dropped atomically.
          on("before_turn", doomed);
          throw new Error("register blew up");
        }),
        makeLoopHandlerPlugin("survivor-plugin", (on) => on("after_tool", survivor)),
      ]);

      const set = registry.getLoopHandlers();

      expect(set.map((entry) => entry.plugin)).toEqual(["survivor-plugin"]);
      const survivorEntry = set[0];
      assertDefined(survivorEntry, "survivor entry");
      expect(survivorEntry.handler).toBe(survivor);
      expect(pluginWarnings(warnSpy)).toContain("boom-plugin");
    });
  });

  test("AC9: returns an empty frozen set when every providing plugin throws", async () => {
    await withWarnSpy(async (warnSpy) => {
      const registry = new PluginRegistry([
        makeLoopHandlerPlugin("boom-one", () => {
          throw new Error("nope");
        }),
        makeLoopHandlerPlugin("boom-two", () => {
          throw new Error("nope");
        }),
      ]);

      const set = registry.getLoopHandlers();

      expect(set).toHaveLength(0);
      expect(Object.isFrozen(set)).toBe(true);
      expect(pluginWarnings(warnSpy)).toContain("boom-one");
      expect(pluginWarnings(warnSpy)).toContain("boom-two");
    });
  });

  test("AC10: an unknown event drops every entry for that plugin and warns naming the plugin and the event", async () => {
    await withWarnSpy(async (warnSpy) => {
      const tooLate = (): undefined => undefined;
      const registry = new PluginRegistry([
        makeLoopHandlerPlugin("unknown-event-plugin", (on) => {
          on("after_tool", tooLate);
          registerUnknownEvent(on, "before_everything");
        }),
      ]);

      const set = registry.getLoopHandlers();

      expect(set).toHaveLength(0);
      const warnings = pluginWarnings(warnSpy);
      expect(warnings).toContain("unknown-event-plugin");
      expect(warnings).toContain("before_everything");
    });
  });

  test("US-001: staging rejects a non-function handler and drops that plugin's entries", async () => {
    await withWarnSpy(async (warnSpy) => {
      const registry = new PluginRegistry([
        makeLoopHandlerPlugin("bad-handler-plugin", (on) => {
          on("after_tool", (): undefined => undefined);
          // A plugin module is JavaScript at runtime, so `on` can be handed a
          // value the typed API cannot express — the registrar is the only
          // place that sees it before it is frozen into the set.
          Reflect.apply(on, undefined, ["after_tool", null]);
        }),
      ]);

      expect(registry.getLoopHandlers()).toHaveLength(0);
      expect(pluginWarnings(warnSpy)).toContain("bad-handler-plugin");
    });
  });

  test("US-001: an async register() is skipped with a warning so a registration after its first await is never half-installed", async () => {
    await withWarnSpy(async (warnSpy) => {
      const registry = new PluginRegistry([
        // `register` is declared `: void`, and TypeScript still accepts an
        // async implementation — so this shape reaches the registry.
        makeLoopHandlerPlugin("async-plugin", async (on) => {
          on("after_tool", (): undefined => undefined);
          await Promise.resolve();
          on("before_turn", (): undefined => undefined);
        }),
        makeLoopHandlerPlugin("sync-plugin", (on) => on("after_tool", () => undefined)),
      ]);

      const set = registry.getLoopHandlers();

      expect(set.map((entry) => entry.plugin)).toEqual(["sync-plugin"]);
      expect(pluginWarnings(warnSpy)).toContain("async-plugin");
      // The late on(...) call cannot reach the frozen set, and it is not
      // picked up by a second call either.
      await Promise.resolve();
      expect(registry.getLoopHandlers()).toBe(set);
      expect(set).toHaveLength(1);
    });
  });

  test("US-001: an async register() that rejects logs the rejection rather than leaving it unhandled", async () => {
    await withWarnSpy(async (warnSpy) => {
      const registry = new PluginRegistry([
        makeLoopHandlerPlugin("rejecting-plugin", async () => {
          throw new Error("async register blew up");
        }),
      ]);

      expect(registry.getLoopHandlers()).toHaveLength(0);
      // A `try` around a sync-looking call cannot catch this: the rejection is
      // drained by the registry and reported as a `plugins` warning.
      await Promise.resolve();
      await Promise.resolve();
      const warnings = pluginWarnings(warnSpy);
      expect(warnings).toContain("rejecting-plugin");
      expect(warnings).toContain("async register blew up");
    });
  });

  test("US-001: a plugin declaring 'loop-handlers' without the extension is warned about, not silently skipped", async () => {
    await withWarnSpy(async (warnSpy) => {
      // validatePlugin() rejects this shape (AC2), but a directly-constructed
      // registry — the legacy `NaxPlugin[]` path — never passes through it.
      const registry = new PluginRegistry([
        { name: "mismatched-plugin", version: "1.0.0", provides: ["loop-handlers"], extensions: {} },
        makeLoopHandlerPlugin("intact-plugin", (on) => on("after_tool", () => undefined)),
      ]);

      expect(registry.getLoopHandlers().map((entry) => entry.plugin)).toEqual(["intact-plugin"]);
      expect(pluginWarnings(warnSpy)).toContain("mismatched-plugin");
    });
  });

  test("AC10: an unknown event leaves another plugin's entries alone", async () => {
    await withWarnSpy(async () => {
      const registry = new PluginRegistry([
        makeLoopHandlerPlugin("unknown-event-plugin", (on) => {
          registerUnknownEvent(on, "before_everything");
        }),
        makeLoopHandlerPlugin("intact-plugin", (on) => on("after_tool", () => undefined)),
      ]);

      expect(registry.getLoopHandlers().map((entry) => entry.plugin)).toEqual(["intact-plugin"]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Public types (AC11)
// ─────────────────────────────────────────────────────────────────────────────

describe("loop-handler public types", () => {
  test("AC11: an ExternalHandlerOf<'after_tool'> registered by a plugin is accepted by getLoopHandlers()'s return type", () => {
    let seenContext: LoopHandlerContext | undefined;
    const handler: ExternalHandlerOf<"after_tool"> = (payload, ctx: LoopHandlerContext) => {
      seenContext = ctx;
      return { content: `${ctx.sessionName}: ${payload.content}` };
    };

    // Both the registrar call and the return type are the story's public API:
    // `on("after_tool", handler)` only typechecks because the registrar infers E
    // from the event name, and `set` is accepted as a LoopHandlerSet.
    const registry = new PluginRegistry([makeLoopHandlerPlugin("typed-plugin", (on) => on("after_tool", handler))]);
    const set: LoopHandlerSet = registry.getLoopHandlers();

    expect(set.map((entry) => entry.plugin)).toEqual(["typed-plugin"]);
    expect(set.map((entry) => entry.event)).toEqual(["after_tool"]);

    const staged = set[0];
    assertDefined(staged, "staged entry");
    const entry: LoopHandlerEntry = staged;

    const ctx: LoopHandlerContext = { sessionName: "session-1" };
    expect(entry.handler({ content: "tool output" }, ctx)).toEqual({ content: "session-1: tool output" });
    expect(seenContext).toBe(ctx);
  });
});
