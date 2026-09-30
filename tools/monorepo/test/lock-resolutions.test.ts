// tools/monorepo/test/lock-resolutions.test.ts
import { describe, expect, test } from "bun:test";
import { diffExternalResolutions, externalResolutions } from "../lib/lock-resolutions";

const LOCK = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": { "": { "name": "@nathapp/nax" } },
  "packages": {
    "zod": ["zod@4.1.0", "", {}, "sha512-x"],
    "@nathapp/nax-ai": ["@nathapp/nax-ai@workspace:packages/nax-ai"],
    "react": ["react@19.1.0", "", {}, "sha512-y"],
  }
}
`;

describe("lock resolutions", () => {
  test("extracts non-workspace name@version, sorted", () => {
    expect(externalResolutions(LOCK)).toEqual(["react@19.1.0", "zod@4.1.0"]);
  });
  test("diff reports added and removed", () => {
    expect(diffExternalResolutions(["a@1", "b@1"], ["b@1", "c@2"])).toEqual({ added: ["c@2"], removed: ["a@1"] });
  });
});
