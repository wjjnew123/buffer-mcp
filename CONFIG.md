# buffer-mcp configuration reference

`buffer-mcp` merges configuration from four layers. Later layers win:

1. Built-in defaults (`src/config/schema.ts`)
2. Config file — `./buffer-mcp.config.json`, or `$BUFFER_MCP_CONFIG`, or `--config <path>`
3. Environment variables
4. CLI flags (`--transport`, `--host`, `--port`, `--dry-run`, `--allow-destructive`)

Objects merge recursively; arrays are replaced wholesale; `undefined` values are ignored.

`buffer-mcp.config.json` is JSON, so it supports **no comments**. This file documents every key,
its type, its default, and what it does. A machine-readable schema is emitted to
`schema/config.schema.json` (`npm run schema`), which most editors pick up via the `$schema` key.

Secret paths — never written by `buffer_set_config` unless `safety.allowSecretWrite` is true, and
always masked by `buffer_get_config`:
`buffer.apiKey`, `cloudinary.apiKey`, `cloudinary.apiSecret`, `transport.http.authToken`.

---

## `buffer` — Buffer API access

```json
{
  "buffer": {
    "apiUrl": "https://api.buffer.com",
    "apiKey": "",
    "apiKeyEnv": "BUFFER_API_KEY",
    "timeoutMs": 30000,
    "retries": 2,
    "retryDelayMs": 500,
    "organizationId": null,
    "defaultChannelIds": []
  }
}
```

| key | type | default | meaning |
| --- | --- | --- | --- |
| `apiUrl` | string (url) | `https://api.buffer.com` | Buffer GraphQL endpoint. Change only for a proxy/mock. |
| `apiKey` | string | `""` | **Secret.** Buffer personal API key. Prefer the env var instead. |
| `apiKeyEnv` | string | `BUFFER_API_KEY` | Env var name that supplies `apiKey`. Read at startup. |
| `timeoutMs` | int > 0 | `30000` | Per-request timeout in milliseconds. |
| `retries` | int 0–5 | `2` | Retry attempts for transient network/5xx failures. |
| `retryDelayMs` | int >= 0 | `500` | Base delay between retries (milliseconds). |
| `organizationId` | string \| null | `null` | Pins the organization. `null` auto-resolves when the key sees exactly one. |
| `defaultChannelIds` | string[] | `[]` | Channels used when a tool call omits `channelIds`. |

---

## `scheduling` — default publishing behaviour

```json
{
  "scheduling": {
    "mode": "addToQueue",
    "schedulingType": "automatic",
    "needsApproval": false,
    "timezone": "Asia/Shanghai"
  }
}
```

| key | type | default | meaning |
| --- | --- | --- | --- |
| `mode` | `addToQueue` \| `shareNext` \| `shareNow` \| `customScheduled` | `addToQueue` | Default mode for `buffer_create_post`. `customScheduled` requires a `dueAt` timestamp. |
| `schedulingType` | `automatic` \| `notification` | `automatic` | `automatic` publishes on schedule; `notification` only reminds a human. |
| `needsApproval` | boolean | `false` | Marks posts as needing approval before they go out. |
| `timezone` | string | `Asia/Shanghai` | IANA timezone used for queue slots and `shareNext`. |

---

## `platforms` — per-service post metadata

Each key is a Buffer service name; the value is merged into every post created for a channel of
that service. Any service Buffer supports can be added (e.g. `threads`, `tiktok`, `linkedin`);
unknown services are passed through untouched.

```json
{
  "platforms": {
    "facebook": { "type": "post" },
    "instagram": { "type": "post", "shouldShareToFeed": true },
    "youtube": {
      "privacy": "public",
      "categoryId": "2",
      "madeForKids": false,
      "notifySubscribers": true,
      "license": "youtube"
    }
  }
}
```

| key | type | default | meaning |
| --- | --- | --- | --- |
| `facebook` | object | `{ "type": "post" }` | Facebook requires `type`. |
| `instagram` | object | `{ "type": "post", "shouldShareToFeed": true }` | Instagram requires `type` and `shouldShareToFeed: true`. |
| `youtube` | object | see above | YouTube requires `categoryId`. `privacy`: `public` \| `unlisted` \| `private`. `madeForKids`, `notifySubscribers`, `license` (`youtube` \| `creativeCommon`). |
| `<service>` | object | `{}` | Any other Buffer service; contents are forwarded as-is. |

Call-level override: pass `metadata: { "youtube": { "privacy": "unlisted" } }` to
`buffer_create_post` to override for a single call.

---

## `cloudinary` — built-in media upload

```json
{
  "cloudinary": {
    "enabled": true,
    "provider": "cloudinary",
    "cloudName": "",
    "apiKey": "",
    "apiSecret": "",
    "urlEnv": "CLOUDINARY_URL",
    "folder": "buffer",
    "resourceType": "auto",
    "overwrite": false,
    "chunkThresholdMb": 100,
    "returnVariants": true
  }
}
```

