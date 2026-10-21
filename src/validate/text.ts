export const TEXT_LIMITS: Record<string, number> = {
  facebook: 5000,
  instagram: 2196,
  youtube: 5000,
  threads: 500,
  bluesky: 300,
  linkedin: 3000,
  twitter: 280,
  x: 280,
  tiktok: 2200,
  pinterest: 500,
  mastodon: 500,
  googlebusiness: 1500,
  whatsapp: 1024,
  substack: 10000,
};

export interface TextCheck {
  service: string;
  used: number;
  limit: number;
  ok: boolean;
  option: "utf16" | "instagram";
}

export function measureText(text: string, service: string): number {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (service === "instagram") {
    const newlines = (normalized.match(/\n/g) ?? []).length;
    return normalized.length + newlines;
  }
  return normalized.length;
}

export function checkText(text: string, service: string): TextCheck {
  const limit = TEXT_LIMITS[service] ?? Number.POSITIVE_INFINITY;
  const used = measureText(text, service);
  return {
    service,
    used,
    limit,
    ok: used <= limit,
    option: service === "instagram" ? "instagram" : "utf16",
  };
}
