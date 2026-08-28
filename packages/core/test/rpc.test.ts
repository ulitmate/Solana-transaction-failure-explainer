import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/rpc";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RpcClient", () => {
  it("treats a JSON-RPC error as definitive even without a numeric code — exactly one attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, error: { message: "boom" } }));
    vi.stubGlobal("fetch", fetchMock);
    const rpc = new RpcClient({ url: "http://stub.invalid", maxRetries: 3 });
    await expect(rpc.call("getFoo", [])).rejects.toMatchObject({ name: "RpcError", definitive: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a network failure and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue(jsonResponse({ jsonrpc: "2.0", id: 1, result: 42 }));
    vi.stubGlobal("fetch", fetchMock);
    const rpc = new RpcClient({ url: "http://stub.invalid", maxRetries: 3 });
    await expect(rpc.call<number>("getFoo", [])).resolves.toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
