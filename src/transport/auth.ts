import { timingSafeEqual } from "node:crypto";

export function tokenMatches(expected: string, provided: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function extractBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

export function ipMatches(ip: string, rule: string): boolean {
  const normalized = ip.replace(/^::ffff:/, "");
  if (rule === "*") return true;
  if (rule.includes("/")) {
    const [network, bitsRaw] = rule.split("/");
    const bits = Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const a = ipv4ToInt(normalized);
    const b = ipv4ToInt(network);
    if (a === null || b === null) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (a & mask) === (b & mask);
  }
  return normalized === rule;
}

export function ipAllowed(ip: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  return allowlist.some((rule) => ipMatches(ip, rule));
}

export interface RateLimitState {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, RateLimitState>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (bucket.count >= this.max) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now };
    }
    bucket.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}
