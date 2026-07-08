const MAX_TOKENS = 8;
const REFILL_INTERVAL_MS = 1000;
const MAX_RETRIES = 4;
const RETRYABLE_STATUSES = [429, 403, 500, 502, 503, 504];

interface RateLimiter {
  tokens: number;
  lastRefill: number;
  waiters: Array<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const limiter: RateLimiter = {
  tokens: MAX_TOKENS,
  lastRefill: Date.now(),
  waiters: [],
  timer: null,
};

function startRefillTimer(): void {
  if (limiter.timer !== null) return;
  limiter.timer = setInterval(() => {
    limiter.tokens = MAX_TOKENS;
    limiter.lastRefill = Date.now();
    const toRelease = limiter.waiters.splice(0, limiter.tokens);
    limiter.tokens -= toRelease.length;
    toRelease.forEach((resolve) => resolve());
    if (limiter.waiters.length === 0 && limiter.timer !== null) {
      clearInterval(limiter.timer);
      limiter.timer = null;
    }
  }, REFILL_INTERVAL_MS);
}

async function acquireToken(): Promise<void> {
  if (limiter.tokens > 0) {
    limiter.tokens--;
    return;
  }
  startRefillTimer();
  return new Promise<void>((resolve) => {
    limiter.waiters.push(resolve);
  });
}

export function _resetLimiterForTest(): void {
  limiter.tokens = MAX_TOKENS;
  limiter.lastRefill = Date.now();
  limiter.waiters = [];
  if (limiter.timer !== null) {
    clearInterval(limiter.timer);
    limiter.timer = null;
  }
}

function getUserAgent(): string {
  const ua = process.env.EDGAR_USER_AGENT;
  if (!ua) {
    throw new Error(
      "EDGAR_USER_AGENT env var is required (see .env.example)",
    );
  }
  return ua;
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export async function edgarFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  await acquireToken();

  const headers = new Headers(init?.headers);
  headers.set("User-Agent", getUserAgent());
  headers.set("Accept-Encoding", "gzip, deflate");

  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = backoffMs(attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
      await acquireToken();
    }

    lastResponse = await fetch(url, { ...init, headers });

    if (!RETRYABLE_STATUSES.includes(lastResponse.status)) {
      return lastResponse;
    }
  }

  return lastResponse!;
}
