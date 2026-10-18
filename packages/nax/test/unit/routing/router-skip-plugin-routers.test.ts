import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { makeDispatchContext } from "@test/helpers/dispatch-context";
import { makeStory } from "@test/helpers/mock-story";
import { DEFAULT_CONFIG } from "@/config";
import { PluginRegistry } from "@/plugins/registry";
import { type RoutingDecision, resolveRouting } from "@/routing";

afterEach(() => mock.restore());
test.each([true, false, undefined])("AC-16 AC-17 skipPluginRouters=%s", async (skip) => {
  const plugins = new PluginRegistry([]);
  const decision: RoutingDecision = {
    complexity: "expert",
    modelTier: "powerful",
    testStrategy: "three-session-tdd",
    reasoning: "plugin",
  };
  const route = mock(() => decision);
  spyOn(plugins, "getRouters").mockReturnValue([{ name: "legacy", route }]);
  const story = makeStory({ title: "Fix typo", description: "Correct spelling" });
  const context = makeDispatchContext();
  const result =
    skip === undefined
      ? await resolveRouting(story, DEFAULT_CONFIG, plugins, context)
      : await resolveRouting(story, DEFAULT_CONFIG, plugins, context, { skipPluginRouters: skip });
  expect(route).toHaveBeenCalledTimes(skip === true ? 0 : 1);
  if (skip === true) {
    expect(result).toEqual(await resolveRouting(story, DEFAULT_CONFIG, undefined, context));
    expect(plugins.getRouters).not.toHaveBeenCalled();
  } else expect(result).toEqual(decision);
});
