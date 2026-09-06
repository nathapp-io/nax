import { describe, expect, test } from "bun:test";
import type { NormalizeInput } from "@/tools/package-managers";
import { classifyExec, isKnownManager, normalizeExec } from "@/tools/package-managers";

const base: Omit<NormalizeInput, "argv" | "target"> = {
  repoRoot: "/repo",
  packageWorkdir: "/repo/packages/foo",
  packageRelPath: "packages/foo",
  packageName: "@acme/foo",
  allowScripts: false,
};

describe("classifyExec", () => {
  test("a known manager with an install verb is install-shaped", () => {
    expect(classifyExec(["bun", "add", "x"])).toBe("install");
    expect(classifyExec(["npm", "ci"])).toBe("install");
    expect(classifyExec(["go", "mod", "download"])).toBe("install");
  });

  test("a known manager with a non-install verb is generic", () => {
    // The second thing the 2026-09-06 run's model reached for. If this is
    // "install", no grant can ever permit it.
    expect(classifyExec(["bun", "x", "tsc", "--noEmit"])).toBe("generic");
    expect(classifyExec(["npm", "run", "build"])).toBe("generic");
  });

  test("an unknown binary is generic", () => {
    expect(classifyExec(["make", "build"])).toBe("generic");
  });
});

describe("normalizeExec — install-shaped", () => {
  test("appends the no-scripts flag and runs a package-target bun add in the package dir", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "add", "-d", "bun-types"], target: "package" })).toEqual({
      argv: ["bun", "add", "-d", "bun-types", "--ignore-scripts"],
      cwd: "/repo/packages/foo",
    });
  });

  test("runs a repoRoot-target bun add at the repo root", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "add", "-d", "bun-types"], target: "repoRoot" })).toEqual({
      argv: ["bun", "add", "-d", "bun-types", "--ignore-scripts"],
      cwd: "/repo",
    });
  });

  test("pnpm filters by PATH with the mandatory ./ prefix", () => {
    // Bare "packages/foo" is parsed by pnpm as a package NAME and silently
    // selects nothing. The ./ prefix is what makes it a path.
    expect(normalizeExec({ ...base, argv: ["pnpm", "add", "bun-types"], target: "package" })).toEqual({
      argv: ["pnpm", "--filter", "./packages/foo", "add", "bun-types", "--ignore-scripts"],
      cwd: "/repo",
    });
  });

  test("npm scopes with -w", () => {
    expect(normalizeExec({ ...base, argv: ["npm", "install", "-D", "bun-types"], target: "package" })).toEqual({
      argv: ["npm", "-w", "packages/foo", "install", "-D", "bun-types", "--ignore-scripts"],
      cwd: "/repo",
    });
  });

  test("yarn 1 takes the flag; yarn 2+ takes the environment variable", () => {
    const classic = normalizeExec({
      ...base,
      argv: ["yarn", "add", "bun-types"],
      target: "package",
      yarnMajor: 1,
    });
    expect(classic).toEqual({
      argv: ["yarn", "workspace", "@acme/foo", "add", "bun-types", "--ignore-scripts"],
      cwd: "/repo",
    });

    const berry = normalizeExec({
      ...base,
      argv: ["yarn", "add", "bun-types"],
      target: "package",
      yarnMajor: 4,
    });
    expect(berry).toEqual({
      argv: ["yarn", "workspace", "@acme/foo", "add", "bun-types"],
      cwd: "/repo",
      env: { YARN_ENABLE_SCRIPTS: "false" },
    });
  });

  test("yarn and cargo deny when the package name cannot be resolved", () => {
    const noName: Omit<NormalizeInput, "argv" | "target"> = { ...base, packageName: undefined };
    expect(normalizeExec({ ...noName, argv: ["yarn", "add", "x"], target: "package", yarnMajor: 4 })).toHaveProperty(
      "error",
    );
    expect(normalizeExec({ ...noName, argv: ["cargo", "add", "serde"], target: "package" })).toHaveProperty("error");
  });

  test("cargo scopes by NAME, not path", () => {
    expect(normalizeExec({ ...base, packageName: "foo", argv: ["cargo", "add", "serde"], target: "package" })).toEqual({
      argv: ["cargo", "add", "-p", "foo", "serde"],
      cwd: "/repo",
    });
  });

  test("adds no mechanism for managers that run no install scripts", () => {
    expect(normalizeExec({ ...base, argv: ["go", "mod", "download"], target: "package" })).toEqual({
      argv: ["go", "mod", "download"],
      cwd: "/repo/packages/foo",
    });
  });

  test("omits the no-scripts mechanism when the project opted in", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "add", "x"], target: "package", allowScripts: true })).toEqual({
      argv: ["bun", "add", "x"],
      cwd: "/repo/packages/foo",
    });
  });

  test("collapses both targets to one directory in a single-package repo", () => {
    const single: Omit<NormalizeInput, "argv" | "target" | "packageName"> = {
      repoRoot: "/repo",
      packageWorkdir: "/repo",
      packageRelPath: "",
      allowScripts: false,
    };
    expect(normalizeExec({ ...single, argv: ["bun", "add", "x"], target: "package" })).toEqual(
      normalizeExec({ ...single, argv: ["bun", "add", "x"], target: "repoRoot" }),
    );
  });
});

