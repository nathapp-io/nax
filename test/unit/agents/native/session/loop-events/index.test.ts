/**
 * US-002 — the `loop-events` barrel's public surface for the external handler.
 *
 * `wrapExternalHandler()`, `LOOP_HANDLER_TIMEOUT_MS` and `_externalHandlerDeps`
 * live in `./external-handler.ts`, but `src/` may not reach that path: a VALUE
 * import of `@/<dir>/<internal>` is rejected by `check:alias-internals`
 * whenever `src/<dir>/index.ts` exists, so an internal path would launder a
 * barrel violation. The promotion route (`external-handler.ts` ->
 * `external-handler/index.ts`) would move the module the story names, so the
 * barrel re-export is the conformant route.
 *
 * That makes this barrel the module's public API: US-003's installer and
 * US-004's delivery code can only see what it re-exports. The tests below go
 * through the barrel exactly as a `src/` consumer must, and assert IDENTITY
 * with the defining module's bindings — a re-export that produced a second
 * `_externalHandlerDeps` object would silently detach the timeout seam from the
 * wrapper that reads it, and the plugin's handler would then never be cut off.
 *
 * AC reference is carried in the test name; US-002 is this story's id.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as loopEvents from "@/agents/native/session/loop-events";
import {
  _externalHandlerDeps,
  LOOP_HANDLER_TIMEOUT_MS,
  wrapExternalHandler,
} from "@/agents/native/session/loop-events/external-handler";
import type {
  BeforeToolPayload,
  LoopHandlerContext,
  LoopHandlerEntry,
} from "@/agents/native/session/loop-events/types";

/**
 * The barrel's public surface, read BY NAME off the namespace object.
 *
 * A named import of a symbol the barrel does not carry yet is a link-time
 * failure, and `test/` is a hard typecheck gate (its own pre-commit hook runs
 * it), so a missing re-export has to surface as a failing assertion rather than
 * as a build break. `Reflect.get` returns the export itself — same binding, no
 * copy, no wrapper — and each read is typed as the finished barrel declares it.
 */
const BARREL_WRAP: typeof wrapExternalHandler = Reflect.get(loopEvents, "wrapExternalHandler");
const BARREL_TIMEOUT_MS: number = Reflect.get(loopEvents, "LOOP_HANDLER_TIMEOUT_MS");
const BARREL_DEPS: typeof _externalHandlerDeps = Reflect.get(loopEvents, "_externalHandlerDeps");

const PLUGIN = "barrel-plugin";

/** Restored after each test that drives the deadline through the barrel export. */
const ORIGINAL_TIMEOUT_MS = _externalHandlerDeps.timeoutMs;

afterEach(() => {
  _externalHandlerDeps.timeoutMs = ORIGINAL_TIMEOUT_MS;
});

const CTX: LoopHandlerContext = { sessionName: "session-1" };

function beforeToolPayload(): BeforeToolPayload {
  return { call: { id: "c1", name: "Edit", input: { path: "a.ts" } }, tools: [] };
}

/** One staged plugin registration, as `PluginRegistry.getLoopHandlers()` hands it over. */
function entryWith(handler: LoopHandlerEntry["handler"]): LoopHandlerEntry {
  return { plugin: PLUGIN, event: "before_tool", handler };
}

describe("loop-events barrel — the external-handler public surface", () => {
  test("US-002: the barrel re-exports LOOP_HANDLER_TIMEOUT_MS with the module's own value", () => {
    expect(BARREL_TIMEOUT_MS).toBe(LOOP_HANDLER_TIMEOUT_MS);
    expect(BARREL_TIMEOUT_MS).toBe(10000);
  });

  test("US-002: the barrel re-exports wrapExternalHandler as the module's own function", () => {
    expect(BARREL_WRAP).toBe(wrapExternalHandler);
  });

  test("US-002: the barrel re-exports _externalHandlerDeps as the very object the module mutates", () => {
    // Identity, not equality: the wrapper reads this object at dispatch time, so
    // a second copy reachable through the barrel would leave the deadline seam
    // pointing at nothing — the exact failure a re-export is supposed to avoid.
    expect(BARREL_DEPS).toBe(_externalHandlerDeps);
  });

  test("US-002: a before_tool handler wrapped through the barrel blocks a failing call, attributed to its plugin", async () => {
    // Asserted before the call, so a missing re-export fails HERE — as an
    // assertion naming the missing export — rather than as a bare TypeError.
    expect(BARREL_WRAP).toBe(wrapExternalHandler);

    const entry = entryWith(() => {
      throw new Error("barrel boom");
    });
    const wrapped = BARREL_WRAP(entry, () => CTX, new AbortController().signal);

    const outcome = await wrapped(beforeToolPayload());

    expect(outcome).toEqual(
      expect.objectContaining({ kind: "block", content: expect.stringContaining(`'${PLUGIN}'`) }),
    );
  });

  test("US-002: shortening the deadline through the barrel export cuts a never-settling handler off", async () => {
    // Drives the seam through the PUBLIC binding: a barrel dep that were a copy
    // would leave the deadline at 10s, and this dispatch would hang instead of
    // answering — the detach the identity test above forbids.
    expect(BARREL_DEPS).toBe(_externalHandlerDeps);
    BARREL_DEPS.timeoutMs = 20;

    const entry = entryWith(() => new Promise<never>(() => {}));
    const wrapped = BARREL_WRAP(entry, () => CTX, new AbortController().signal);

    const outcome = await wrapped(beforeToolPayload());

    expect(outcome).toEqual(
      expect.objectContaining({ kind: "block", content: expect.stringContaining(`'${PLUGIN}'`) }),
    );
  });
});
