import { afterEach, describe, expect, test } from "bun:test";
import { makeFinishState, restoreFinishMachineStubs } from "@test/helpers";
import { _finishGitDeps, _reviewInputsDeps, loadReviewInputs, storiesFromText } from "@/finish";

const originalGit = _finishGitDeps.git;
const originalRead = _reviewInputsDeps.readText;
afterEach(() => {
  _finishGitDeps.git = originalGit;
  _reviewInputsDeps.readText = originalRead;
  restoreFinishMachineStubs();
});

describe("storiesFromText", () => {
  test("maps userStories to id and title, dropping acceptance criteria", () => {
    const text = JSON.stringify({
      userStories: [
        { id: "US-001", title: "Add login", acceptanceCriteria: ["a", "b"] },
        { id: "US-002", title: "Add logout" },
      ],
    });
    expect(storiesFromText(text)).toEqual([
      { id: "US-001", title: "Add login" },
      { id: "US-002", title: "Add logout" },
    ]);
  });

  test("a story row with a missing or non-string id or title is dropped, the rest kept", () => {
    const text = JSON.stringify({
      userStories: [{ id: 7, title: "x" }, { id: "US-1" }, null, { id: "US-2", title: "ok" }],
    });
    expect(storiesFromText(text)).toEqual([{ id: "US-2", title: "ok" }]);
  });

  test.each([
    ["a missing PRD", null],
    ["invalid JSON", "{ not json"],
    ["JSON without userStories", "{}"],
    ["userStories that is not a list", '{"userStories":"nope"}'],
    ["a JSON scalar", "42"],
  ])("%s gives no stories", (_name, text) => {
    expect(storiesFromText(text)).toEqual([]);
  });
});

describe("loadReviewInputs", () => {
  test("reads the diff's files, the feature's PRD stories and a repo-relative prdPath", async () => {
    _finishGitDeps.git = async (args) => ({
      exitCode: 0,
      stdout: args[0] === "diff" ? "src/a.ts\nsrc/b.ts\n" : "",
      stderr: "",
    });
    let readPath = "";
    _reviewInputsDeps.readText = async (path) => {
      readPath = path;
      return JSON.stringify({ userStories: [{ id: "US-1", title: "One" }] });
    };
    const inputs = await loadReviewInputs(makeFinishState(), undefined);

    expect(inputs.changed).toEqual(["src/a.ts", "src/b.ts"]);
    expect(inputs.stories).toEqual([{ id: "US-1", title: "One" }]);
    expect(inputs.hints).toEqual([]);
    expect(inputs.prdPath).toBe(".nax/features/feat/prd.json");
    expect(readPath).toBe("/repo/.nax/features/feat/prd.json");
  });

  test("a missing PRD and a failing diff degrade to empty inputs", async () => {
    _finishGitDeps.git = async () => ({ exitCode: 128, stdout: "", stderr: "fatal" });
    _reviewInputsDeps.readText = async () => null;
    const inputs = await loadReviewInputs(makeFinishState(), undefined);
    expect(inputs).toEqual({ changed: [], stories: [], hints: [], prdPath: ".nax/features/feat/prd.json" });
  });
});
