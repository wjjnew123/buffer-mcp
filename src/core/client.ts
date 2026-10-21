import type { ResolvedConfig } from "../config/schema.js";
import { AppError, BufferApiError, type GraphQLErrorLike } from "./errors.js";
import type { Logger } from "./logger.js";

interface GraphQLEnvelope<T> {
  data?: T;
  errors?: GraphQLErrorLike[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BufferClient {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly logger: Logger,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get apiKey(): string {
    const key = this.config.buffer.apiKey || this.env[this.config.buffer.apiKeyEnv] || "";
    if (!key) {
      throw new AppError(
        "Buffer API key is not configured.",
        "MISSING_BUFFER_KEY",
        `Set the ${this.config.buffer.apiKeyEnv} environment variable or buffer.apiKey in the config file.`,
      );
    }
    return key;
  }

  hasApiKey(): boolean {
    try {
      return Boolean(this.apiKey);
    } catch {
      return false;
    }
  }

  async graphql<T>(
    document: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const attempts = this.config.buffer.retries + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.execute<T>(document, variables);
      } catch (err) {
        lastError = err;
        const retryable = this.isRetryable(err);
        if (!retryable || attempt === attempts - 1) throw err;
        const delay = this.config.buffer.retryDelayMs * 2 ** attempt;
        this.logger.warn("Retrying Buffer request", {
          attempt: attempt + 1,
          delayMs: delay,
          reason: err instanceof Error ? err.message : String(err),
        });
        await sleep(delay);
      }
    }

    throw lastError instanceof Error ? lastError : new AppError(String(lastError));
  }

  private isRetryable(err: unknown): boolean {
    if (err instanceof BufferApiError) {
      if (err.status === 429) return true;
      if (err.status && err.status >= 500) return true;
      return false;
    }
    if (err instanceof Error) {
      return err.name === "AbortError" || /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(err.message);
    }
    return false;
  }

  private async execute<T>(
    document: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.buffer.timeoutMs,
    );

    this.logger.debug("Buffer GraphQL request", {
      endpoint: this.config.buffer.apiUrl,
      operation: firstOperationName(document),
      variables,
    });

    try {
      const response = await fetch(this.config.buffer.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ query: document, variables }),
        signal: controller.signal,
      });

      const text = await response.text();
      let envelope: GraphQLEnvelope<T>;
      try {
        envelope = JSON.parse(text) as GraphQLEnvelope<T>;
      } catch {
        throw new BufferApiError(
          `Buffer API returned a non-JSON response (HTTP ${response.status}).`,
          response.status,
        );
      }

      if (!response.ok) {
        const message = envelope.errors?.map((e) => e.message).join("; ") ||
          `Buffer API request failed with HTTP ${response.status}.`;
        throw new BufferApiError(message, response.status, envelope.errors ?? []);
      }

      if (envelope.errors?.length) {
        throw new BufferApiError(
          envelope.errors.map((e) => e.message).join("; "),
          response.status,
          envelope.errors,
        );
      }

      if (envelope.data === undefined) {
        throw new BufferApiError("Buffer API returned no data.", response.status);
      }

      return envelope.data;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AppError(
          `Buffer API request timed out after ${this.config.buffer.timeoutMs} ms.`,
          "BUFFER_TIMEOUT",
          "Increase buffer.timeoutMs for large media validations.",
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function firstOperationName(document: string): string {
  const match = /^\s*(query|mutation)\s+([A-Za-z0-9_]+)/.exec(document);
  return match ? match[2] : "anonymous";
}
