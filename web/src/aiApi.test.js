import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiApiError, ai, aiApi, downloadDocument, streamChat, uploadDocument } from "./aiApi.js";
import { setToken } from "./api.js";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function sseResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** A fetch stand-in that resolves only when its signal aborts. */
function hangingFetch() {
  return (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("aiApi request building", () => {
  it("prefixes requests and attaches the shared session token", async () => {
    setToken("session-token-123");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await aiApi("/health");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/ai/health");
    expect(opts.headers.Authorization).toBe("Bearer session-token-123");
    expect(opts.method).toBe("GET");
  });

  it("omits the Authorization header when unauthenticated", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await aiApi("/models");

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it("serializes a JSON body and sets Content-Type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await aiApi("/chat", { method: "POST", body: { messages: [] } });

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(opts.body).toBe(JSON.stringify({ messages: [] }));
  });

  it("builds query strings for filtered list endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await ai.sources({ limit: 10, offset: 0, q: "" });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/ai/knowledge/sources?limit=10&offset=0");
  });
});

describe("aiApi error handling", () => {
  it("maps the AI error envelope into AiApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { error: { code: "forbidden", message: "Not allowed", details: { perm: "ai.agents:execute" } } },
          { status: 403, headers: { "x-request-id": "req-42" } },
        ),
      ),
    );

    const err = await aiApi("/agents/1/execute", { method: "POST", body: {} }).catch((e) => e);

    expect(err).toBeInstanceOf(AiApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("forbidden");
    expect(err.message).toBe("Not allowed");
    expect(err.requestId).toBe("req-42");
    expect(err.details).toEqual({ perm: "ai.agents:execute" });
  });

  it("falls back gracefully when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("upstream exploded", { status: 502, headers: { "x-request-id": "req-9" } }),
      ),
    );

    const err = await ai.chat({ messages: [] }).catch((e) => e);

    expect(err).toBeInstanceOf(AiApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe("http_error");
    expect(err.message).toContain("502");
    expect(err.requestId).toBe("req-9");
  });

  it("reports a timeout as an aborted AiApiError", async () => {
    vi.stubGlobal("fetch", hangingFetch());

    const err = await aiApi("/health", { timeoutMs: 10 }).catch((e) => e);

    expect(err).toBeInstanceOf(AiApiError);
    expect(err.code).toBe("aborted");
    expect(err.status).toBe(0);
  });
});

describe("document upload/download", () => {
  it("posts multipart form data without a Content-Type header", async () => {
    setToken("tok-1");
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ document: { external_id: "f" }, job: { id: 1, status: "queued" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const res = await uploadDocument(3, file);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/ai/knowledge/sources/3/upload");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBeInstanceOf(FormData);
    expect(opts.headers["Content-Type"]).toBeUndefined();
    expect(opts.headers.Authorization).toBe("Bearer tok-1");
    expect(res.job.status).toBe("queued");
  });

  it("downloads bytes with the session token and triggers a blob save", async () => {
    setToken("tok-2");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(["bytes"]), {
        status: 200,
        headers: { "Content-Disposition": 'attachment; filename="report.pdf"' },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn(() => "blob:fake");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await downloadDocument(9);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/ai/knowledge/documents/9/download");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok-2");
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });
});

describe("streamChat", () => {
  it("emits delta events and returns the done payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'event: delta\ndata: {"content":"Hel"}\n\n',
          'event: delta\ndata: {"content":"lo"}\n\n',
          'event: done\ndata: {"model":"mock-chat","provider":"mock","is_mock":true,"usage":{"total_tokens":7}}\n\n',
        ]),
      ),
    );

    const events = [];
    const done = await streamChat({ messages: [{ role: "user", content: "hi" }] }, {
      onEvent: (evt) => events.push(evt),
    });

    expect(events.filter((e) => e.type === "delta").map((e) => e.content)).toEqual(["Hel", "lo"]);
    expect(done).toMatchObject({ model: "mock-chat", is_mock: true });
  });

  it("throws when the stream reports an error frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse(['event: error\ndata: {"code":"provider_error","message":"boom"}\n\n']),
      ),
    );

    const err = await streamChat({ messages: [] }).catch((e) => e);

    expect(err).toBeInstanceOf(AiApiError);
    expect(err.code).toBe("provider_error");
    expect(err.status).toBe(502);
  });

  it("surfaces a non-OK response before streaming begins", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ error: { code: "unauthorized", message: "Sign in" } }, { status: 401 }),
      ),
    );

    const err = await streamChat({ messages: [] }).catch((e) => e);

    expect(err).toBeInstanceOf(AiApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("unauthorized");
  });
});
