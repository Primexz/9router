import { describe, it, expect, beforeEach } from "vitest";

import { getRotatedModels, handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";
import { classifyRequestComplexity, detectStalledTask, extractLastUserAsk, getDefaultTierModels, resetComplexitySessionPins, routeModelsByComplexity } from "../../open-sse/services/complexityRouter.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
    resetComplexitySessionPins();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });
});

describe("combo dynamic routing", () => {
  const models = ["provider/fast", "provider/standard", "provider/reasoning"];

  it("keeps simple requests on the first, least expensive tier", () => {
    const body = { messages: [{ role: "user", content: "Say hello" }] };

    expect(classifyRequestComplexity(body).tier).toBe("SIMPLE");
    expect(routeModelsByComplexity(models, body).models).toEqual(models);
  });

  it("promotes involved requests to the strongest tier and preserves fallback", () => {
    const body = {
      messages: [
        { role: "system", content: "You are a coding assistant." },
        { role: "user", content: "```js\nthrow new Error()\n```\nDebug the stack trace and implement a root cause fix." },
        { role: "assistant", content: "I will inspect it." },
        { role: "user", content: "Implement and refactor a distributed architecture with concurrency constraints." },
      ],
      tools: [{ type: "function", function: { name: "read_file" } }],
      max_tokens: 5000,
      reasoning_effort: "high",
    };

    expect(classifyRequestComplexity(body).tier).toBe("COMPLEX");
    expect(routeModelsByComplexity(models, body).models).toEqual([
      "provider/reasoning",
      "provider/standard",
      "provider/fast",
    ]);
  });

  it("uses the middle tier for moderately complex requests", () => {
    const body = {
      messages: [{ role: "user", content: "Implement a function for this small feature." }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    };

    expect(routeModelsByComplexity(models, body).models).toEqual([
      "provider/standard",
      "provider/reasoning",
      "provider/fast",
    ]);
  });

  it("uses explicit tier assignments instead of combo order", () => {
    const config = {
      tiers: {
        SIMPLE: "provider/standard",
        MEDIUM: "provider/fast",
        COMPLEX: "provider/reasoning",
        REASONING: "provider/reasoning",
      },
    };

    expect(getDefaultTierModels(models)).toEqual({
      SIMPLE: "provider/fast",
      MEDIUM: "provider/standard",
      COMPLEX: "provider/reasoning",
      REASONING: "provider/reasoning",
    });
    expect(routeModelsByComplexity(models, { messages: [{ role: "user", content: "hello" }] }, config).models[0])
      .toBe("provider/standard");
    expect(routeModelsByComplexity(models, { messages: [{ role: "user", content: "Implement a function" }] }, config).models[0])
      .toBe("provider/fast");
  });

  it("scores only the last real human ask", () => {
    const body = {
      messages: [
        { role: "system", content: "Implement distributed systems and reason step by step." },
        { role: "user", content: "Debug the database architecture." },
        { role: "assistant", content: "Done." },
        { role: "tool", content: "large technical tool output" },
        { role: "user", content: [{ type: "tool_result", content: "ignored" }, { type: "text", text: "thanks" }] },
      ],
    };

    expect(extractLastUserAsk(body)).toBe("thanks");
    expect(classifyRequestComplexity(body).tier).toBe("SIMPLE");
  });

  it("uses word boundaries and configurable keyword tier overrides", () => {
    expect(classifyRequestComplexity({ messages: [{ role: "user", content: "What is the capital of France?" }] }).signals)
      .not.toContain("code (api)");
    expect(classifyRequestComplexity(
      { messages: [{ role: "user", content: "Investigate a production incident" }] },
      { keywordTierRules: [{ keywords: ["production incident"], tier: "REASONING" }] },
    )).toMatchObject({ tier: "REASONING", cause: "literal_keyword_match", matchedKeyword: "production incident" });
  });

  it("routes agent housekeeping prompts to the cheapest tier", () => {
    const prompt = [
      "You are coming up with a succinct title for a coding session",
      "The session discusses distributed architecture, concurrency, database performance, and optimization.",
    ].join("\n");
    const body = { messages: [{ role: "user", content: prompt }] };

    expect(classifyRequestComplexity(body)).toMatchObject({
      tier: "SIMPLE",
      score: null,
      cause: "housekeeping",
      signals: ["housekeeping"],
      matchedKeyword: "You are coming up with a succinct title for a coding session",
    });
    expect(routeModelsByComplexity(models, body).models[0]).toBe("provider/fast");
  });

  it("supports custom housekeeping patterns and lets keyword rules take precedence", () => {
    const body = { messages: [{ role: "user", content: "Generate a session label for this architecture discussion" }] };
    const config = { housekeepingPatterns: ["Generate a session label"] };

    expect(classifyRequestComplexity(body, config).cause).toBe("housekeeping");
    expect(classifyRequestComplexity(body, { ...config, routeHousekeepingToCheapestTier: false }).cause)
      .toBe("heuristic_scorer");
    expect(classifyRequestComplexity(body, {
      ...config,
      keywordTierRules: [{ keywords: ["session label"], tier: "COMPLEX" }],
    })).toMatchObject({ tier: "COMPLEX", cause: "literal_keyword_match" });
  });

  it("matches housekeeping only on the newest ask", () => {
    const body = {
      messages: [
        { role: "user", content: "Write the title in the predominant language of the session" },
        { role: "assistant", content: "Routing work" },
        { role: "user", content: "Implement and refactor a distributed architecture with concurrency constraints." },
      ],
    };

    expect(classifyRequestComplexity(body).cause).toBe("heuristic_scorer");
    expect(classifyRequestComplexity(body).tier).toBe("COMPLEX");
  });

  it("supports configurable boundaries and explicit one-tier escalation", () => {
    const body = { messages: [{ role: "user", content: "Implement a function" }] };
    expect(classifyRequestComplexity(body, { tierBoundaries: { simple_medium: 0.25 } }).tier).toBe("SIMPLE");
    expect(classifyRequestComplexity({ messages: [{ role: "user", content: "Implement a function. 9ROUTER ESCALATE" }] }).tier)
      .toBe("COMPLEX");
    expect(classifyRequestComplexity(body, {
      tierBoundaries: { simple_medium: 0.8, medium_complex: 0.2, complex_reasoning: 0.1 },
    }).tier).toBe("MEDIUM");
  });

  it("extracts Gemini text parts and escalates repeated tool stalls", () => {
    expect(extractLastUserAsk({ contents: [{ role: "user", parts: [{ text: "compare the options" }] }] }))
      .toBe("compare the options");
    const repeatedCall = { id: "call", type: "function", function: { name: "read_file", arguments: '{"path":"a.js"}' } };
    const body = {
      messages: [
        { role: "assistant", tool_calls: [repeatedCall] },
        { role: "tool", content: "failed" },
        { role: "assistant", tool_calls: [repeatedCall] },
        { role: "tool", content: "failed" },
        { role: "assistant", tool_calls: [repeatedCall] },
        { role: "user", content: "continue" },
      ],
    };

    expect(detectStalledTask(body)).toBe(true);
    expect(classifyRequestComplexity(body)).toMatchObject({ tier: "MEDIUM", signals: expect.arrayContaining(["stall_escalation"]) });
  });

  it("applies escalation after keyword overrides and pins sessions without blocking escalation", () => {
    const overrideConfig = {
      keywordTierRules: [{ keywords: ["incident"], tier: "MEDIUM" }],
      escalationKeywords: ["ESCALATE"],
    };
    expect(classifyRequestComplexity({ messages: [{ role: "user", content: "incident ESCALATE" }] }, overrideConfig))
      .toMatchObject({ tier: "COMPLEX", cause: "literal_keyword_match", matchedKeyword: "incident" });

    const config = { sessionAffinity: true, routerName: "smart" };
    const metadata = { session_id: "session-1" };
    expect(routeModelsByComplexity(models, { metadata, messages: [{ role: "user", content: "Implement a function" }] }, config).models[0])
      .toBe("provider/standard");
    expect(routeModelsByComplexity(models, { metadata, messages: [{ role: "user", content: "hello" }] }, config).models[0])
      .toBe("provider/standard");
    expect(routeModelsByComplexity(models, { metadata, messages: [{ role: "user", content: "thanks" }] }, config).models[0])
      .toBe("provider/standard");
    expect(routeModelsByComplexity(models, { metadata, messages: [{ role: "user", content: "Analyze this step by step and explain your reasoning" }] }, config).models[0])
      .toBe("provider/reasoning");
  });

  it("uses the selected dynamic tier before trying fallbacks", async () => {
    const attempted = [];
    const response = await handleComboChat({
      body: {
        messages: [
          { role: "user", content: "Plan the migration." },
          { role: "assistant", content: "What constraints apply?" },
          { role: "user", content: "Analyze this step by step, explain your reasoning, and implement the function." },
        ],
        tools: [{ type: "function", function: { name: "read_file" } }],
        max_tokens: 5000,
        reasoning_effort: "high",
      },
      models,
      comboStrategy: "dynamic",
      log: { info() {}, warn() {} },
      handleSingleModel: async (_body, model) => {
        attempted.push(model);
        return new Response("ok");
      },
    });

    expect(response.ok).toBe(true);
    expect(attempted).toEqual(["provider/reasoning"]);
  });
});
