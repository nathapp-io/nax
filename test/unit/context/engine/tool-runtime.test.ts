import { describe, expect, test } from "bun:test";
import { contextToolRuntimeConfigSelector } from "../../../../src/config";
import type { ContextToolRuntimeConfig } from "../../../../src/config/selectors";
import { createContextToolRuntime } from "../../../../src/context/engine";
import type { ContextBundle } from "../../../../src/context/engine";
import { makeNaxConfig } from "../../../helpers/mock-nax-config";

describe("createContextToolRuntime — slice acceptance", () => {
  test("contextToolRuntimeConfigSelector picks context, execution, project, quality", () => {
    const full = makeNaxConfig();
    const sliced = contextToolRuntimeConfigSelector.select(full);
    expect(Object.keys(sliced).sort()).toEqual(["context", "execution", "project", "quality"]);
  });

  test("createContextToolRuntime accepts a ContextToolRuntimeConfig slice (no NaxConfig cast)", () => {
    const config: ContextToolRuntimeConfig = {
      context: undefined,
      execution: undefined,
      project: undefined,
      quality: undefined,
    };
    const emptyBundle: ContextBundle = {
      pushMarkdown: "",
      pullTools: [],
      meta: { stage: "test", schemaVersion: 1, totalTokens: 0 },
    } as unknown as ContextBundle;
    const story = { id: "S-001", workdir: "" } as Parameters<typeof createContextToolRuntime>[0]["story"];
    const runtime = createContextToolRuntime({
      bundle: emptyBundle,
      story,
      config,
      repoRoot: "/tmp",
    });
    expect(runtime).toBeUndefined();
  });
});
