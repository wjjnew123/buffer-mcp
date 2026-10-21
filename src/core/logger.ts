export type LogLevel = "debug" | "info" | "warn" | "error";

const WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_KEY_RE =
  /(api[-_]?key|api[-_]?secret|authorization|password|passwd|secret|token|signature)/i;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const CLOUDINARY_URL_RE = /cloudinary:\/\/[^\s"'`]+/gi;

export function redactText(text: string): string {
  return text
    .replace(BEARER_RE, "Bearer ***")
    .replace(CLOUDINARY_URL_RE, "cloudinary://***");
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key) ? "***" : redactValue(child, depth + 1);
  }
  return out;
}

export class Logger {
  constructor(
    private readonly level: LogLevel = "info",
    private readonly redaction = true,
  ) {}

  child(): Logger {
    return this;
  }

  debug(message: string, meta?: unknown): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (WEIGHT[level] < WEIGHT[this.level]) return;
    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      msg: this.redaction ? redactText(message) : message,
    };
    if (meta !== undefined) {
      record.meta = this.redaction ? redactValue(meta) : meta;
    }
    try {
      process.stderr.write(`${JSON.stringify(record)}\n`);
    } catch {
      /* stderr unavailable */
    }
  }
}