| key | type | default | meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enables the `cloudinary_*` tools and local-file uploads. |
| `provider` | `cloudinary` | `cloudinary` | Media provider name. Reserved for future providers. |
| `cloudName` | string | `""` | **Secret-adjacent.** Cloudinary cloud name (bring your own). |
| `apiKey` | string | `""` | **Secret.** Cloudinary API key (bring your own). |
| `apiSecret` | string | `""` | **Secret.** Cloudinary API secret used to sign uploads (bring your own). |
| `urlEnv` | string | `CLOUDINARY_URL` | Env var holding `cloudinary://key:secret@cloud`; used only when the three fields above are empty. |
| `folder` | string | `buffer` | Default Cloudinary folder for uploads. |
| `resourceType` | `auto` \| `image` \| `video` | `auto` | Cloudinary resource type; `auto` lets Cloudinary detect it. |
| `overwrite` | boolean | `false` | Allow replacing an asset with the same `public_id`. |
| `chunkThresholdMb` | int > 0 | `100` | Files larger than this use Cloudinary's chunked upload. |
| `returnVariants` | boolean | `true` | Attach 16:9 / 1:1 / 4:5 / 9:16 delivery URLs to upload results. |

> The shipped defaults contain live credentials. If you would rather keep them out of the repo,
> blank all three fields and set `CLOUDINARY_URL` (or `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY`
> / `CLOUDINARY_API_SECRET`) instead — explicit config wins over env, so an empty field falls back
> to the env var.

---

## `media` — URL and file guardrails

```json
{
  "media": {
    "requireHttps": true,
    "probeTimeoutMs": 15000,
    "maxBytes": 524288000,
    "blockOnProbeFailure": true
  }
}
```

| key | type | default | meaning |
| --- | --- | --- | --- |
| `requireHttps` | boolean | `true` | Reject non-HTTPS media URLs; Buffer cannot fetch plain HTTP. |
| `probeTimeoutMs` | int > 0 | `15000` | Timeout for the HEAD/GET probe in `media_probe`. |
| `maxBytes` | int > 0 | `524288000` | Maximum accepted file size (500 MB). |
| `blockOnProbeFailure` | boolean | `true` | Block posts whose media URL fails the probe, instead of warning. |

---

## `validation` — pre-post checks

```json
{
  "validation": {
    "enforceTextLimits": true,
    "rejectYoutubeHorizontalShort": true,
    "warnOnly": false
  }
}
```

| key | type | default | meaning |
| --- | --- | --- | --- |
| `enforceTextLimits` | boolean | `true` | Enforce per-platform caption limits (FB/YT 5000, IG 2196 with newline counted as 2). |
| `rejectYoutubeHorizontalShort` | boolean | `true` | Block horizontal videos of 60 s or less on YouTube, which Buffer treats as Shorts requiring portrait. |
| `warnOnly` | boolean | `false` | Turn blocking validation issues into warnings that still allow the post. |

---

## `safety` — write and destructive gates

```json
{
  "safety": {
    "allowDestructive": false,
    "dryRun": false,
    "requireConfirmToken": true,
    "allowSecretWrite": false
  }
}
```

| key | type | default | meaning |
| --- | --- | --- | --- |
| `allowDestructive` | boolean | `false` | Enables `buffer_update_post`, `buffer_delete_post`, `cloudinary_delete`, `buffer_reset_config`. |
| `dryRun` | boolean | `false` | Global preview mode: nothing is written to Buffer or Cloudinary. |
| `requireConfirmToken` | boolean | `true` | Write tools must receive the documented `confirm` string. |
| `allowSecretWrite` | boolean | `false` | Lets `buffer_set_config` persist secret paths to the config file. |

---

## `logging` — diagnostics

```json
{
  "logging": {
    "level": "info",
    "redact": true,
    "auditFile": null
  }
}
```

| key | type | default | meaning |
| --- | --- | --- | --- |
| `level` | `debug` \| `info` \| `warn` \| `error` | `info` | Log verbosity. Logs go to stderr so they never corrupt stdio MCP traffic. |
| `redact` | boolean | `true` | Scrub known secret values from every log line. |
| `auditFile` | string \| null | `null` | If set, append a JSON audit record of each write/destructive tool call. |

---

## `transport` — how the server is reachable

```json
{
  "transport": {
    "mode": "stdio",
    "http": {
      "host": "127.0.0.1",
      "port": 8787,
      "path": "/mcp",
      "authToken": "",
      "authTokenEnv": "MCP_HTTP_TOKEN",
      "corsOrigins": [],
      "sessionTtlMs": 1800000,
      "allowWrites": false,
      "maxBodyBytes": 1048576,
      "trustProxy": false,
      "allowedIps": [],
      "rateLimit": { "enabled": true, "windowMs": 60000, "max": 120 }
    }
  }
}
```

