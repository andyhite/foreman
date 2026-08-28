import { describe, expect, it } from "bun:test";
import { createTheme, stripAnsi, visibleWidth } from "@foreman/core";
import {
  initialListView,
  moveSelection,
  renderList,
  scrollToSelection,
  wrapLine,
} from "../src/tui/list.ts";
import type { ListItem } from "../src/tui/list.ts";

const plainTheme = createTheme(false);
const colorTheme = createTheme(true);

describe("moveSelection wrapping", () => {
  it("wraps from the last item to the first moving down", () => {
    const view = { selected: 2, scrollTop: 0 };
    expect(moveSelection(view, 3, 1)).toEqual({ selected: 0, scrollTop: 0 });
  });

  it("wraps from the first item to the last moving up", () => {
    const view = { selected: 0, scrollTop: 0 };
    expect(moveSelection(view, 3, -1)).toEqual({ selected: 2, scrollTop: 0 });
  });

  it("is a no-op on an empty list", () => {
    const view = initialListView();
    expect(moveSelection(view, 0, 1)).toEqual(view);
  });
});

describe("scrollToSelection", () => {
  it("scrolls down to keep a selection below the visible window in view", () => {
    const view = { selected: 9, scrollTop: 0 };
    expect(scrollToSelection(view, 5)).toEqual({ selected: 9, scrollTop: 5 });
  });

  it("scrolls up to keep a selection above the visible window in view", () => {
    const view = { selected: 1, scrollTop: 5 };
    expect(scrollToSelection(view, 5)).toEqual({ selected: 1, scrollTop: 1 });
  });

  it("leaves the scroll position unchanged when the selection is already visible", () => {
    const view = { selected: 3, scrollTop: 1 };
    expect(scrollToSelection(view, 5)).toEqual(view);
  });
});

describe("wrapLine", () => {
  it("never emits a segment wider than the given width", () => {
    const text = "the quick brown fox jumps over the lazy dog and keeps running";
    for (const wrapped of wrapLine(text, 12)) {
      expect(wrapped.length).toBeLessThanOrEqual(12);
    }
  });

  it("hard-breaks a single word longer than the width", () => {
    const wrapped = wrapLine("supercalifragilisticexpialidocious", 10);
    for (const line of wrapped) {
      expect(line.length).toBeLessThanOrEqual(10);
    }
    expect(wrapped.join("")).toBe("supercalifragilisticexpialidocious");
  });
});

describe("renderList width", () => {
  it("never emits a line wider than the given width", () => {
    const items: ListItem[] = [
      { label: "ENG-142 a very long label that should be truncated somewhere", detail: ["a very long detail line that needs wrapping across several rows of terminal output"] },
      { label: "ENG-143", detail: ["short"] },
    ];
    const lines = renderList({
      title: "Blocked",
      items,
      view: { selected: 0, scrollTop: 0 },
      width: 20,
      listRows: 5,
      emptyMessage: "Nothing blocked.",
      theme: plainTheme,
    });
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  it("renders a stated-empty frame rather than a blank one for an empty list", () => {
    const lines = renderList({
      title: "Blocked",
      items: [],
      view: initialListView(),
      width: 40,
      listRows: 5,
      emptyMessage: "Nothing blocked.",
      theme: plainTheme,
    });
    expect(lines.some((line) => line.includes("Nothing blocked."))).toBe(true);
  });

  it("produces byte-identical output to an unstyled theme when styling is disabled", () => {
    const items: ListItem[] = [
      { label: "ENG-142", detail: ["a detail line"] },
      { label: "ENG-143", detail: ["short"], tone: "danger" },
    ];
    const options = {
      title: "Blocked",
      items,
      view: { selected: 0, scrollTop: 0 },
      width: 30,
      listRows: 5,
      emptyMessage: "Nothing blocked.",
    };
    const plainLines = renderList({ ...options, theme: plainTheme });
    const styledLines = renderList({ ...options, theme: colorTheme });
    expect(styledLines.length).toBe(plainLines.length);
    for (const [index, plainLine] of plainLines.entries()) {
      expect(stripAnsi(styledLines[index] ?? "")).toBe(plainLine);
      expect(visibleWidth(styledLines[index] ?? "")).toBeLessThanOrEqual(30);
    }
  });
});
