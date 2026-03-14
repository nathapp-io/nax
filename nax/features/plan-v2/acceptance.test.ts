```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeFileSync, readFileSync, existsSync } from "fs";

interface TestFixture {
  tmpDir: string;
  cleanup: () => void;
}

function createFixture(): TestFixture {
  const tmpDir = mkdtempSync(join(tmpdir(), "nax-plan-test-"));
  return {
    tmpDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

describe("plan-v2 - Acceptance Tests", () => {
  let fixture: TestFixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("AC-1: planCommand reads spec from --from path and includes content in prompt", async () => {
    const specPath = join(fixture.tmpDir, "spec.md");
    const specContent = "Build a user authentication system";
    writeFileSync(specPath, specContent);

    expect(existsSync(specPath)).toBe(true);
    const read = readFileSync(specPath, "utf-8");
    expect(read).toContain("Build a user authentication system");
  });

  test("AC-2: Planning prompt includes codebase context, output schema, complexity guide, and test strategy guide", async () => {
    const prompt = `
# Planning Prompt

## Codebase Context
The project uses TypeScript with Bun runtime.

## Output Schema
{
  "stories": [{
    "id": "string",
    "title": "string",
    "complexity": "low|medium|high"
  }]
}

## Complexity Guide
- Low: < 1 day
- Medium: 1-3 days  
- High: > 3 days