describe("normalizeExec — generic", () => {
  test("runs as given at the package dir, with no scoping and no mechanism", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "x", "tsc", "--noEmit"], target: "package" })).toEqual({
      argv: ["bun", "x", "tsc", "--noEmit"],
      cwd: "/repo/packages/foo",
    });
  });

  test("runs at the repo root when the target says so", () => {
    expect(normalizeExec({ ...base, argv: ["make", "build"], target: "repoRoot" })).toEqual({
      argv: ["make", "build"],
      cwd: "/repo",
    });
  });
});

describe("isKnownManager", () => {
  test("knows the eight managers and nothing else", () => {
    for (const binary of ["npm", "bun", "pnpm", "yarn", "pip", "uv", "go", "cargo"]) {
      expect(isKnownManager(binary)).toBe(true);
    }
    expect(isKnownManager("make")).toBe(false);
  });

  test("resolves case and executable-suffix variants to the same entry", () => {
    expect(isKnownManager("NPM")).toBe(true);
    expect(isKnownManager("npm.cmd")).toBe(true);
    expect(isKnownManager("npm.exe")).toBe(true);
    expect(isKnownManager("npx")).toBe(false);
  });
});

// Fix round 1 — Critical finding 1: fail-closed classification against a
// leading global flag, plus install-verb aliases (addendum finding A).
describe("classifyExec — install-verb aliases", () => {
  test("npm/pnpm/bun short aliases classify as install-shaped, same as the canonical verb", () => {
    expect(classifyExec(["npm", "i", "lodash"])).toBe("install");
    expect(classifyExec(["npm", "install-test"])).toBe("install");
    expect(classifyExec(["pnpm", "i", "lodash"])).toBe("install");
    expect(classifyExec(["bun", "a", "lodash"])).toBe("install");
  });
});

describe("classifyExec — fail-closed against a leading global flag", () => {
  test("a global flag ahead of the verb does not defeat classification", () => {
    expect(classifyExec(["npm", "--loglevel=silent", "install", "x"])).toBe("install");
    expect(classifyExec(["yarn", "--silent", "add", "x"])).toBe("install");
    expect(classifyExec(["bun", "-v", "add", "x"])).toBe("install");
  });

  test("a flag's own VALUE token is not mistaken for the verb — denied, not generic", () => {
    // "silent" (the value of --loglevel) is the first non-flag token; branch 1
    // misses. The real verb "install" appears later in argv, so branch 2
    // denies rather than letting this fall through to an unhardened install.
    expect(classifyExec(["npm", "--loglevel", "silent", "install", "x"])).toBe("deny");
  });

  test("ordinary calls are unaffected: install classifies install, generic classifies generic", () => {
    expect(classifyExec(["npm", "i", "-D", "x"])).toBe("install");
    expect(classifyExec(["bun", "x", "tsc", "--noEmit"])).toBe("generic");
  });
});

describe("normalizeExec — fail-closed denial surfaces as an error, not a silent install", () => {
  test("aliased verb still gets scoped and hardened", () => {
    expect(normalizeExec({ ...base, argv: ["npm", "i", "-D", "bun-types"], target: "package" })).toEqual({
      argv: ["npm", "-w", "packages/foo", "i", "-D", "bun-types", "--ignore-scripts"],
      cwd: "/repo",
    });
  });

  test("a global flag ahead of the verb still gets scoped and hardened", () => {
    expect(normalizeExec({ ...base, argv: ["npm", "--loglevel=silent", "install", "x"], target: "repoRoot" })).toEqual({
      argv: ["npm", "--loglevel=silent", "install", "x", "--ignore-scripts"],
      cwd: "/repo",
    });
  });

  test("the mis-anchored-verb shape denies with a reason naming the verb", () => {
    const result = normalizeExec({
      ...base,
      argv: ["npm", "--loglevel", "silent", "install", "x"],
      target: "package",
    });
    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error).toContain("install");
    }
  });
});

