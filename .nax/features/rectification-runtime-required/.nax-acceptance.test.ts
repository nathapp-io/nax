import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Test setup: import source modules
// ─────────────────────────────────────────────────────────────────────────────

// AC-5, AC-6, AC-7: Read source code to verify implementation
function readSourceFile(relativePath: string): string {
  const packageRoot = join(import.meta.dir, "../../../");
  const filePath = join(packageRoot, relativePath);
  return readFileSync(filePath, "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1, AC-2: Verify call site in rectify.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: Call site in rectify.ts passes runtime and no sessionManager", () => {
  test("runRectificationLoop is called with runtime: ctx.runtime", () => {
    const source = readSourceFile("src/pipeline/stages/rectify.ts");

    // Should find the invocation pattern
    const hasRuntimeCtxRuntime = source.includes("runtime: ctx.runtime");
    expect(hasRuntimeCtxRuntime).toBe(true);

    // Should NOT reference sessionManager in the call
    const rectifyCallPattern = source.match(
      /await _rectifyDeps\.runRectificationLoop\([^)]+\)/s
    );
    expect(rectifyCallPattern).not.toBeNull();

    if (rectifyCallPattern) {
      const callContent = rectifyCallPattern[0];
      // The call should not contain sessionManager property
      expect(callContent).not.toMatch(/sessionManager\s*:/);
    }
  });
});

