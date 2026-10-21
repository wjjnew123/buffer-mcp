export interface ProbeResult {
  url: string;
  https: boolean;
  ok: boolean;
  status?: number;
  contentType?: string;
  contentLength?: number;
  supportsHead: boolean;
  supportsRange: boolean;
  error?: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
}

function parseTotalLength(contentRange: string | null): number | undefined {
  if (!contentRange) return undefined;
  const match = /\/(\d+)\s*$/.exec(contentRange);
  if (!match) return undefined;
  return Number(match[1]);
}

export async function probeUrl(
  rawUrl: string,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      url: rawUrl,
      https: false,
      ok: false,
      supportsHead: false,
      supportsRange: false,
      error: "Invalid URL",
    };
  }

  const https = url.protocol === "https:";
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const signal = () => AbortSignal.timeout(timeoutMs);

  const base: ProbeResult = {
    url: rawUrl,
    https,
    ok: false,
    supportsHead: false,
    supportsRange: false,
  };

  try {
    const head = await fetch(url, { method: "HEAD", signal: signal(), redirect: "follow" });
    const contentType = head.headers.get("content-type") ?? undefined;
    if (head.ok) {
      return {
        ...base,
        ok: true,
        status: head.status,
        contentType,
        contentLength: Number(head.headers.get("content-length")) || undefined,
        supportsHead: true,
        supportsRange: /bytes/i.test(head.headers.get("accept-ranges") ?? ""),
      };
    }
    base.status = head.status;
    base.error = `HEAD returned HTTP ${head.status}`;
  } catch (err) {
    base.error = `HEAD failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    const get = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-1023" },
      signal: signal(),
      redirect: "follow",
    });
    const contentType = get.headers.get("content-type") ?? undefined;
    const supportsRange = get.status === 206;

    if (get.ok || supportsRange) {
      await get.body?.cancel();
      return {
        ...base,
        ok: true,
        status: get.status,
        contentType,
        contentLength:
          parseTotalLength(get.headers.get("content-range")) ??
          (Number(get.headers.get("content-length")) || undefined),
        supportsRange,
        error: base.error,
      };
    }
    await get.body?.cancel();
    base.status = get.status;
    base.error = `GET returned HTTP ${get.status}`;
    return base;
  } catch (err) {
    base.error = `${base.error ?? ""} GET failed: ${err instanceof Error ? err.message : String(err)}`.trim();
    return base;
  }
}

export function mediaKindOf(contentType: string | undefined): "image" | "video" | "unknown" {
  if (!contentType) return "unknown";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  return "unknown";
}
