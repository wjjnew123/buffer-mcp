import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  ConfigError,
  deepMerge,
  getCredentials,
  loadConfig,
  parseCloudinaryUrl,
  publicConfig,
  resolveConfigPath,
  resolveHttpToken,
} from "../src/config/load.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";

describe("deepMerge", () => {
  it("merges nested objects and preserves base keys", () => {
    const merged = deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } });
    expect(merged).toEqual({ a: { b: 1, c: 3 } });
  });

  it("ignores undefined values", () => {
    const merged = deepMerge({ a: 1, b: 2 }, { b: undefined });
    expect(merged).toEqual({ a: 1, b: 2 });
  });

  it("replaces arrays instead of concatenating", () => {
    const merged = deepMerge({ a: [1, 2] }, { a: [3] });
    expect(merged).toEqual({ a: [3] });
  });
});

describe("parseCloudinaryUrl", () => {
  it("parses a standard cloudinary url", () => {
    expect(parseCloudinaryUrl("cloudinary://key:secret@cloud")).toEqual({
      apiKey: "key",
      apiSecret: "secret",
      cloudName: "cloud",
    });
  });

  it("decodes url-encoded credentials", () => {
    expect(parseCloudinaryUrl("cloudinary://key%20a:sec%40ret@my-cloud")?.apiSecret).toBe(
      "sec@ret",
    );
  });

  it("rejects malformed urls", () => {
    expect(parseCloudinaryUrl("https://example.com")).toBeNull();
    expect(parseCloudinaryUrl("")).toBeNull();
    expect(parseCloudinaryUrl(undefined)).toBeNull();
  });
});

describe("resolveConfigPath", () => {
  it("defaults to buffer-mcp.config.json in cwd", () => {
    expect(resolveConfigPath({ cwd: "C:/tmp", env: {} })).toContain("buffer-mcp.config.json");
  });

  it("honours an explicit path and the env var", () => {
    expect(resolveConfigPath({ cwd: "C:/tmp", env: {}, configPath: "a.json" })).toBe(
      path.resolve("C:/tmp", "a.json"),
    );
    expect(resolveConfigPath({ cwd: "C:/tmp", env: { BUFFER_MCP_CONFIG: "b.json" } })).toBe(
      path.resolve("C:/tmp", "b.json"),
    );
  });

  it("returns empty for an explicit null", () => {
    expect(resolveConfigPath({ cwd: "C:/tmp", env: {}, configPath: null })).toBe("");
  });
});

describe("loadConfig", () => {
  it("returns defaults when no file and no env are present", () => {
    const loaded = loadConfig({ configPath: null, env: {} });
    expect(loaded.fileExists).toBe(false);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
  });

  it("applies environment overrides", () => {
    const loaded = loadConfig({
      configPath: null,
      env: {
        BUFFER_API_KEY: "key",
        CLOUDINARY_URL: "cloudinary://k:s@c",
        MCP_TRANSPORT: "http",
        MCP_HTTP_PORT: "9999",
        MCP_HTTP_TOKEN: "tok",
      },
    });
    expect(loaded.config.buffer.apiKey).toBe("key");
    expect(loaded.config.cloudinary.cloudName).toBe("c");
    expect(loaded.config.transport.mode).toBe("http");
    expect(loaded.config.transport.http.port).toBe(9999);
    expect(resolveHttpToken(loaded.config, {})).toBe("tok");
  });

  it("lets cli flags win over env", () => {
    const loaded = loadConfig({
      configPath: null,
      env: { MCP_HTTP_PORT: "9999" },
      cli: { port: 1234, dryRun: true, allowDestructive: true },
    });
    expect(loaded.config.transport.http.port).toBe(1234);
    expect(loaded.config.safety.dryRun).toBe(true);
    expect(loaded.config.safety.allowDestructive).toBe(true);
  });

  it("refuses a public bind without a token", () => {
    expect(() =>
      loadConfig({ configPath: null, env: { MCP_TRANSPORT: "http", MCP_HTTP_HOST: "0.0.0.0" } }),
    ).toThrow(ConfigError);
  });

  it("allows a public bind when a token is present", () => {
    const loaded = loadConfig({
      configPath: null,
      env: { MCP_TRANSPORT: "http", MCP_HTTP_HOST: "0.0.0.0", MCP_HTTP_TOKEN: "tok" },
    });
    expect(loaded.config.transport.http.host).toBe("0.0.0.0");
  });
});

describe("getCredentials", () => {
  it("prefers explicit config over CLOUDINARY_URL", () => {
    const config = {
      ...DEFAULT_CONFIG,
      cloudinary: {
        ...DEFAULT_CONFIG.cloudinary,
        cloudName: "direct",
        apiKey: "k1",
        apiSecret: "s1",
      },
    };
    const creds = getCredentials(config, { CLOUDINARY_URL: "cloudinary://k2:s2@url" });
    expect(creds).toEqual({ cloudName: "direct", apiKey: "k1", apiSecret: "s1" });
  });

  it("lets an explicit empty config fall back to the url", () => {
    const blank = {
      ...DEFAULT_CONFIG,
      cloudinary: {
        ...DEFAULT_CONFIG.cloudinary,
        cloudName: "",
        apiKey: "",
        apiSecret: "",
      },
    };
    expect(getCredentials(blank, { CLOUDINARY_URL: "cloudinary://k:s@c" })).toEqual({
      cloudName: "c",
      apiKey: "k",
      apiSecret: "s",
    });
  });

  it("returns the shipped defaults when nothing is configured", () => {
    expect(getCredentials(DEFAULT_CONFIG, {})).toEqual({
      cloudName: DEFAULT_CONFIG.cloudinary.cloudName,
      apiKey: DEFAULT_CONFIG.cloudinary.apiKey,
      apiSecret: DEFAULT_CONFIG.cloudinary.apiSecret,
    });
  });
});

describe("publicConfig", () => {
  it("masks every secret path", () => {
    const config = {
      ...DEFAULT_CONFIG,
      buffer: { ...DEFAULT_CONFIG.buffer, apiKey: "abcdef123456" },
      cloudinary: {
        ...DEFAULT_CONFIG.cloudinary,
        apiKey: "short",
        apiSecret: "supersecretvalue",
      },
    };
    const out = publicConfig(config);
    expect(out.buffer).toMatchObject({ apiKey: "abc***56" });
    expect(out.cloudinary).toMatchObject({ apiKey: "***", apiSecret: "sup***ue" });
    expect(JSON.stringify(out)).not.toContain("supersecretvalue");
  });
});
