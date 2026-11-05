import { describe, expect, it, vi } from "vitest";
import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

async function handle(provider, contentType, payload) {
  const streamController = { isConnected: () => true, handleError: vi.fn(), handleComplete: vi.fn() };
  const result = await handleStreamingResponse({
    providerResponse: new Response(payload, { headers: { "Content-Type": contentType } }),
    provider,
    model: "qwen3:30b",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OLLAMA,
    body: { messages: [], model: "qwen3:30b" },
    stream: true,
    requestStartTime: Date.now(),
    streamController,
    log: { errorLine: vi.fn() },
  });
  return { ...result, streamController };
}

describe("streaming response content-type validation", () => {
  it.each(["ollama", "ollama-local"])("translates %s NDJSON to OpenAI SSE", async (provider) => {
    const payload = [
      { message: { role: "assistant", content: "hello" }, done: false },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 11, eval_count: 7 },
    ].map(JSON.stringify).join("\n") + "\n";
    const result = await handle(provider, "Application/X-Ndjson; charset=utf-8", payload);
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toBe("text/event-stream");
    const output = await result.response.text();
    const chunks = output.split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    expect(chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || "").join("")).toBe("hello");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    expect(chunks.at(-1).usage.total_tokens).toBe(18);
    expect(result.streamController.handleError).not.toHaveBeenCalled();
  });

  it("still rejects upstream HTML error pages", async () => {
    const result = await handle("ollama-local", "text/html", "<title>Service unavailable</title>");
    expect(result.success).toBe(false);
    expect(await result.response.json()).toEqual({ error: { message: "[200]: Service unavailable" } });
    expect(result.streamController.handleError).toHaveBeenCalledOnce();
  });
});