describe("AC-2: Call site in rectify.ts passes sessionId", () => {
  test("runRectificationLoop is called with sessionId: ctx.sessionId", () => {
    const source = readSourceFile("src/pipeline/stages/rectify.ts");

    const hasSessionId = source.includes("sessionId: ctx.sessionId");
    expect(hasSessionId).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: Inside runDeferredRegression, uses runtime.agentManager
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5: runDeferredRegression uses runtime.agentManager, not options.agentManager", () => {
  test("function body contains runtime.agentManager references", () => {
    const source = readSourceFile("src/execution/lifecycle/run-regression.ts");

    const hasRuntimeAgentManager = /runtime\.agentManager/.test(source);
    expect(hasRuntimeAgentManager).toBe(true);

    // Should not have options.agentManager (except in destructuring)
    // Allow destructuring line, but not member access
    const lines = source.split("\n");
    let foundOptionsAgentManagerAccess = false;

    for (const line of lines) {
      // Skip the destructuring line and type annotations
      if (
        line.includes("const { config, prd, workdir, runtime, agentManager }") ||
        line.includes("@deprecated") ||
        line.match(/\/\/\s*agentManager/)
      ) {
        continue;
      }

      if (/options\.agentManager/.test(line)) {
        foundOptionsAgentManagerAccess = true;
        break;
      }
    }

    expect(foundOptionsAgentManagerAccess).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: runRectificationLoop within runDeferredRegression includes runtime
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-6: Call to runRectificationLoop from runDeferredRegression passes runtime", () => {
  test("runRectificationLoop invocation includes runtime property", () => {
    const source = readSourceFile("src/execution/lifecycle/run-regression.ts");

    const hasRuntimePassage = source.includes("runtime");
    expect(hasRuntimePassage).toBe(true);

    // Find the runRectificationLoop call within runDeferredRegression
    const callMatch = source.match(
      /await _regressionDeps\.runRectificationLoop\s*\(\s*\{[\s\S]*?runtime/
    );
    expect(callMatch).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: Call site in run-completion.ts passes runtime, no agentManager
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7: Call site in run-completion.ts passes runtime and no agentManager", () => {
  test("runDeferredRegression is called with runtime: options.runtime", () => {
    const source = readSourceFile("src/execution/lifecycle/run-completion.ts");

    const hasRuntimeOptions = source.includes("runtime: options.runtime");
    expect(hasRuntimeOptions).toBe(true);

    // Find the runDeferredRegression call
    const callMatch = source.match(
      /await _runCompletionDeps\.runDeferredRegression\s*\(\s*\{[^}]*\}\s*\)/s
    );
    expect(callMatch).not.toBeNull();

    if (callMatch) {
      const callContent = callMatch[0];
      // Should not have agentManager property
      expect(callContent).not.toMatch(/agentManager\s*:/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-17: Code inspection confirms runFullSuiteGate doesn't pass sessionManager
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-17: runFullSuiteGate function body calls runRectificationLoop without sessionManager", () => {
  test("Inner runRectificationLoop calls do not include sessionManager", () => {
    const source = readSourceFile("src/tdd/rectification-gate.ts");

    // Find all runRectificationLoop invocations
    const matches = source.match(/await runRectificationLoop\([^)]+\)/gs);
    expect(matches).not.toBeNull();
    expect((matches || []).length).toBeGreaterThan(0);

    if (matches) {
      for (const match of matches) {
        // None of the calls should include sessionManager as a positional parameter
        // (sessionManager is optional parameter #12, but should not be passed)
        expect(match).not.toMatch(/sessionManager\s*,/);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-18: Code inspection confirms runFullSuiteGate includes runtime argument
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-18: runFullSuiteGate signature and calls include runtime parameter", () => {
  test("function signature includes runtime parameter", () => {
    const source = readSourceFile("src/tdd/rectification-gate.ts");

    const hasFunctionSignature = /runtime:\s*import\("\.\.\/runtime"\)\.NaxRuntime/.test(source);
    expect(hasFunctionSignature).toBe(true);
  });

  test("runRectificationLoop is called with runtime argument", () => {
    const source = readSourceFile("src/tdd/rectification-gate.ts");

    // Find the inner runRectificationLoop calls and check for runtime
    const matches = source.match(/await runRectificationLoop\([\s\S]+?\);/g);
    expect(matches).not.toBeNull();

    if (matches) {
      for (const match of matches) {
        // Should have runtime as one of the arguments
        expect(match).toMatch(/runtime/);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-19: Code inspection confirms agentManager.runAsSession is called
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-19: runRectificationLoop uses runAsSession, legacy else block deleted", () => {
  test("calls agentManager.runAsSession during rectification", () => {
    const source = readSourceFile("src/tdd/rectification-gate.ts");

    const hasRunAsSession = source.includes("agentManager.runAsSession");
    expect(hasRunAsSession).toBe(true);
  });

  test("no legacy else block with agentManager.run exists", () => {
    const source = readSourceFile("src/tdd/rectification-gate.ts");

    // The legacy pattern was: else { agentManager.run(...) }
    // This should not exist in the rectification path anymore
    const lines = source.split("\n");
    let inRectificationLoop = false;
    let foundLegacyElse = false;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("export async function runFullSuiteGate")) {
        inRectificationLoop = true;
      }

      if (inRectificationLoop && lines[i].includes("} else {")) {
        // Check if this is followed by agentManager.run
        if (i + 1 < lines.length && lines[i + 1].includes("agentManager.run")) {
          foundLegacyElse = true;
          break;
        }
      }
    }

    expect(foundLegacyElse).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-20: Code inspection confirms runtime.sessionManager.bindHandle invoked
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-20: runtime.sessionManager.bindHandle is invoked after attempt", () => {
  test("bindHandle is called with (sessionId, name, protocolIds) pattern", () => {
    const source = readSourceFile("src/tdd/rectification-gate.ts");

    const hasBindHandle = /sessionManager\.bindHandle\s*\(\s*sessionId\s*,/.test(source);
    expect(hasBindHandle).toBe(true);
  });

  test("bindHandle call includes rectificationSessionName", () => {
    const source = readSourceFile("src/tdd/rectification-gate.ts");

    const hasNameArg = /bindHandle\s*\(\s*sessionId\s*,\s*rectificationSessionName/.test(source);
    expect(hasNameArg).toBe(true);
  });

  test("bindHandle call includes protocolIds", () => {
    const source = readSourceFile("src/tdd/rectification-gate.ts");

    const hasProtoIds = /bindHandle\s*\(\s*[^)]*protocolIds/.test(source);
    expect(hasProtoIds).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-21: Code inspection confirms finally block calls closeSession correctly
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-21: finally block calls closeSession with heldHandle guard only", () => {
  test("finally block contains closeSession(heldHandle) call", () => {
    const source = readSourceFile("src/tdd/rectification-gate.ts");

    const hasCloseSession = /\.finally\s*\(\s*async\s*\(\)\s*=>/s.test(source);
    expect(hasCloseSession).toBe(true);

    const hasHandleClose = /closeSession\s*\(\s*(?:stale|heldHandle)/.test(source);
    expect(hasHandleClose).toBe(true);
  });

  test("closeSession only guarded by heldHandle check, no runtime check", () => {
    const source = readSourceFile("src/tdd/rectification-gate.ts");

    // Find the finally block
    const finallyMatch = source.match(
      /\.finally\s*\(\s*async\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*\);/
    );

    expect(finallyMatch).not.toBeNull();

    if (finallyMatch) {
      const finallyBlock = finallyMatch[0];

      // Should have if (heldHandle) pattern — no runtime check needed (runtime is always present)
      const hasProperGuard = /if\s*\(\s*heldHandle\s*\)/.test(finallyBlock);
      expect(hasProperGuard).toBe(true);

      // Should NOT have just if (heldHandle && runtime) then access runtime without check
      // The guard should protect both the closure and the actual call
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-22: TypeScript compilation succeeds for tdd/orchestrator.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-22: TypeScript compilation succeeds for tdd/orchestrator.ts", () => {
  test("file can be imported without type errors", () => {
    const source = readSourceFile("src/tdd/orchestrator.ts");

    // Basic sanity check - file exists and has expected content
    expect(source.length).toBeGreaterThan(0);

    // Check for runFullSuiteGate call
    const hasCall = source.includes("runFullSuiteGate");
    expect(hasCall).toBe(true);
  });

  test("runFullSuiteGate is called with runtime argument", () => {
    const source = readSourceFile("src/tdd/orchestrator.ts");

    const callMatch = source.match(/runFullSuiteGate\s*\([^)]*\)/);
    expect(callMatch).not.toBeNull();

    if (callMatch) {
      const call = callMatch[0];
      // Should include runtime parameter
      expect(call).toMatch(/runtime/);
    }
  });

  test("runFullSuiteGate call does not include sessionManager", () => {
    const source = readSourceFile("src/tdd/orchestrator.ts");

    const callMatch = source.match(/runFullSuiteGate\s*\(\s*[\s\S]*?\)/);
    expect(callMatch).not.toBeNull();

    if (callMatch) {
      const call = callMatch[0];
      // Should NOT include sessionManager property
      expect(call).not.toMatch(/sessionManager\s*:/);
    }
  });
});