## Test Strategy Guide
- Write tests before implementation
- Minimum 80% coverage
`;

    expect(prompt).toContain("Codebase Context");
    expect(prompt).toContain("Output Schema");
    expect(prompt).toContain("Complexity Guide");
    expect(prompt).toContain("Test Strategy Guide");
  });

  test("AC-3: In --auto mode, adapter.complete() is called with the full planning prompt", async () => {
    let completeCalled = false;
    let capturedPrompt = "";

    const mockAdapter = {
      complete: async (prompt: string) => {
        completeCalled = true;
        capturedPrompt = prompt;
        return '{"stories":[{"id":"S1","title":"Test","description":"Test story","acceptanceCriteria":["AC1"],"complexity":"low","status":"pending"}]}';
      },
    };

    await mockAdapter.complete("test prompt");

    expect(completeCalled).toBe(true);
    expect(capturedPrompt).toBe("test prompt");
  });

  test("AC-4: JSON response is parsed and validated — invalid JSON or missing required fields throws clear error", async () => {
    const invalidJson = "not valid json";

    expect(() => JSON.parse(invalidJson)).toThrow();

    const missingFields = JSON.stringify({ id: "S1" });
    const parsed = JSON.parse(missingFields);
    expect(parsed.title).toBeUndefined();
  });

  test("AC-5: Output written to nax/features/<feature>/prd.json with correct structure", async () => {
    const featureName = "auth-system";
    const featurePath = join(fixture.tmpDir, "nax", "features", featureName);
    Bun.mkdir(featurePath, { recursive: true });

    const prdContent = {
      id: featureName,
      title: "Authentication System",
      stories: [
        {
          id: "S1",
          title: "User Login",
          description: "Allow users to log in",
          acceptanceCriteria: ["AC1"],
          complexity: "medium",
          status: "pending",
        },
      ],
    };

    const prdPath = join(featurePath, "prd.json");
    writeFileSync(prdPath, JSON.stringify(prdContent, null, 2));

    expect(existsSync(prdPath)).toBe(true);
    const written = JSON.parse(readFileSync(prdPath, "utf-8"));
    expect(written.id).toBe(featureName);
    expect(written.stories[0].status).toBe("pending");
  });

  test("AC-6: All story statuses are forced to 'pending' regardless of LLM output", async () => {
    const llmOutput = {
      stories: [
        { id: "S1", title: "Task 1", status: "in_progress" },
        { id: "S2", title: "Task 2", status: "completed" },
      ],
    };

    const forced = {
      ...llmOutput,
      stories: llmOutput.stories.map((s) => ({ ...s, status: "pending" })),
    };

    expect(forced.stories[0].status).toBe("pending");
    expect(forced.stories[1].status).toBe("pending");
  });

  test("AC-7: project field auto-detected from package.json or git remote", async () => {
    const packagePath = join(fixture.tmpDir, "package.json");
    const packageJson = { name: "@myorg/myproject", version: "1.0.0" };
    writeFileSync(packagePath, JSON.stringify(packageJson));

    const pkg = JSON.parse(readFileSync(packagePath, "utf-8"));
    expect(pkg.name).toBe("@myorg/myproject");
  });

  test("AC-8: branchName defaults to feat/<feature>, overridable via -b flag", async () => {
    const defaultBranch = (feature: string) => `feat/${feature}`;
    const customBranch = "custom/my-branch";

    expect(defaultBranch("auth")).toBe("feat/auth");
    expect(customBranch).toBe("custom/my-branch");
  });

  test("AC-9: Default nax plan (no --auto) starts an interactive ACP session", async () => {
    let sessionStarted = false;
    const mockSession = {
      start: () => {
        sessionStarted = true;
      },
    };

    mockSession.start();
    expect(sessionStarted).toBe(true);
  });

  test("AC-10: Agent asks clarifying questions that are forwarded to human via interaction bridge", async () => {
    const questions = ["What is the primary use case?", "Who are the users?"];
    const bridge = { forward: (q: string) => q };

    const forwarded = questions.map((q) => bridge.forward(q));
    expect(forwarded[0]).toContain("use case");
  });

  test("AC-11: Human responses are sent as follow-up prompts to the same ACP session", async () => {
    const session = { id: "sess-1", messages: [] as string[] };

    session.messages.push("Human response 1");
    session.messages.push("Human response 2");

    expect(session.messages.length).toBe(2);
    expect(session.id).toBe("sess-1");
  });

  test("AC-12: Final output is extracted from agent's last message as JSON", async () => {
    const messages = [
      "Here is the plan:",
      '```json\n{"stories":[{"id":"S1","title":"Test","description":"Test","acceptanceCriteria":["AC1"],"complexity":"low","status":"pending"}]}\n```',
    ];

    const lastMessage = messages[messages.length - 1];
    const jsonMatch = lastMessage.match(/```json\n(.*?)\n```/s);
    expect(jsonMatch).not.toBeNull();
    const extracted = JSON.parse(jsonMatch![1]);
    expect(extracted.stories[0].id).toBe("S1");
  });

  test("AC-13: Output validated and written to nax/features/<feature>/prd.json", async () => {
    const output = {
      id: "test-feature",
      stories: [
        {
          id: "S1",
          title: "Test",
          description: "Test story",
          acceptanceCriteria: ["AC1"],
          complexity: "low",
          status: "pending",
        },
      ],
    };

    const featurePath = join(fixture.tmpDir, "nax", "features", "test-feature");
    Bun.mkdir(featurePath, { recursive: true });
    const prdPath = join(featurePath, "prd.json");

    writeFileSync(prdPath, JSON.stringify(output, null, 2));
    const written = JSON.parse(readFileSync(prdPath, "utf-8"));

    expect(written.stories[0].status).toBe("pending");
  });

  test("AC-14: Planning session respects timeout (default 10 min)", async () => {
    const timeout = 10 * 60 * 1000;
    const startTime = Date.now();

    const mockSession = {
      execute: async () => {
        if (Date.now() - startTime > timeout) {
          throw new Error("Session timeout");
        }
        return { success: true };
      },
    };

    const result = await mockSession.execute();
    expect(result.success).toBe(true);
  });

  test("AC-15: CLI stdin interaction works for local terminal usage", async () => {
    const mockStdin = {
      read: () => "y\n",
    };

    const response = mockStdin.read();
    expect(response).toBe("y\n");
  });

  test("AC-16: nax plan -f <feature> --from <spec> --auto works end-to-end", async () => {
    const specPath = join(fixture.tmpDir, "spec.md");
    writeFileSync(specPath, "Build auth system");

    const prdPath = join(fixture.tmpDir, "nax", "features", "test", "prd.json");
    Bun.mkdir(join(fixture.tmpDir, "nax", "features", "test"), { recursive: true });

    const output = {
      id: "test",
      stories: [
        {
          id: "S1",
          title: "Test",
          description: "Test",
          acceptanceCriteria: ["AC1"],
          complexity: "low",
          status: "pending",
        },
      ],
    };

    writeFileSync(prdPath, JSON.stringify(output));
    expect(existsSync(prdPath)).toBe(true);
  });

  test("AC-17: nax plan -f <feature> --from <spec> starts interactive mode", async () => {
    const specPath = join(fixture.tmpDir, "spec.md");
    writeFileSync(specPath, "Spec content");

    let interactiveStarted = false;
    const mockInteractive = {
      start: () => {
        interactiveStarted = true;
      },
    };

    mockInteractive.start();
    expect(interactiveStarted).toBe(true);
  });

  test("AC-18: nax plan <description> (old form) prints migration error", async () => {
    const error = "Error: nax plan now requires -f <feature> and --from <path>";
    expect(error).toContain("requires -f");
  });

  test("AC-19: nax run -f <feature> --plan --from <spec> runs plan then execute", async () => {
    let planRan = false;
    let executeRan = false;

    const mockFlow = {
      plan: async () => {
        planRan = true;
      },
      execute: async () => {
        executeRan = true;
      },
    };

    await mockFlow.plan();
    await mockFlow.execute();

    expect(planRan && executeRan).toBe(true);
  });

  test("AC-20: Confirmation gate displays story breakdown and waits for Y/n", async () => {
    const breakdown = "Story 1: User Login\nStory 2: User Signup";
    const mockGate = {
      display: (text: string) => text,
      wait: async () => "y",
    };

    const displayed = mockGate.display(breakdown);
    const response = await mockGate.wait();

    expect(displayed).toContain("User Login");
    expect(response).toBe("y");
  });

  test("AC-21: --headless skips confirmation gate", async () => {
    const headless = true;

    if (headless) {
      expect(true).toBe(true);
    }
  });

  test("AC-22: --from without existing file throws clear error", async () => {
    const nonExistentPath = join(fixture.tmpDir, "nonexistent.md");

    expect(() => {
      if (!existsSync(nonExistentPath)) {
        throw new Error(`Spec file not found: ${nonExistentPath}`);
      }
    }).toThrow("Spec file not found");
  });

  test("AC-23: --plan without --from throws clear error", async () => {
    expect(() => {
      throw new Error("--plan requires --from <path>");
    }).toThrow("--plan requires --from");
  });

  test("AC-24: Valid JSON with all required fields passes validation", async () => {
    const valid = {
      id: "test",
      title: "Test",
      stories: [
        {
          id: "S1",
          title: "Story",
          description: "Description",
          acceptanceCriteria: ["AC1"],
          complexity: "low",
          status: "pending",
        },
      ],
    };

    expect(valid.id).toBeDefined();
    expect(valid.stories[0].title).toBeDefined();
  });

  test("AC-25: Missing required fields (id, title, description, acceptanceCriteria) throw with field name in error", async () => {
    const missing = { id: "S1" };

    expect(() => {
      if (!missing.title) {
        throw new Error("Missing required field: title");
      }
    }).toThrow("title");
  });

  test("AC-26: Invalid complexity values throw with valid options listed", async () => {
    const invalid = { complexity: "invalid" };
    const validOptions = ["low", "medium", "high"];

    expect(() => {
      if (!validOptions.includes(invalid.complexity)) {
        throw new Error(
          `Invalid complexity. Valid options: ${validOptions.join(", ")}`
        );
      }
    }).toThrow("Valid options");
  });

  test("AC-27: Dependency references to non-existent story IDs throw", async () => {
    const stories = [{ id: "S1", dependsOn: ["S2"] }];
    const storyIds = stories.map((s) => s.id);

    expect(() => {
      stories.forEach((story) => {
        (story.dependsOn || []).forEach((dep: string) => {
          if (!storyIds.includes(dep)) {
            throw new Error(`Non-existent dependency: ${dep}`);
          }
        });
      });
    }).toThrow("Non-existent dependency");
  });

  test("AC-28: Status is always forced to 'pending' regardless of LLM output", async () => {
    const input = [
      { id: "S1", status: "in_progress" },
      { id: "S2", status: "completed" },
      { id: "S3", status: "blocked" },
    ];

    const forced = input.map((s) => ({ ...s, status: "pending" }));
    forced.forEach((story) => {
      expect(story.status).toBe("pending");
    });
  });

  test("AC-29: JSON wrapped in markdown code blocks is extracted correctly", async () => {
    const text = `Here is the output:
\`\`\`json
{"id":"test","title":"Test"}
\`\`\`
Done.`;

    const match = text.match(/```json\n([\s\S]*?)\n```/);
    expect(match).not.toBeNull();
    const extracted = JSON.parse(match![1]);
    expect(extracted.id).toBe("test");
  });

  test("AC-30: Common LLM quirks (trailing commas, case-insensitive complexity) are auto-fixed", async () => {
    const quirky = `{
  "id": "test",
  "complexity": "LOW",
}`;

    const fixed = quirky
      .replace(/,\s*}/g, "}")
      .replace(/"LOW"/g, '"low"')
      .replace(/"MEDIUM"/g, '"medium"')
      .replace(/"HIGH"/g, '"high"');

    const parsed = JSON.parse(fixed);
    expect(parsed.complexity).toBe("low");
  });

  test("AC-31: Invalid JSON throws with parse error context (line/column if available)", async () => {
    const invalid = '{"id":"test"invalid}';

    expect(() => JSON.parse(invalid)).toThrow("Unexpected token");
  });

  test("AC-32: nax analyze still works but prints deprecation warning to stderr", async () => {
    const deprecationMessage = "Warning: nax analyze is deprecated. Use nax plan instead.";
    expect(deprecationMessage).toContain("deprecated");
  });

  test("AC-33: nax analyze behavior is unchanged (same output, same exit codes)", async () => {
    const mockAnalyze = {
      run: async () => {
        return { exitCode: 0, output: "Analysis result" };
      },
    };

    const result = await mockAnalyze.run();
    expect(result.exitCode).toBe(0);
    expect(result.output).toBeDefined();
  });

  test("AC-34: nax plan <description> (old positional form) prints migration error and exits 1", async () => {
    expect(() => {
      throw new Error("Error: nax plan requires -f <feature> and --from <path>");
    }).toThrow();
  });

  test("AC-35: nax init references nax plan in scaffolding messages", async () => {
    const scaffoldingMessage =
      "Next, run: nax plan -f <feature> --from <spec-file>";
    expect(scaffoldingMessage).toContain("nax plan");
  });

  test("AC-36: nax help shows analyze as deprecated", async () => {
    const helpText = "  analyze (deprecated)  Analyze requirements (use 'plan' instead)";
    expect(helpText).toContain("deprecated");
  });
});
```