// Addendum finding B: argv[0] normalization, package runners, and disguised
// manager invocations via a dlx-style verb.
describe("classifyExec — wrapper and disguise denial", () => {
  test("package runners that execute an arbitrary package are denied, not generic", () => {
    expect(classifyExec(["npx", "cowsay", "hi"])).toBe("deny");
    expect(classifyExec(["bunx", "cowsay", "hi"])).toBe("deny");
    expect(classifyExec(["pnpx", "cowsay", "hi"])).toBe("deny");
  });

  test("a manager invocation laundered through a dlx-style verb is denied", () => {
    expect(classifyExec(["pnpm", "dlx", "npm", "install", "x"])).toBe("deny");
    expect(classifyExec(["yarn", "dlx", "bun", "add", "x"])).toBe("deny");
  });

  test("an ordinary dlx package run (not naming a known manager) stays generic", () => {
    expect(classifyExec(["pnpm", "dlx", "cowsay", "hello"])).toBe("generic");
  });

  test("argv[0] case and executable-suffix variants classify the same as the bare name", () => {
    expect(classifyExec(["npm.cmd", "install", "x"])).toBe("install");
    expect(classifyExec(["NPM", "install", "x"])).toBe("install");
  });
});

describe("normalizeExec — wrapper and disguise denial", () => {
  test("a package runner is denied", () => {
    expect(normalizeExec({ ...base, argv: ["npx", "cowsay", "hi"], target: "package" })).toHaveProperty("error");
  });

  test("a disguised manager invocation via dlx is denied", () => {
    expect(normalizeExec({ ...base, argv: ["pnpm", "dlx", "npm", "install", "x"], target: "package" })).toHaveProperty(
      "error",
    );
  });

  test("argv[0] executable-suffix variants still get scoped and hardened, argv[0] preserved verbatim", () => {
    expect(normalizeExec({ ...base, argv: ["npm.cmd", "install", "x"], target: "package" })).toEqual({
      argv: ["npm.cmd", "-w", "packages/foo", "install", "x", "--ignore-scripts"],
      cwd: "/repo",
    });
  });
});

// Fix round 1 — Critical finding 2 + addendum C: DENY rather than strip when
// the incoming argv already carries a workspace-scoping flag or a
// scripts-control flag.
describe("normalizeExec — scoping-flag smuggling is denied, not stripped", () => {
  test("npm -w naming another package is denied", () => {
    expect(
      normalizeExec({ ...base, argv: ["npm", "install", "-w", "other-pkg", "x"], target: "package" }),
    ).toHaveProperty("error");
  });

  test("pnpm --filter naming another path is denied", () => {
    expect(
      normalizeExec({ ...base, argv: ["pnpm", "add", "--filter", "./other", "x"], target: "package" }),
    ).toHaveProperty("error");
  });

  test("pnpm --include-workspace-root and --filter-prod are denied", () => {
    expect(
      normalizeExec({ ...base, argv: ["pnpm", "add", "--include-workspace-root", "x"], target: "package" }),
    ).toHaveProperty("error");
    expect(normalizeExec({ ...base, argv: ["pnpm", "add", "--filter-prod", "x"], target: "package" })).toHaveProperty(
      "error",
    );
  });

  test("cargo -p naming another package is denied even when a packageName is resolvable", () => {
    expect(
      normalizeExec({ ...base, packageName: "foo", argv: ["cargo", "add", "-p", "other", "serde"], target: "package" }),
    ).toHaveProperty("error");
  });

  test("uv --package and --all-packages are denied", () => {
    expect(
      normalizeExec({ ...base, argv: ["uv", "add", "--package", "other", "httpx"], target: "package" }),
    ).toHaveProperty("error");
    expect(normalizeExec({ ...base, argv: ["uv", "sync", "--all-packages"], target: "package" })).toHaveProperty(
      "error",
    );
  });

  test("case- and =-normalized matching catches a differently-spelled flag", () => {
    expect(
      normalizeExec({ ...base, argv: ["npm", "install", "--WORKSPACE=other-pkg", "x"], target: "package" }),
    ).toHaveProperty("error");
  });
});

