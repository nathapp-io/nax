import { afterEach, describe, expect, mock, test } from "bun:test";
import { mountChatPicker } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { TranscriptViewport } from "@/tui/chat/TranscriptViewport";
import { resolveChatTheme } from "@/tui/chat/theme";
import { useJobsOpener } from "@/tui/chat/use-jobs-opener";
import { type MentionMenuController, useMentionMenu } from "@/tui/chat/use-mention-menu";
import { fakeMouse } from "./mouse";

const theme = resolveChatTheme({ env: {}, colorLevel: 0 });
afterEach(cleanup);

describe("allocated interaction boundaries", () => {
  test.each([0, 1, 3])("AC-1 first transcript cell uses allocated top %s", (top) => {
    const mouse = fakeMouse();
    const onClick = mock(() => {});
    render(
      <TranscriptViewport
        lines={[[{ text: "first" }]]}
        height={2}
        top={top}
        theme={theme}
        mouse={mouse.events}
        onClick={onClick}
      />,
    );
    act(() => mouse.emit("press", { button: "left", ...{ x: 3, y: top + 1 } }));
    act(() => mouse.emit("release", { button: "left", ...{ x: 3, y: top + 1 } }));
    expect(onClick).toHaveBeenCalledWith(0);
  });

  test.each([0, 1, 3])("AC-2 wheel outside allocated transcript top %s does not scroll", (top) => {
    const mouse = fakeMouse();
    const ui = render(
      <TranscriptViewport
        lines={Array.from({ length: 30 }, (_, i) => [{ text: `line ${i}` }])}
        height={3}
        top={top}
        theme={theme}
        mouse={mouse.events}
      />,
    );
    const before = ui.lastFrame();
    act(() => mouse.emit("wheelUp", { x: 1, y: top + 4 }));
    expect(ui.lastFrame()).toBe(before);
    act(() => mouse.emit("wheelUp", { x: 1, y: top + 1 }));
    expect(ui.lastFrame()).not.toBe(before);
  });

  test.each(["zero", "inactive"])("AC-2 AC-15 %s viewport rejects clicks, selection and scrolling", (kind) => {
    const mouse = fakeMouse();
    const onClick = mock(() => {});
    const onCopy = mock(() => {});
    const lines = Array.from({ length: 40 }, (_, i) => [{ text: `line ${i}` }]);
    const props = { lines, height: 3, top: 1, theme, mouse: mouse.events, onClick, onCopy };
    const ui = render(<TranscriptViewport {...props} />);
    const before = ui.lastFrame();
    act(() =>
      ui.rerender(<TranscriptViewport {...props} height={kind === "zero" ? 0 : 3} active={kind !== "inactive"} />),
    );
    for (const event of ["press", "drag", "release", "wheelUp", "wheelDown"] as const)
      act(() => mouse.emit(event, { button: "left", x: event === "drag" ? 3 : 1, y: 2 }));
    act(() => ui.stdin.write("\x1b[5~"));
    expect(onClick).not.toHaveBeenCalled();
    expect(onCopy).not.toHaveBeenCalled();
    act(() => ui.rerender(<TranscriptViewport {...props} />));
    expect(ui.lastFrame()).toBe(before);
  });

  test.each([5, 8])("AC-3 allocated footer row %s opens jobs rather than terminal-derived row", (top) => {
    const host = mountChatPicker().host;
    const mouse = fakeMouse();
    const open = mock(() => {});
    function Probe() {
      useJobsOpener({
        host,
        mouse: mouse.events,
        blocked: false,
        footer: { right: [{ text: "jobs" }], stripWidth: 4 },
        size: { columns: 80, rows: 24 },
        region: { top, rows: 1 },
        open,
        note: () => {},
        showOutput: () => {},
        openAgent: () => {},
      });
      return null;
    }
    render(<Probe />);
    act(() => mouse.emit("press", { button: "left", ...{ x: 77, y: top + 1 } }));
    act(() => mouse.emit("release", { button: "left", ...{ x: 77, y: top + 1 } }));
    expect(open).toHaveBeenCalledWith("jobs");
  });

  test("AC-4 zero allocated footer rejects stale mouse cells and Ctrl-G", () => {
    const host = mountChatPicker().host;
    const mouse = fakeMouse();
    const open = mock(() => {});
    const note = mock(() => {});
    function Probe() {
      useJobsOpener({
        host,
        mouse: mouse.events,
        blocked: false,
        footer: { right: [{ text: "jobs" }], stripWidth: 4 },
        size: { columns: 80, rows: 24 },
        region: { top: 22, rows: 0 },
        open,
        note,
        showOutput: () => {},
        openAgent: () => {},
      });
      return null;
    }
    const ui = render(<Probe />);
    act(() => mouse.emit("press", { button: "left", ...{ x: 77, y: 23 } }));
    act(() => mouse.emit("release", { button: "left", ...{ x: 77, y: 23 } }));
    act(() => ui.stdin.write("\x07"));
    expect(open).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  test("AC-4 a press on a hidden footer cannot become a click on expansion", () => {
    const host = mountChatPicker().host;
    const mouse = fakeMouse();
    const open = mock(() => {});
    function Probe({ rows }: { rows: number }) {
      useJobsOpener({
        host,
        mouse: mouse.events,
        blocked: false,
        footer: { right: [{ text: "jobs" }], stripWidth: 4 },
        size: { columns: 80, rows: 24 },
        region: { top: 22, rows },
        open,
        note: () => {},
        showOutput: () => {},
        openAgent: () => {},
      });
      return null;
    }
    const ui = render(<Probe rows={0} />);
    act(() => mouse.emit("press", { button: "left", x: 77, y: 23 }));
    act(() => ui.rerender(<Probe rows={1} />));
    act(() => mouse.emit("release", { button: "left", x: 77, y: 23 }));
    expect(open).not.toHaveBeenCalled();
  });

  test("AC-5 a mention's batched acted hold cannot outlive allocated visibility", async () => {
    let rows = 2;
    let controller: MentionMenuController | undefined;
    let claimed: boolean | undefined;
    const edit = mock(() => {
      rows = 0;
      claimed = controller?.ownsNavigation();
    });
    function Probe() {
      controller = useMentionMenu({
        cwd: "/repo",
        indexFor: () => ({ get: async () => ({ git: true, rows: [{ path: "file.ts", folder: false }] }) }),
        editor: { text: "@f", cursor: 2 },
        blocked: false,
        suppressed: false,
        slashOwns: () => false,
        allocatedRows: () => rows,
        active: true,
        handle: { current: { edit, complete: () => {}, submit: () => {} } },
      });
      return null;
    }
    const ui = render(<Probe />);
    await Promise.resolve(
      act(async () => {
        await Promise.resolve();
      }),
    );
    act(() => ui.stdin.write("\r"));
    expect(edit).toHaveBeenCalledTimes(1);
    expect(claimed).toBe(false);
  });
});
