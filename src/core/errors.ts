export class AppError extends Error {
  constructor(
    message: string,
    readonly code = "APP_ERROR",
    readonly hint?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export interface GraphQLErrorLike {
  message: string;
  extensions?: { code?: string; [key: string]: unknown };
}

export class BufferApiError extends AppError {
  constructor(
    message: string,
    readonly status?: number,
    readonly graphQLErrors: GraphQLErrorLike[] = [],
  ) {
    super(message, "BUFFER_API_ERROR", hintForMessage(message), {
      status,
      codes: graphQLErrors.map((e) => e.extensions?.code).filter(Boolean),
    });
    this.name = "BufferApiError";
  }
}

const HINTS: Array<[RegExp, string]> = [
  [
    /could not be read from its URL/i,
    "Buffer could not fetch the media. Use an HTTPS URL whose endpoint answers HEAD with 200 (not 404/405) and serves a video/* or image/* content type. Cloudinary works; plain HTTP file servers often do not.",
  ],
  [
    /must be vertical .*YouTube Shorts/i,
    "Buffer classifies videos of 60 seconds or less as YouTube Shorts, which require a portrait (9:16) frame. Either export a vertical 1080x1920 version or make the video longer than 60 seconds.",
  ],
  [
    /YouTube posts require a category/i,
    "Pass metadata.youtube.categoryId (for example '2' = Autos & Vehicles, '28' = Science & Technology).",
  ],
  [
    /posts require a type/i,
    "Pass metadata.<service>.type. Facebook: post|story|reel. Instagram: post|story|reel.",
  ],
  [
    /shouldShareToFeed/i,
    "Instagram metadata requires shouldShareToFeed (boolean). Use true for feed posts.",
  ],
  [
    /BAD_USER_INPUT/i,
    "The request was rejected as invalid. Check the message for the specific field; free plans also cap aggregatedPostMetrics to the last 31 days.",
  ],
  [
    /Unauthorized|401/i,
    "The Buffer API key is missing, invalid, or expired. Set BUFFER_API_KEY to a current token.",
  ],
  [
    /429|rate limit/i,
    "Buffer is rate limiting. Retry after the indicated delay.",
  ],
];

export function hintForMessage(message: string): string | undefined {
  for (const [pattern, hint] of HINTS) {
    if (pattern.test(message)) return hint;
  }
  return undefined;
}

export function describeError(err: unknown): {
  message: string;
  code: string;
  hint?: string;
  details?: unknown;
} {
  if (err instanceof AppError) {
    return {
      message: err.message,
      code: err.code,
      hint: err.hint,
      details: err.details,
    };
  }
  if (err instanceof Error) {
    return { message: err.message, code: "ERROR" };
  }
  return { message: String(err), code: "UNKNOWN" };
}