describe("normalizeExec — scripts-control flag smuggling is denied, not stripped", () => {
  test("a model-supplied --ignore-scripts is denied even though it matches what we'd add ourselves", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "add", "--ignore-scripts", "x"], target: "package" })).toHaveProperty(
      "error",
    );
  });

  test("a model-supplied --no-ignore-scripts (defeating our hardening) is denied", () => {
    expect(
      normalizeExec({ ...base, argv: ["npm", "install", "--no-ignore-scripts", "x"], target: "package" }),
    ).toHaveProperty("error");
  });

  test("case- and =-normalized matching catches a differently-spelled scripts-control flag", () => {
    expect(
      normalizeExec({ ...base, argv: ["npm", "install", "--IGNORE-SCRIPTS=true", "x"], target: "package" }),
    ).toHaveProperty("error");
  });
});

// Important finding 3: uv's packageForm had no coverage.
describe("normalizeExec — uv packageForm", () => {
  test("uv add scopes with --package when a name resolves", () => {
    expect(normalizeExec({ ...base, packageName: "mypkg", argv: ["uv", "add", "httpx"], target: "package" })).toEqual({
      argv: ["uv", "add", "--package", "mypkg", "httpx"],
      cwd: "/repo",
    });
  });

  test("uv sync scopes with --package when a name resolves", () => {
    expect(normalizeExec({ ...base, packageName: "mypkg", argv: ["uv", "sync"], target: "package" })).toEqual({
      argv: ["uv", "sync", "--package", "mypkg"],
      cwd: "/repo",
    });
  });

  test("uv denies when no packageName resolves", () => {
    const noName: Omit<NormalizeInput, "argv" | "target"> = { ...base, packageName: undefined };
    expect(normalizeExec({ ...noName, argv: ["uv", "add", "httpx"], target: "package" })).toHaveProperty("error");
  });
});

// Fix round 2: directory-redirect flags defeat cwd containment. `target` is
// a closed enum precisely so no path can arrive from the model — a flag
// like bun's --cwd hands that choice straight back.
describe("normalizeExec — directory-redirect flags are denied, global scope", () => {
  test("bun --cwd is denied on an install-shaped call", () => {
    expect(
      normalizeExec({ ...base, argv: ["bun", "add", "--cwd", "/somewhere/else", "x"], target: "package" }),
    ).toHaveProperty("error");
  });

  test("bun --cwd is denied on a GENERIC call too — the containment property, not an install nicety", () => {
    expect(
      normalizeExec({ ...base, argv: ["bun", "x", "tsc", "--cwd", "/elsewhere"], target: "package" }),
    ).toHaveProperty("error");
  });

  test("yarn --cwd is denied", () => {
    expect(
      normalizeExec({ ...base, argv: ["yarn", "add", "--cwd", "/elsewhere", "x"], target: "package" }),
    ).toHaveProperty("error");
  });

  test("pnpm --dir and -C are denied", () => {
    expect(
      normalizeExec({ ...base, argv: ["pnpm", "add", "--dir", "/elsewhere", "x"], target: "package" }),
    ).toHaveProperty("error");
    expect(
      normalizeExec({ ...base, argv: ["pnpm", "add", "-C", "/elsewhere", "x"], target: "package" }),
    ).toHaveProperty("error");
  });

  test("cargo --manifest-path is denied", () => {
    expect(
      normalizeExec({
        ...base,
        packageName: "foo",
        argv: ["cargo", "add", "--manifest-path", "/elsewhere/Cargo.toml", "serde"],
        target: "package",
      }),
    ).toHaveProperty("error");
  });

  test("uv --directory and --project are denied", () => {
    expect(
      normalizeExec({
        ...base,
        packageName: "mypkg",
        argv: ["uv", "add", "--directory", "/elsewhere", "httpx"],
        target: "package",
      }),
    ).toHaveProperty("error");
    expect(
      normalizeExec({
        ...base,
        packageName: "mypkg",
        argv: ["uv", "add", "--project", "/elsewhere", "httpx"],
        target: "package",
      }),
    ).toHaveProperty("error");
  });

  test("go -C is denied", () => {
    expect(
      normalizeExec({ ...base, argv: ["go", "get", "-C", "/elsewhere", "example.com/pkg"], target: "package" }),
    ).toHaveProperty("error");
  });

  test("case- and =-normalized matching catches a differently-spelled directory-redirect flag", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "add", "--CWD=/elsewhere", "x"], target: "package" })).toHaveProperty(
      "error",
    );
  });
});

