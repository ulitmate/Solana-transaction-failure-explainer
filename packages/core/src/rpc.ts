import type { GetTransactionResult, SignatureInfo, SignatureStatus } from "./types";

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    /** True for JSON-RPC error responses — a definitive answer from the node, never retried. */
    public readonly definitive: boolean = false,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RpcClientOptions {
  url?: string;
  /** Retries for HTTP 429/5xx and network errors. JSON-RPC errors are definitive and never retried. */
  maxRetries?: number;
  /** Client-side pacing between calls, so free public endpoints are not hammered. */
  minDelayMs?: number;
}

export class RpcClient {
  private nextId = 1;
  private lastCallAt = 0;

  constructor(private readonly opts: RpcClientOptions = {}) {}

  get url(): string {
    return this.opts.url ?? process.env.RPC_URL ?? DEFAULT_RPC;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? 5;
    const minDelay = this.opts.minDelayMs ?? 0;
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastCallAt + minDelay - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCallAt = Date.now();
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        });
        if (res.status === 429 || res.status >= 500) {
          if (attempt >= maxRetries) throw new RpcError(`${method}: HTTP ${res.status} after ${attempt + 1} attempts`);
          const retryAfter = Number(res.headers.get("retry-after")) * 1000 || 0;
          await sleep(Math.max(retryAfter, 500 * 2 ** attempt));
          continue;
        }
        const body = (await res.json()) as { result?: T; error?: { code?: number; message: string } };
        if (body.error) throw new RpcError(`${method}: ${body.error.message}`, body.error.code, true);
        return body.result as T;
      } catch (e) {
        if (e instanceof RpcError && e.definitive) throw e;
        if (attempt >= maxRetries) throw e;
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  /**
   * Failed transactions return full data — nothing special is needed to analyse failures.
   * `confirmed` is not final; anything cached long-term must be re-fetched at `finalized`.
   */
  getTransaction(signature: string): Promise<GetTransactionResult | null> {
    return this.call("getTransaction", [
      signature,
      { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "confirmed" },
    ]);
  }

  getSignaturesForAddress(
    address: string,
    opts: { limit?: number; before?: string } = {},
  ): Promise<SignatureInfo[]> {
    return this.call("getSignaturesForAddress", [
      address,
      { limit: opts.limit ?? 100, ...(opts.before ? { before: opts.before } : {}), commitment: "confirmed" },
    ]);
  }

  getSignatureStatuses(signatures: string[]): Promise<{ value: (SignatureStatus | null)[] }> {
    return this.call("getSignatureStatuses", [signatures, { searchTransactionHistory: true }]);
  }
}
