import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { edgarFetch, _resetLimiterForTest } from "@/lib/edgar/client";

describe("EDGAR rate limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetLimiterForTest();
    process.env.EDGAR_USER_AGENT = "TestApp test@example.com";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.EDGAR_USER_AGENT;
  });

  it("never exceeds 8 concurrent requests in any 1-second window", async () => {
    const timestamps: number[] = [];

    const mockFetch = vi.fn().mockImplementation(() => {
      timestamps.push(Date.now());
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    vi.stubGlobal("fetch", mockFetch);

    const promises: Promise<Response>[] = [];
    for (let i = 0; i < 20; i++) {
      promises.push(edgarFetch("https://example.com/test"));
    }

    // Advance timers to allow all requests to complete
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    await Promise.all(promises);

    expect(timestamps.length).toBe(20);

    // Check that no more than 8 requests occurred in any 1-second window
    for (let i = 0; i < timestamps.length; i++) {
      const windowStart = timestamps[i];
      const inWindow = timestamps.filter(
        (t) => t >= windowStart && t < windowStart + 1000,
      );
      expect(
        inWindow.length,
        `Found ${inWindow.length} requests in 1s window starting at ${windowStart}`,
      ).toBeLessThanOrEqual(8);
    }

    vi.unstubAllGlobals();
  });

  it("throws when EDGAR_USER_AGENT is not set", async () => {
    delete process.env.EDGAR_USER_AGENT;

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mockFetch);

    await expect(edgarFetch("https://example.com")).rejects.toThrow(
      "EDGAR_USER_AGENT",
    );

    vi.unstubAllGlobals();
  });

  it("retries on 429 with backoff", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve(new Response("rate limited", { status: 429 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    vi.stubGlobal("fetch", mockFetch);

    const promise = edgarFetch("https://example.com/test");

    // Advance past backoff delays + rate limiter refills
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }

    const response = await promise;
    expect(response.status).toBe(200);
    expect(callCount).toBe(3);

    vi.unstubAllGlobals();
  });

  it("sets User-Agent header from env", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mockFetch);

    await edgarFetch("https://example.com/test");

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.get("User-Agent")).toBe("TestApp test@example.com");

    vi.unstubAllGlobals();
  });
});