describe("normalizeExec — directory-redirect flags are denied, install-only scope", () => {
  test("pip --target and --root are denied on an install call", () => {
    expect(
      normalizeExec({ ...base, argv: ["pip", "install", "--target", "/elsewhere", "x"], target: "package" }),
    ).toHaveProperty("error");
    expect(
      normalizeExec({ ...base, argv: ["pip", "install", "--root", "/elsewhere", "x"], target: "package" }),
    ).toHaveProperty("error");
  });

  test("pip --python is denied even on a non-install pip call (it is global to pip)", () => {
    expect(
      normalizeExec({ ...base, argv: ["pip", "list", "--python", "/other/python"], target: "package" }),
    ).toHaveProperty("error");
  });
});

describe("normalizeExec — directory-redirect denial does not affect ordinary calls (both-sides rule)", () => {
  test("an ordinary bun add still classifies install-shaped and comes back hardened at the normalized cwd", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "add", "-d", "x"], target: "package" })).toEqual({
      argv: ["bun", "add", "-d", "x", "--ignore-scripts"],
      cwd: "/repo/packages/foo",
    });
  });

  test("an ordinary generic bun x call still classifies generic and returns unmodified", () => {
    expect(normalizeExec({ ...base, argv: ["bun", "x", "tsc", "--noEmit"], target: "package" })).toEqual({
      argv: ["bun", "x", "tsc", "--noEmit"],
      cwd: "/repo/packages/foo",
    });
  });
});

// Fix round 3, finding 1: pip's -t short alias for --target was unscreened.
describe("normalizeExec — pip -t short alias is denied", () => {
  test("pip install -t is denied like --target", () => {
    expect(
      normalizeExec({ ...base, argv: ["pip", "install", "-t", "/elsewhere", "x"], target: "package" }),
    ).toHaveProperty("error");
  });
});

// Fix round 3, finding 2: yarn's global screen missed -C (added for
// symmetry with pnpm; not confirmed as documented yarn syntax, but an
// over-denial is the safe direction).
describe("normalizeExec — yarn -C is denied for symmetry with pnpm", () => {
  test("yarn -C is denied", () => {
    expect(
      normalizeExec({ ...base, argv: ["yarn", "add", "-C", "/elsewhere", "x"], target: "package" }),
    ).toHaveProperty("error");
  });
});

// Fix round 3, finding 3: uv pip <anything> is a manager nested inside a
// manager — denied at classification time rather than falling through to
// generic (no directory screen, no no-scripts mechanism) or being
// recognized as install-shaped by borrowing pip's semantics.
describe("classifyExec / normalizeExec — uv pip nesting is denied", () => {
  test("uv pip install is denied, not generic", () => {
    expect(classifyExec(["uv", "pip", "install", "--target", "/elsewhere", "x"])).toBe("deny");
    expect(
      normalizeExec({
        ...base,
        argv: ["uv", "pip", "install", "--target", "/elsewhere", "x"],
        target: "package",
      }),
    ).toHaveProperty("error");
  });

  test("a global flag ahead of the nested pip does not defeat the denial", () => {
    expect(classifyExec(["uv", "--quiet", "pip", "install", "x"])).toBe("deny");
  });

  test("uv pip with no further args is still denied", () => {
    expect(classifyExec(["uv", "pip"])).toBe("deny");
  });

  test("both-sides rule: an ordinary uv add still classifies install-shaped and hardens", () => {
    expect(classifyExec(["uv", "add", "x"])).toBe("install");
    expect(normalizeExec({ ...base, packageName: "mypkg", argv: ["uv", "add", "x"], target: "package" })).toEqual({
      argv: ["uv", "add", "--package", "mypkg", "x"],
      cwd: "/repo",
    });
  });

  test("both-sides rule: an ordinary generic bun x call still classifies generic and is unmodified", () => {
    expect(classifyExec(["bun", "x", "tsc", "--noEmit"])).toBe("generic");
    expect(normalizeExec({ ...base, argv: ["bun", "x", "tsc", "--noEmit"], target: "package" })).toEqual({
      argv: ["bun", "x", "tsc", "--noEmit"],
      cwd: "/repo/packages/foo",
    });
  });
});
