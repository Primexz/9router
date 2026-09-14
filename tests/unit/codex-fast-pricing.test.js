import { beforeEach, describe, expect, it, vi } from "vitest";

const saveRequestUsage = vi.fn(async () => {});

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage,
}));

const { saveUsageStats } = await import("../../open-sse/handlers/chatCore/requestDetail.js");

describe("Codex fast-mode usage pricing", () => {
  beforeEach(() => {
    saveRequestUsage.mockClear();
  });

  it("persists the fast pricing multiplier with canonical usage", () => {
    saveUsageStats({
      provider: "codex",
      model: "gpt-5.6-sol",
      tokens: { input_tokens: 100, output_tokens: 50 },
      pricingMultiplier: 2,
      silent: true,
    });

    expect(saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      model: "gpt-5.6-sol",
      tokens: expect.objectContaining({
        prompt_tokens: 100,
        completion_tokens: 50,
        pricing_multiplier: 2,
      }),
    }));
  });
});
