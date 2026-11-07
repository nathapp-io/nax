import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { resolveSelfVerificationPromptInput } from "@/quality/self-verification";

describe("resolveSelfVerificationPromptInput renders commands via renderCommandSpec", () => {
  // `quality.commands.*` is still declared as plain `string` in NaxConfig (the
  // list-valued QualityCommandSpec widening was scoped out of this task after
  // a controller ruling — see command-spec.test.ts for renderCommandSpec's
  // own list-join coverage). These two cases pin that routing a string
  // through renderCommandSpec is still a lossless passthrough.
  test("renders a string typecheck command unchanged", async () => {
    const config = makeNaxConfig({
      quality: {
        commands: { typecheck: "tsc --noEmit", lint: "bun run lint" },
      },
    });

    const input = await resolveSelfVerificationPromptInput(config, process.cwd());

    expect(input.typecheckCommand).toBe("tsc --noEmit");
    expect(input.lintCommand).toBe("bun run lint");
  });

  test("leaves an undeclared command undefined", async () => {
    const config = makeNaxConfig({ quality: { commands: {} } });
    const input = await resolveSelfVerificationPromptInput(config, process.cwd());
    expect(input.typecheckCommand).toBeUndefined();
  });
});
