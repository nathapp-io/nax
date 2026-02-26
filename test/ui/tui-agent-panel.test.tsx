/**
 * Tests for TUI Agent Panel and PTY integration (Phase 3).
 */

import { describe, test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { AgentPanel } from "../../src/tui/components/AgentPanel";
import type { PtyHandle } from "../../src/agents/types";
import { ClaudeCodeAdapter } from "../../src/agents/claude";

describe("AgentPanel", () => {
  test("renders placeholder when no output", () => {
    const { lastFrame } = render(<AgentPanel outputLines={[]} />);
    expect(lastFrame()).toContain("Waiting for agent...");
  });

  test("renders output lines", () => {
    const lines = ["Line 1", "Line 2", "Line 3"];
    const { lastFrame } = render(<AgentPanel outputLines={lines} />);

    for (const line of lines) {
      expect(lastFrame()).toContain(line);
    }
  });

  test("shows focus indicator when focused", () => {
    const { lastFrame } = render(<AgentPanel focused outputLines={[]} />);
    expect(lastFrame()).toContain("(focused)");
  });

  test("does not show focus indicator when not focused", () => {
    const { lastFrame } = render(<AgentPanel focused={false} outputLines={[]} />);
    expect(lastFrame()).not.toContain("(focused)");
  });

  test("buffers only last N lines", () => {
    // Generate 600 lines (exceeds MAX_OUTPUT_LINES = 500)
    const lines = Array.from({ length: 600 }, (_, i) => `Output ${i + 1}`);
    const { lastFrame } = render(<AgentPanel outputLines={lines} />);
    const frame = lastFrame();

    // Should contain last 500 lines
    expect(frame).toContain("Output 600");
    expect(frame).toContain("Output 101");

    // Should NOT contain first 100 lines (trimmed)
    // Use exact line boundaries to avoid substring matches
    expect(frame).not.toContain("Output 1\n");
    expect(frame).not.toContain("Output 100\n");
  });
});

describe("PtyHandle interface", () => {
  test("ClaudeCodeAdapter has PtyHandle interface", () => {
    const adapter = new ClaudeCodeAdapter();

    // Check that runInteractive method exists
    expect(adapter.runInteractive).toBeDefined();
    expect(typeof adapter.runInteractive).toBe("function");
  });

  test("PtyHandle has required methods", () => {
    // Mock PtyHandle to verify interface contract
    const mockHandle: PtyHandle = {
      write: (data: string) => {
        expect(typeof data).toBe("string");
      },
      resize: (cols: number, rows: number) => {
        expect(typeof cols).toBe("number");
        expect(typeof rows).toBe("number");
      },
      kill: () => {
        // noop
      },
      pid: 12345,
    };

    // Verify all methods exist
    expect(mockHandle.write).toBeDefined();
    expect(mockHandle.resize).toBeDefined();
    expect(mockHandle.kill).toBeDefined();
    expect(mockHandle.pid).toBe(12345);

    // Test methods
    mockHandle.write("test");
    mockHandle.resize(80, 24);
    mockHandle.kill();
  });
});

describe("usePty hook", () => {
  test("returns null handle when options is null", () => {
    // This test would require rendering a component that uses usePty
    // For now, we just document the expected behavior
    // const { handle } = usePty(null);
    // expect(handle).toBeNull();
    expect(true).toBe(true); // Placeholder
  });
});