| key | type | default | meaning |
| --- | --- | --- | --- |
| `mode` | `stdio` \| `http` \| `both` | `stdio` | `stdio` for local editors, `http` for remote agents, `both` to serve both at once. |
| `http.host` | string | `127.0.0.1` | Bind address. Anything non-loopback **requires** a token or the server refuses to start. |
| `http.port` | int 1–65535 | `8787` | Listen port. |
| `http.path` | string | `/mcp` | URL path of the MCP endpoint (`GET /healthz` is separate and unauthenticated). |
| `http.authToken` | string | `""` | **Secret.** Bearer token expected on every MCP request. |
| `http.authTokenEnv` | string \| null | `MCP_HTTP_TOKEN` | Env var supplying the token; `null` disables the lookup. |
| `http.corsOrigins` | string[] | `[]` | Allowed `Origin` values; `["*"]` allows all. Empty means no CORS headers for browsers. |
| `http.sessionTtlMs` | int > 0 | `1800000` | Idle lifetime of an HTTP session (30 min) before it is swept. |
| `http.allowWrites` | boolean | `false` | Allow write tools over HTTP. Loopback stdio is unaffected. |
| `http.maxBodyBytes` | int > 0 | `1048576` | Maximum request body size (1 MB). |
| `http.trustProxy` | boolean | `false` | Honour `X-Forwarded-For` for client IP; enable only behind a trusted proxy. |
| `http.allowedIps` | string[] | `[]` | IP / CIDR allowlist (e.g. `"203.0.113.0/24"`). Empty allows all. |
| `http.rateLimit.enabled` | boolean | `true` | Enable per-IP request throttling. |
| `http.rateLimit.windowMs` | int > 0 | `60000` | Throttle window in milliseconds. |
| `http.rateLimit.max` | int > 0 | `120` | Maximum requests per IP per window. |

---

## Environment variables

| variable | maps to |
| --- | --- |
| `BUFFER_API_KEY` | `buffer.apiKey` (name comes from `buffer.apiKeyEnv`) |
| `BUFFER_API_URL` | `buffer.apiUrl` |
| `BUFFER_ORGANIZATION_ID` | `buffer.organizationId` |
| `BUFFER_DEFAULT_CHANNEL_IDS` | `buffer.defaultChannelIds` (comma-separated) |
| `BUFFER_MODE` | `scheduling.mode` |
| `BUFFER_TIMEZONE` | `scheduling.timezone` |
| `BUFFER_DRY_RUN` | `safety.dryRun` |
| `BUFFER_ALLOW_DESTRUCTIVE` | `safety.allowDestructive` |
| `CLOUDINARY_URL` | `cloudinary.cloudName` / `apiKey` / `apiSecret` |
| `CLOUDINARY_CLOUD_NAME` | `cloudinary.cloudName` |
| `CLOUDINARY_API_KEY` | `cloudinary.apiKey` |
| `CLOUDINARY_API_SECRET` | `cloudinary.apiSecret` |
| `CLOUDINARY_FOLDER` | `cloudinary.folder` |
| `MCP_TRANSPORT` | `transport.mode` |
| `MCP_HTTP_HOST` | `transport.http.host` |
| `MCP_HTTP_PORT` | `transport.http.port` |
| `MCP_HTTP_TOKEN` | `transport.http.authToken` (name comes from `http.authTokenEnv`) |
| `MCP_HTTP_ALLOW_WRITES` | `transport.http.allowWrites` |
| `BUFFER_MCP_CONFIG` | config file path |
| `BUFFER_MCP_LOG_LEVEL` | `logging.level` |
| `BUFFER_MCP_AUDIT_FILE` | `logging.auditFile` |

Boolean env vars accept `1/true/yes/on` and `0/false/no/off`.

---

## Recipes

**Local stdio, secrets from the environment**

```json
{
  "$schema": "./schema/config.schema.json",
  "buffer": { "organizationId": null },
  "scheduling": { "mode": "addToQueue", "timezone": "Asia/Shanghai" }
}
```

With `BUFFER_API_KEY` and `CLOUDINARY_URL` exported in the MCP client config.

**Preview everything, write nothing**

```json
{ "safety": { "dryRun": true } }
```

**Expose over HTTP behind a reverse proxy**

```json
{
  "transport": {
    "mode": "http",
    "http": {
      "host": "0.0.0.0",
      "port": 8787,
      "allowWrites": true,
      "trustProxy": true,
      "allowedIps": ["203.0.113.0/24"],
      "corsOrigins": ["https://app.example.com"],
      "rateLimit": { "enabled": true, "windowMs": 60000, "max": 60 }
    }
  }
}
```

`MCP_HTTP_TOKEN` must be set or startup fails.
