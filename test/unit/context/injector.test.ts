/**
 * Unit tests for src/context/injector.ts — language detection and metadata
 * formatting for `nax generate`.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeNaxConfig, withTempDir } from "@test/helpers";
import { buildProjectMetadata, formatMetadataSection } from "@/context/injector";

describe("buildProjectMetadata", () => {
  test("detects Go from go.mod with a require block", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "go.mod"),
        [
          "module github.com/example/thing",
          "",
          "go 1.21",
          "",
          "require (",
          "\tgithub.com/foo/bar v1.0.0",
          "\tgithub.com/baz/qux v2.0.0 // indirect",
          ")",
        ].join("\n"),
      );
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.name).toBe("github.com/example/thing");
      expect(meta.language).toBe("Go");
      expect(meta.dependencies).toEqual(["bar"]);
    });
  });

  test("Go detector returns null on unreadable go.mod (caught, falls through)", async () => {
    await withTempDir(async (dir) => {
      // Directory named go.mod instead of a file — Bun.file().text() rejects.
      await Bun.write(join(dir, "go.mod", "placeholder"), "x");
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "fallback-pkg" }));
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.language).toBe("JavaScript");
      expect(meta.name).toBe("fallback-pkg");
    });
  });

  test("detects Rust from Cargo.toml", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "Cargo.toml"),
        [
          "[package]",
          'name = "my-rust-app"',
          'version = "0.1.0"',
          "",
          "[dependencies]",
          'serde = "1.0"',
          "# a comment",
          'tokio = "1"',
        ].join("\n"),
      );
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.language).toBe("Rust");
      expect(meta.name).toBe("my-rust-app");
      expect(meta.dependencies).toEqual(["serde", "tokio"]);
    });
  });

  test("detects Python from pyproject.toml with a dependencies array", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "pyproject.toml"),
        ["[project]", 'name = "my-python-app"', "dependencies = [", '  "requests>=2.0",', '  "click",', "]"].join("\n"),
      );
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.language).toBe("Python");
      expect(meta.name).toBe("my-python-app");
      // The quote-stripping regex removes from the leading quote onward, so a
      // quoted TOML array (the only valid TOML form) always yields an empty
      // list here — this pins that documented quirk, not an aspiration.
      expect(meta.dependencies).toEqual([]);
    });
  });

  test("detects Python from requirements.txt when pyproject.toml is absent", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "requirements.txt"), ["requests==2.0", "# comment", "click>=8.0", ""].join("\n"));
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.language).toBe("Python");
      expect(meta.name).toBeUndefined();
      expect(meta.dependencies).toEqual(["requests", "click"]);
    });
  });

  test("detects PHP from composer.json, excluding the php entry itself", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "composer.json"),
        JSON.stringify({
          name: "vendor/my-php-app",
          require: { php: ">=8.0", "monolog/monolog": "^2.0" },
          "require-dev": { "phpunit/phpunit": "^9.0" },
        }),
      );
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.language).toBe("PHP");
      expect(meta.name).toBe("vendor/my-php-app");
      expect(meta.dependencies).toEqual(["monolog", "phpunit"]);
    });
  });

  test("detects Ruby from Gemfile", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "Gemfile"),
        ['source "https://rubygems.org"', "", 'gem "rails"', "gem 'pg'"].join("\n"),
      );
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.language).toBe("Ruby");
      expect(meta.name).toBeUndefined();
      expect(meta.dependencies).toEqual(["rails", "pg"]);
    });
  });

  test("detects Java from pom.xml", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "pom.xml"),
        [
          "<project>",
          "  <artifactId>my-java-app</artifactId>",
          "  <dependencies>",
          "    <dependency><artifactId>spring-core</artifactId></dependency>",
          "  </dependencies>",
          "</project>",
        ].join("\n"),
      );
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.language).toBe("Java");
      expect(meta.name).toBe("my-java-app");
      expect(meta.dependencies).toEqual(["spring-core"]);
    });
  });

  test("detects Kotlin from pom.xml when src/main/kotlin exists", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "src/main/kotlin/.gitkeep"), "");
      await Bun.write(
        join(dir, "pom.xml"),
        ["<project>", "  <artifactId>my-kt-app</artifactId>", "</project>"].join("\n"),
      );
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.language).toBe("Kotlin");
    });
  });

  test("detects Java from build.gradle when pom.xml is absent", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "build.gradle"),
        ["dependencies {", "    implementation 'org.springframework:spring-core:5.3.0'", "}"].join("\n"),
      );
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.language).toBe("Java");
      expect(meta.dependencies).toEqual(["spring-core"]);
    });
  });

  test("detects Kotlin from build.gradle.kts", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "build.gradle.kts"),
        ["dependencies {", '    implementation("com.example:lib:1.0")', "}"].join("\n"),
      );
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.language).toBe("Kotlin");
    });
  });

  test("detects Node/TypeScript from package.json with typescript devDependency", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({
          name: "my-ts-app",
          dependencies: { react: "^18.0.0" },
          devDependencies: { typescript: "^5.0.0", jest: "^29.0.0" },
        }),
      );
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.language).toBe("TypeScript");
      expect(meta.name).toBe("my-ts-app");
      expect(meta.dependencies).toContain("react");
      expect(meta.dependencies).toContain("jest");
    });
  });

  test("detects Node/JavaScript from package.json without typescript", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ name: "my-js-app", dependencies: { express: "^4.0.0" } }),
      );
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.language).toBe("JavaScript");
      expect(meta.dependencies).toEqual(["express"]);
    });
  });

  test("returns undefined language/name and empty dependencies when no manifest is found", async () => {
    await withTempDir(async (dir) => {
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.name).toBeUndefined();
      expect(meta.language).toBeUndefined();
      expect(meta.dependencies).toEqual([]);
    });
  });

  test("package.json detector returns null and falls through on malformed JSON", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "package.json"), "{not valid json");
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.language).toBeUndefined();
      expect(meta.dependencies).toEqual([]);
    });
  });

  test("populates testCommand/lintCommand/typecheckCommand from config.quality.commands", async () => {
    await withTempDir(async (dir) => {
      const config = makeNaxConfig({
        quality: { commands: { test: "bun run test", lint: "bun run lint", typecheck: "bun run typecheck" } },
      });
      const meta = await buildProjectMetadata(dir, config);
      expect(meta.testCommand).toBe("bun run test");
      expect(meta.lintCommand).toBe("bun run lint");
      expect(meta.typecheckCommand).toBe("bun run typecheck");
    });
  });

  test("Go detection takes priority over Node when both manifests are present", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "go.mod"), "module github.com/example/priority\n");
      await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "should-not-win" }));
      const meta = await buildProjectMetadata(dir, makeNaxConfig());
      expect(meta.language).toBe("Go");
      expect(meta.name).toBe("github.com/example/priority");
    });
  });
});

describe("formatMetadataSection", () => {
  test("includes name, language, dependencies and all three commands when present", () => {
    const section = formatMetadataSection({
      name: "my-app",
      language: "TypeScript",
      dependencies: ["react", "zod"],
      testCommand: "bun run test",
      lintCommand: "bun run lint",
      typecheckCommand: "bun run typecheck",
    });
    expect(section).toContain("**Project:** `my-app`");
    expect(section).toContain("**Language:** TypeScript");
    expect(section).toContain("**Key dependencies:** react, zod");
    expect(section).toContain("test: `bun run test`");
    expect(section).toContain("lint: `bun run lint`");
    expect(section).toContain("typecheck: `bun run typecheck`");
    expect(section).toContain("## Project Metadata");
  });

  test("omits sections whose fields are absent", () => {
    const section = formatMetadataSection({
      name: undefined,
      language: undefined,
      dependencies: [],
      testCommand: undefined,
      lintCommand: undefined,
      typecheckCommand: undefined,
    });
    expect(section).not.toContain("**Project:**");
    expect(section).not.toContain("**Language:**");
    expect(section).not.toContain("**Key dependencies:**");
    expect(section).not.toContain("**Commands:**");
    expect(section).toContain("## Project Metadata");
  });

  test("includes only the commands that are present", () => {
    const section = formatMetadataSection({
      name: undefined,
      language: undefined,
      dependencies: [],
      testCommand: "bun run test",
      lintCommand: undefined,
      typecheckCommand: undefined,
    });
    expect(section).toContain("**Commands:** test: `bun run test`");
    expect(section).not.toContain("lint:");
    expect(section).not.toContain("typecheck:");
  });
});
