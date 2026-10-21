import { describe, expect, it } from "vitest";
import { RateLimiter, extractBearer, ipAllowed, ipMatches, tokenMatches } from "../src/transport/auth.js";

describe("tokenMatches", () => {
  it("accepts equal tokens and rejects everything else", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", "abcd")).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
    expect(tokenMatches("abc", "")).toBe(false);
  });
});

describe("extractBearer", () => {
  it("parses the Authorization header", () => {
    expect(extractBearer("Bearer abc")).toBe("abc");
    expect(extractBearer("bearer  abc ")).toBe("abc");
    expect(extractBearer("Basic abc")).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer(["Bearer abc", "Bearer zzz"])).toBe("abc");
  });
});

describe("ipMatches", () => {
  it("matches exact addresses", () => {
    expect(ipMatches("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(ipMatches("127.0.0.2", "127.0.0.1")).toBe(false);
  });

  it("strips the ipv6-mapped prefix", () => {
    expect(ipMatches("::ffff:10.0.0.5", "10.0.0.5")).toBe(true);
  });

  it("matches CIDR ranges", () => {
    expect(ipMatches("192.168.1.50", "192.168.1.0/24")).toBe(true);
    expect(ipMatches("192.168.2.50", "192.168.1.0/24")).toBe(false);
    expect(ipMatches("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipMatches("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(ipMatches("not-an-ip", "0.0.0.0/0")).toBe(false);
    expect(ipMatches("1.2.3.4", "1.2.3.4/33")).toBe(false);
  });

  it("supports a wildcard rule", () => {
    expect(ipMatches("1.2.3.4", "*")).toBe(true);
  });
});

describe("ipAllowed", () => {
  it("allows all traffic when the list is empty", () => {
    expect(ipAllowed("1.2.3.4", [])).toBe(true);
  });

  it("requires a match when a list is provided", () => {
    expect(ipAllowed("1.2.3.4", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("10.9.9.9", ["10.0.0.0/8", "1.2.3.4"])).toBe(true);
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit inside the window", () => {
    const limiter = new RateLimiter(1000, 2);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("a", 1).allowed).toBe(true);
    const blocked = limiter.check("a", 2);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(998);
  });

  it("resets after the window elapses", () => {
    const limiter = new RateLimiter(1000, 1);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("a", 500).allowed).toBe(false);
    expect(limiter.check("a", 1000).allowed).toBe(true);
  });

  it("tracks keys independently and sweeps expired buckets", () => {
    const limiter = new RateLimiter(1000, 1);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("b", 0).allowed).toBe(true);
    limiter.sweep(2000);
    expect(limiter.check("a", 2000).allowed).toBe(true);
  });
});
