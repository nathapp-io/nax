/**
 * US-006: the model picker's recent rows.
 *
 * A recent row is the model the user reached for last, so it comes first, newest first, with
 * the effort it was used at — `recent · effort <level>` reads differently from the catalogue's
 * `effort <level>` because the value is remembered rather than configured. The catalogue then
 * fills in the bases those rows did not already show, in catalogue order, so nothing is listed
 * twice and nothing that was listed before disappears.
 */
import { describe, expect, test } from "bun:test";
import type { PickerModelInput } from "@/tui/chat/picker-model";
import { pickerModel } from "@/tui/chat/picker-model";

const MODELS = ["a/x", "b/y", "c/z"] as const;

function model(extra: Partial<PickerModelInput> = {}) {
  return pickerModel({ kind: "model", models: MODELS, currentModel: "a/x", currentMode: "guarded", ...extra });
}

const values = (extra: Partial<PickerModelInput> = {}) => model(extra).entries.map((entry) => entry.value);
const row = (extra: Partial<PickerModelInput> = {}) => model(extra).entries.find((entry) => entry.value === "b/y");

describe("pickerModel recent rows", () => {
  test("AC-19 the recent row comes first, then the remaining catalogue rows in catalogue order", () => {
    expect(values({ recents: ["b/y[high]"] })).toEqual(["b/y", "a/x", "c/z"]);
  });

  test("AC-20 AC-21 AC-22 a recent row keeps its remembered effort, its stored id and its own detail", () => {
    expect(row({ recents: ["b/y[high]"] })).toMatchObject({
      effortLabel: "high",
      original: "b/y[high]",
      detail: "recent · effort high",
    });
  });

  test("recent rows are newest first and each base is listed once", () => {
    expect(values({ recents: ["c/z[low]", "b/y[high]", "c/z[max]", "b/y"] })).toEqual(["c/z", "b/y", "a/x"]);
  });

  test("AC-23 a recent whose base the host no longer offers produces no row", () => {
    expect(values({ recents: ["q/gone[high]", "b/y[high]"] })).toEqual(["b/y", "a/x", "c/z"]);
  });

  test("AC-24 a recent row on the session's own base is marked current", () => {
    const current = row({ recents: ["b/y[high]"], currentModel: "b/y[high]" });
    expect(current?.current).toBe(true);
    expect(row({ recents: ["b/y[high]"] })?.current).not.toBe(true);
    expect(model({ recents: ["b/y[high]"], currentModel: "b/y[high]" }).entries.filter((e) => e.current)).toHaveLength(
      1,
    );
  });

  test("a recent whose base is the current model still keeps the effort it was used at", () => {
    // The row is named by the list, not by the session: re-choosing it re-applies that effort.
    expect(row({ recents: ["b/y[low]"], currentModel: "b/y[high]" })).toMatchObject({
      current: true,
      original: "b/y[low]",
      effortLabel: "low",
    });
  });

  test("the note a recent row cannot use right now reads as the catalogue's does", () => {
    expect(row({ recents: ["b/y[high]"], modelNote: () => "not signed in" })?.detail).toBe(
      "unavailable: not signed in",
    );
  });

  test("a cycled effort wins over the remembered one", () => {
    const pending = new Map([["b/y", "low" as const]]);
    expect(row({ recents: ["b/y[high]"], pending })).toMatchObject({
      effortLabel: "low",
      detail: "recent · effort low",
    });
  });

  test("query matching still filters over the recent rows and their catalogue remainder", () => {
    expect(values({ recents: ["b/y[high]"], query: "z" })).toEqual(["c/z"]);
  });

  test("an empty recent list leaves the picker exactly as the catalogue builds it", () => {
    expect(model({ recents: [] }).entries).toEqual(model().entries);
  });

  test("AC-30 without recents the catalogue keeps its first-seen base order", () => {
    const entries = model({ models: ["a/x[low]", "b/y", "a/x[high]"], currentModel: "b/y[high]" });
    expect(entries.entries.map((entry) => entry.value)).toEqual(["a/x", "b/y"]);
  });

  test("AC-31 without recents the current model keeps the effort the session is on", () => {
    const entries = model({ models: ["a/x[low]", "b/y"], currentModel: "b/y[high]" });
    expect(entries.entries.find((entry) => entry.value === "b/y")).toMatchObject({
      original: "b/y[high]",
      effortLabel: "high",
      detail: "effort high",
      current: true,
    });
  });
});
