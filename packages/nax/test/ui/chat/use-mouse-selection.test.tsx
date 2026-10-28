import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { useMouseSelection } from "@/tui/chat/use-mouse-selection";
import { fakeMouse } from "./mouse";

afterEach(cleanup);
function mount(active = true) {
  const mouse = fakeMouse();
  const onClick = mock(() => {});
  const onCopy = mock(() => {});
  function Probe() {
    useMouseSelection({
      mouse: mouse.events,
      active,
      lines: [[{ text: "abcdef" }]],
      geometry: { top: 0, height: 5, total: 1, offset: 0, unseen: 0 },
      onClick,
      onCopy,
    });
    return null;
  }
  render(<Probe />);
  const emit = (kind: "press" | "drag" | "release", x = 1, y = 1, button: "left" | "right" = "left") =>
    act(() => mouse.emit(kind, { x, y, button }));
  return { emit, onClick, onCopy };
}
describe("useMouseSelection", () => {
  test("AC-7 clicks once with the press point and copies nothing", () => {
    const view = mount();
    view.emit("press", 3);
    view.emit("release", 3);
    view.emit("release", 3);
    expect(view.onClick).toHaveBeenCalledTimes(1);
    expect(view.onClick).toHaveBeenCalledWith({ line: 0, column: 2 });
    expect(view.onCopy).not.toHaveBeenCalled();
  });
  test("AC-8/9 dragging suppresses click and still copies", () => {
    const view = mount();
    view.emit("press");
    view.emit("drag", 3);
    view.emit("release", 3);
    expect(view.onClick).not.toHaveBeenCalled();
    expect(view.onCopy).toHaveBeenCalledWith("abc");
  });
  test("mapped excursion back to the press cell is not a click", () => {
    const view = mount();
    view.emit("press");
    view.emit("drag", 3);
    view.emit("drag");
    view.emit("release");
    expect(view.onClick).not.toHaveBeenCalled();
    expect(view.onCopy).not.toHaveBeenCalled();
  });
  test("a drag report at the press cell still allows a click", () => {
    const view = mount();
    view.emit("press");
    view.emit("drag");
    view.emit("release");
    expect(view.onClick).toHaveBeenCalledWith({ line: 0, column: 0 });
    expect(view.onCopy).not.toHaveBeenCalled();
  });
  test("AC-10 unmapped excursion and return is not a click", () => {
    const view = mount();
    view.emit("press");
    view.emit("drag", 1, 4);
    view.emit("release");
    expect(view.onClick).not.toHaveBeenCalled();
    expect(view.onCopy).not.toHaveBeenCalled();
  });
  test.each(["different release", "unmapped press", "right button", "inactive"])("ignores %s", (scenario) => {
    const view = mount(scenario !== "inactive");
    const button = scenario === "right button" ? "right" : "left";
    view.emit("press", 1, scenario === "unmapped press" ? 4 : 1, button);
    view.emit("release", scenario === "different release" ? 2 : 1, 1, button);
    expect(view.onClick).not.toHaveBeenCalled();
    expect(view.onCopy).not.toHaveBeenCalled();
  });
  test("keeps the last mapped focus when dragging outside", () => {
    const view = mount();
    view.emit("press");
    view.emit("drag", 3);
    view.emit("drag", 1, 4);
    view.emit("release", 1, 4);
    expect(view.onCopy).toHaveBeenCalledWith("abc");
    expect(view.onClick).not.toHaveBeenCalled();
  });
});
