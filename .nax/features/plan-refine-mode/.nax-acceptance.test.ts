'", async () => {
    const { PlanPromptBuilder } = await import("../../../src/prompts/builders/plan-builder");
    const prompt = new PlanPromptBuilder().buildRefineContinuation("/path/to/prd.json");
    expect(prompt).not.toContain("