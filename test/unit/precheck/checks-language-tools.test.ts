/**
 * Unit tests for checkLanguageTools — language tool availability checks (US-005)
 *
 * Tests the language tool detection check which warns when required binaries
 * for a detected language are missing. Non-blocking: run continues regardless.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { ProjectProfile } from "../../../src/config/runtime-types";
import { checkLanguageTools, _languageToolsDeps } from "../../../src/precheck/checks-warnings";

describe("checkLanguageTools", () => {
  let originalWhich: typeof Bun.which;

  beforeEach(() => {
    originalWhich = _languageToolsDeps.which;
  });

  afterEach(() => {
    _languageToolsDeps.which = originalWhich;
  });

  test("returns passed: true when profile is undefined (no warning)", async () => {
    const check = await checkLanguageTools(undefined, "/tmp/workdir");
    expect(check.passed).toBe(true);
    expect(check.tier).toBe("warning");
    expect(check.name).toBe("language-tools-available");
  });

  test("returns passed: true when language is unsupported", async () => {
    const profile: ProjectProfile = { language: "kotlin" };
    const check = await checkLanguageTools(profile, "/tmp/workdir");
    expect(check.passed).toBe(true);
    expect(check.message).toContain("language not checked");
  });

  describe("Go language checks", () => {
    test("returns passed: true when both go and golangci-lint are found", async () => {
      _languageToolsDeps.which = async (name: string) => {
        if (name === "go" || name === "golangci-lint") return `/usr/bin/${name}`;
        return null;
      };

      const profile: ProjectProfile = { language: "go" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(true);
      expect(check.message).toContain("go");
    });

    test("returns passed: false when golangci-lint is missing", async () => {
      _languageToolsDeps.which = async (name: string) => {
        if (name === "go") return `/usr/bin/${name}`;
        return null; // golangci-lint not found
      };

      const profile: ProjectProfile = { language: "go" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(false);
      expect(check.tier).toBe("warning");
      expect(check.message).toContain("golangci-lint");
      expect(check.message).toContain("install");
    });

    test("returns passed: false when go itself is missing", async () => {
      _languageToolsDeps.which = async () => null; // no tools found

      const profile: ProjectProfile = { language: "go" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(false);
      expect(check.message).toContain("go");
    });

    test("install hint message for go includes brew or apt-get", async () => {
      _languageToolsDeps.which = async () => null;

      const profile: ProjectProfile = { language: "go" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.message).toMatch(/brew|apt-get|dnf|pacman/);
    });
  });

  describe("Python language checks", () => {
    test("returns passed: true when python3, pytest, and ruff are found", async () => {
      _languageToolsDeps.which = async (name: string) => {
        if (["python3", "pytest", "ruff"].includes(name)) return `/usr/bin/${name}`;
        return null;
      };

      const profile: ProjectProfile = { language: "python" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(true);
    });

    test("returns passed: true when python (not python3) is found with pytest and ruff", async () => {
      _languageToolsDeps.which = async (name: string) => {
        if (name === "python3") return null;
        if (["python", "pytest", "ruff"].includes(name)) return `/usr/bin/${name}`;
        return null;
      };

      const profile: ProjectProfile = { language: "python" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(true);
    });

    test("returns passed: false when pytest is missing", async () => {
      _languageToolsDeps.which = async (name: string) => {
        if (name === "python3") return `/usr/bin/${name}`;
        return null;
      };

      const profile: ProjectProfile = { language: "python" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(false);
      expect(check.message).toContain("pytest");
    });

    test("returns passed: false when ruff is missing", async () => {
      _languageToolsDeps.which = async (name: string) => {
        if (["python3", "pytest"].includes(name)) return `/usr/bin/${name}`;
        return null;
      };

      const profile: ProjectProfile = { language: "python" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(false);
      expect(check.message).toContain("ruff");
    });

    test("returns passed: false when both python versions are missing", async () => {
      _languageToolsDeps.which = async () => null;

      const profile: ProjectProfile = { language: "python" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(false);
      expect(check.message).toContain("python");
    });
  });

  describe("Rust language checks", () => {
    test("returns passed: true when cargo and rustfmt are found", async () => {
      _languageToolsDeps.which = async (name: string) => {
        if (["cargo", "rustfmt"].includes(name)) return `/usr/bin/${name}`;
        return null;
      };

      const profile: ProjectProfile = { language: "rust" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(true);
    });

    test("returns passed: false when rustfmt is missing", async () => {
      _languageToolsDeps.which = async (name: string) => {
        if (name === "cargo") return `/usr/bin/${name}`;
        return null;
      };

      const profile: ProjectProfile = { language: "rust" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(false);
      expect(check.message).toContain("rustfmt");
    });
  });

  describe("Ruby language checks", () => {
    test("returns passed: true when ruby and rubocop are found", async () => {
      _languageToolsDeps.which = async (name: string) => {
        if (["ruby", "rubocop"].includes(name)) return `/usr/bin/${name}`;
        return null;
      };

      const profile: ProjectProfile = { language: "ruby" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(true);
    });

    test("returns passed: false when rubocop is missing", async () => {
      _languageToolsDeps.which = async (name: string) => {
        if (name === "ruby") return `/usr/bin/${name}`;
        return null;
      };

      const profile: ProjectProfile = { language: "ruby" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(false);
      expect(check.message).toContain("rubocop");
    });
  });

  describe("Java language checks", () => {
    test("returns passed: true when java and mvn are found", async () => {
      _languageToolsDeps.which = async (name: string) => {
        if (["java", "mvn"].includes(name)) return `/usr/bin/${name}`;
        return null;
      };

      const profile: ProjectProfile = { language: "java" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(true);
    });

    test("returns passed: true when java and gradle are found (instead of mvn)", async () => {
      _languageToolsDeps.which = async (name: string) => {
        if (["java", "gradle"].includes(name)) return `/usr/bin/${name}`;
        return null;
      };

      const profile: ProjectProfile = { language: "java" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(true);
    });

    test("returns passed: false when neither mvn nor gradle are found", async () => {
      _languageToolsDeps.which = async (name: string) => {
        if (name === "java") return `/usr/bin/${name}`;
        return null;
      };

      const profile: ProjectProfile = { language: "java" };
      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.passed).toBe(false);
      expect(check.message).toContain("mvn");
      expect(check.message).toContain("gradle");
    });
  });

  describe("Check structure", () => {
    test("check has name 'language-tools-available'", async () => {
      const profile: ProjectProfile = { language: "go" };
      _languageToolsDeps.which = async (name: string) => {
        if (["go", "golangci-lint"].includes(name)) return `/usr/bin/${name}`;
        return null;
      };

      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.name).toBe("language-tools-available");
    });

    test("check tier is 'warning'", async () => {
      const profile: ProjectProfile = { language: "go" };
      _languageToolsDeps.which = async () => null;

      const check = await checkLanguageTools(profile, "/tmp/workdir");
      expect(check.tier).toBe("warning");
    });
  });
});
