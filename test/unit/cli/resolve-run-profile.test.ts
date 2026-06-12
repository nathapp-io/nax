import { describe, expect, test } from "bun:test";
import { resolveRunProfileOverride } from "@/cli";

const readReturning = (value: unknown) => () => Promise.resolve(value);
const profilesAvailable = (...names: string[]) => () => Promise.resolve(names);

describe("resolveRunProfileOverride", () => {
  test("CLI --profile wins over PRD routingProfile", async () => {
    const result = await resolveRunProfileOverride({
      prdPath: "/x/prd.json",
      projectRoot: "/x",
      cliProfile: "cli-prof",
      envProfile: undefined,
      _readJson: readReturning({ routingProfile: "prd-prof" }),
      _listProfileNames: profilesAvailable("prd-prof"),
    });
    expect(result).toBe("cli-prof");
  });

  test("NAX_PROFILE env defers to loadConfig (returns undefined, does not read PRD)", async () => {
    let read = false;
    const result = await resolveRunProfileOverride({
      prdPath: "/x/prd.json",
      projectRoot: "/x",
      cliProfile: undefined,
      envProfile: "env-prof",
      _readJson: () => {
        read = true;
        return Promise.resolve({ routingProfile: "prd-prof" });
      },
      _listProfileNames: profilesAvailable("prd-prof"),
    });
    expect(result).toBeUndefined();
    expect(read).toBe(false);
  });

  test("adopts PRD routingProfile when neither CLI nor env is set and the profile exists", async () => {
    const result = await resolveRunProfileOverride({
      prdPath: "/x/prd.json",
      projectRoot: "/x",
      cliProfile: undefined,
      envProfile: undefined,
      _readJson: readReturning({ routingProfile: "aggressive" }),
      _listProfileNames: profilesAvailable("aggressive", "cheap"),
    });
    expect(result).toBe("aggressive");
  });

  test('adopts "default" without consulting the profile list (loader applies no overlay)', async () => {
    const result = await resolveRunProfileOverride({
      prdPath: "/x/prd.json",
      projectRoot: "/x",
      cliProfile: undefined,
      envProfile: undefined,
      _readJson: readReturning({ routingProfile: "default" }),
      _listProfileNames: profilesAvailable(), // empty — must not matter
    });
    expect(result).toBe("default");
  });

  test("skips adoption (returns undefined) when the PRD profile has no profile file — stale/legacy value", async () => {
    const result = await resolveRunProfileOverride({
      prdPath: "/x/prd.json",
      projectRoot: "/x",
      cliProfile: undefined,
      envProfile: undefined,
      _readJson: readReturning({ routingProfile: "oc-balanced" }), // legacy agent-profile id
      _listProfileNames: profilesAvailable("aggressive"),
    });
    expect(result).toBeUndefined();
  });

  test.each([
    ["missing PRD", undefined],
    ["PRD without routingProfile", {}],
    ["non-string routingProfile", { routingProfile: 42 }],
    ["empty-string routingProfile", { routingProfile: "" }],
  ])("returns undefined for %s", async (_label, prdValue) => {
    const result = await resolveRunProfileOverride({
      prdPath: "/x/prd.json",
      projectRoot: "/x",
      cliProfile: undefined,
      envProfile: undefined,
      _readJson: readReturning(prdValue),
      _listProfileNames: profilesAvailable("aggressive"),
    });
    expect(result).toBeUndefined();
  });

  test("returns undefined when the PRD read throws (corrupt JSON)", async () => {
    const result = await resolveRunProfileOverride({
      prdPath: "/x/prd.json",
      projectRoot: "/x",
      cliProfile: undefined,
      envProfile: undefined,
      _readJson: () => Promise.reject(new Error("bad json")),
      _listProfileNames: profilesAvailable("aggressive"),
    });
    expect(result).toBeUndefined();
  });
});
