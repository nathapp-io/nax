/**
 * Tier 1 — Python framework config parsers (pytest): pyproject.toml and
 * pytest.ini / setup.cfg extraction, including the shared exclude-dir filter.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { parsePyprojectToml, parsePytestIni } from "@/test-runners/detect/framework-configs-python";

describe("parsePyprojectToml", () => {
  test("returns null when pyproject.toml does not exist", async () => {
    await withTempDir(async (dir) => {
      expect(await parsePyprojectToml(dir)).toBeNull();
    });
  });

  test("returns null when pyproject.toml exists but has no pytest ini_options section", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pyproject.toml"), '[tool.poetry]\nname = "x"\n');
      expect(await parsePyprojectToml(dir)).toBeNull();
    });
  });

  test("returns null when the TOML is malformed", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pyproject.toml"), "not [ valid = toml {{{");
      expect(await parsePyprojectToml(dir)).toBeNull();
    });
  });

  test("extracts testpaths as **/*.py globs", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pyproject.toml"), '[tool.pytest.ini_options]\ntestpaths = ["tests", "src"]\n');
      const result = await parsePyprojectToml(dir);
      expect(result).toEqual({
        type: "framework-config",
        framework: "pytest",
        path: join(dir, "pyproject.toml"),
        patterns: ["tests/**/*.py", "src/**/*.py"],
      });
    });
  });

  test("extracts python_files as an array of literal patterns", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "pyproject.toml"),
        '[tool.pytest.ini_options]\npython_files = ["test_*.py", "check_*.py"]\n',
      );
      const result = await parsePyprojectToml(dir);
      expect(result?.patterns).toEqual(["test_*.py", "check_*.py"]);
    });
  });

  test("extracts python_files given as a single string", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pyproject.toml"), '[tool.pytest.ini_options]\npython_files = "test_*.py"\n');
      const result = await parsePyprojectToml(dir);
      expect(result?.patterns).toEqual(["test_*.py"]);
    });
  });

  test("falls back to default pytest patterns when ini_options exists but declares nothing", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pyproject.toml"), '[tool.pytest.ini_options]\naddopts = "-v"\n');
      const result = await parsePyprojectToml(dir);
      expect(result?.patterns).toEqual(["test_*.py", "*_test.py"]);
    });
  });

  test("reads the legacy tool.'pytest.ini_options' key form", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pyproject.toml"), '[tool."pytest.ini_options"]\ntestpaths = ["tests"]\n');
      const result = await parsePyprojectToml(dir);
      expect(result?.patterns).toEqual(["tests/**/*.py"]);
    });
  });

  test("filters excluded directories out of testpaths-derived patterns", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "pyproject.toml"),
        '[tool.pytest.ini_options]\ntestpaths = ["tests", "node_modules"]\n',
      );
      const result = await parsePyprojectToml(dir);
      expect(result?.patterns).toEqual(["tests/**/*.py"]);
    });
  });

  test("ignores non-string entries in testpaths and python_files arrays", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "pyproject.toml"),
        "[tool.pytest.ini_options]\ntestpaths = [1, 2]\npython_files = [3]\n",
      );
      const result = await parsePyprojectToml(dir);
      // Both arrays produced zero string entries — falls back to defaults.
      expect(result?.patterns).toEqual(["test_*.py", "*_test.py"]);
    });
  });
});

describe("parsePytestIni", () => {
  test("returns null when neither pytest.ini nor setup.cfg exist", async () => {
    await withTempDir(async (dir) => {
      expect(await parsePytestIni(dir)).toBeNull();
    });
  });

  test("returns null when pytest.ini exists but has no [pytest]/[tool:pytest] section", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pytest.ini"), "[not-pytest]\nfoo = bar\n");
      expect(await parsePytestIni(dir)).toBeNull();
    });
  });

  test("extracts testpaths and python_files from a [pytest] section in pytest.ini", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pytest.ini"), "[pytest]\ntestpaths = tests src\npython_files = test_*.py *_test.py\n");
      const result = await parsePytestIni(dir);
      expect(result).toEqual({
        type: "framework-config",
        framework: "pytest",
        path: join(dir, "pytest.ini"),
        patterns: ["tests/**/*.py", "src/**/*.py", "test_*.py", "*_test.py"],
      });
    });
  });

  test("falls back to default patterns when the [pytest] section declares neither key", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pytest.ini"), "[pytest]\naddopts = -v\n");
      const result = await parsePytestIni(dir);
      expect(result?.patterns).toEqual(["test_*.py", "*_test.py"]);
    });
  });

  test("reads a [tool:pytest] section from setup.cfg when pytest.ini is absent", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "setup.cfg"), "[tool:pytest]\ntestpaths = tests\n");
      const result = await parsePytestIni(dir);
      expect(result).toEqual({
        type: "framework-config",
        framework: "pytest",
        path: join(dir, "setup.cfg"),
        patterns: ["tests/**/*.py"],
      });
    });
  });

  test("falls through pytest.ini (no matching section) to a valid setup.cfg", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pytest.ini"), "[not-pytest]\nfoo = bar\n");
      await Bun.write(join(dir, "setup.cfg"), "[tool:pytest]\ntestpaths = tests\n");
      const result = await parsePytestIni(dir);
      expect(result?.path).toBe(join(dir, "setup.cfg"));
    });
  });

  test("filters excluded directories out of testpaths-derived patterns", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "pytest.ini"), "[pytest]\ntestpaths = tests .git\n");
      const result = await parsePytestIni(dir);
      expect(result?.patterns).toEqual(["tests/**/*.py"]);
    });
  });
});
