// Client for the Enterprise AI Platform API (FastAPI service).
//
// It reuses the same enterprise session token as the rest of the console
// (see ./api.js) but speaks the AI API's own error envelope
// (`{ error: { code, message, details, request_id } }`). Requests are issued
// against the `/api/v1/ai` prefix, which Vite proxies to the AI service so the
// whole console stays on a single public port.

// @ts-check
import { getToken } from "./api.js";

const AI_BASE = "/api/v1/ai";
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * @typedef {Object} AiModelCapability
 * @property {string} kind
 * @property {number|null} context_window
 * @property {number|null} max_output_tokens
 * @property {boolean} supports_streaming
 * @property {boolean} supports_tools
 * @property {boolean} supports_json_mode
 * @property {number|null} embedding_dimensions
 *
 * @typedef {Object} AiModel
 * @property {string} code
 * @property {string} provider
 * @property {boolean} is_mock
 * @property {AiModelCapability} capability
 *
 * @typedef {Object} AiProvider
 * @property {string} provider
 * @property {boolean} available
 * @property {boolean} is_mock
 * @property {AiModel[]} models
 *
 * @typedef {Object} AiUsage
 * @property {number} input_tokens
 * @property {number} output_tokens
 * @property {number} total_tokens
 *
 * @typedef {Object} AiCitation
 * @property {number} rank
 * @property {number} source_id
 * @property {string} source_code
 * @property {number} document_id
 * @property {number} chunk_id
 * @property {number} chunk_index
 * @property {number|null} page
 * @property {string|null} section
 * @property {number} score
 * @property {string} snippet
 */

export class AiApiError extends Error {
  constructor(status, code, message, requestId, details) {
    super(message);
    this.name = "AiApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

/** Combine a caller signal with an internal timeout into one AbortSignal. */
function withTimeout({ signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

export async function aiApi(
  path,
  { method = "GET", body, headers: extraHeaders, timeoutMs, signal } = {},
) {
  const headers = { Accept: "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (extraHeaders) Object.assign(headers, extraHeaders);

  const timeout = withTimeout({ signal, timeoutMs });
  let res;
  try {
    res = await fetch(`${AI_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: timeout.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new AiApiError(0, "aborted", "Request was cancelled or timed out");
    }
    throw err;
  } finally {
    timeout.cleanup();
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const err = data?.error;
    throw new AiApiError(
      res.status,
      err?.code || "http_error",
      err?.message || `Request failed (${res.status})`,
      err?.request_id || res.headers.get("x-request-id"),
      err?.details || {},
    );
  }
  return data;
}

/**
 * Download a document's stored bytes. Fetched with the session token (the
 * endpoint is authorization-gated), then handed to the browser as a blob — the
 * platform never exposes a public object-storage URL.
 * @param {number|string} documentId
 * @param {string} [filename]
 */
export async function downloadDocument(documentId, filename) {
  const headers = { Accept: "*/*" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${AI_BASE}/knowledge/documents/${documentId}/download`, { headers });
  if (!res.ok) {
    let code = "http_error";
    let message = `Download failed (${res.status})`;
    let requestId = res.headers.get("x-request-id");
    try {
      const data = await res.json();
      code = data?.error?.code || code;
      message = data?.error?.message || message;
      requestId = data?.error?.request_id || requestId;
    } catch {
      /* non-JSON error body */
    }
    throw new AiApiError(res.status, code, message, requestId);
  }

  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") || "";
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const name = filename || (match ? match[1] : `document-${documentId}`);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function qs(params) {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  });
  const str = search.toString();
  return str ? `?${str}` : "";
}

/**
 * Upload a file (multipart/form-data) to a knowledge source. The browser sets
 * the multipart boundary, so no Content-Type header is set here.
 * @param {number|string} sourceId
 * @param {File} file
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
 */
export async function uploadDocument(sourceId, file, { signal, timeoutMs } = {}) {
  const form = new FormData();
  form.append("file", file);
  const headers = { Accept: "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const timeout = withTimeout({ signal, timeoutMs });
  let res;
  try {
    res = await fetch(`${AI_BASE}/knowledge/sources/${sourceId}/upload`, {
      method: "POST",
      headers,
      body: form,
      signal: timeout.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new AiApiError(0, "aborted", "Request was cancelled or timed out");
    }
    throw err;
  } finally {
    timeout.cleanup();
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = data?.error;
    throw new AiApiError(
      res.status,
      err?.code || "http_error",
      err?.message || `Request failed (${res.status})`,
      err?.request_id || res.headers.get("x-request-id"),
      err?.details || {},
    );
  }
  return data;
}

function parseFrame(frame) {
  let event = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  const raw = dataLines.join("\n");
  if (!raw) return null;
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }
  return { event, data };
}

/**
 * Stream a chat completion via Server-Sent Events.
 * @param {{ messages: Array<{role: string, content: string}>, model?: string|null }} body
 * @param {{ signal?: AbortSignal, timeoutMs?: number, onEvent?: (evt: Object) => void }} [opts]
 * @returns {Promise<Object|null>} the `done` payload, if one was received
 */
export async function streamChat(body, { signal, timeoutMs, onEvent } = {}) {
  const headers = { Accept: "text/event-stream", "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const timeout = withTimeout({ signal, timeoutMs });
  let res;
  try {
    res = await fetch(`${AI_BASE}/chat/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: timeout.signal,
    });
  } catch (err) {
    timeout.cleanup();
    if (err?.name === "AbortError") {
      throw new AiApiError(0, "aborted", "Streaming was cancelled or timed out");
    }
    throw err;
  }

  if (!res.ok) {
    timeout.cleanup();
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const err = data?.error;
    throw new AiApiError(
      res.status,
      err?.code || "http_error",
      err?.message || `Request failed (${res.status})`,
      err?.request_id,
      err?.details,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseFrame(frame);
        if (!parsed) continue;
        if (parsed.event === "delta") {
          onEvent?.({ type: "delta", content: parsed.data.content });
        } else if (parsed.event === "done") {
          donePayload = parsed.data;
          onEvent?.({ type: "done", ...parsed.data });
        } else if (parsed.event === "error") {
          onEvent?.({ type: "error", ...parsed.data });
          throw new AiApiError(502, parsed.data.code, parsed.data.message);
        }
      }
    }
  } finally {
    timeout.cleanup();
    reader.releaseLock?.();
  }
  return donePayload;
}

export const ai = {
  health: () => aiApi("/health"),
  capabilities: () => aiApi("/capabilities"),
  models: () => aiApi("/models"),
  providers: () => aiApi("/providers"),

  chat: (body, opts) => aiApi("/chat", { method: "POST", body, ...opts }),
  summarize: (body) => aiApi("/summarize", { method: "POST", body }),
  search: (body) => aiApi("/search", { method: "POST", body }),
  rag: (body) => aiApi("/rag/query", { method: "POST", body }),

  sources: (params) => aiApi(`/knowledge/sources${qs(params)}`),
  createSource: (body) => aiApi("/knowledge/sources", { method: "POST", body }),
  deleteSource: (id) => aiApi(`/knowledge/sources/${id}`, { method: "DELETE" }),
  documents: (sourceId, params) => aiApi(`/knowledge/sources/${sourceId}/documents${qs(params)}`),
  ingest: (sourceId, body) =>
    aiApi(`/knowledge/sources/${sourceId}/ingest`, { method: "POST", body }),
  uploadDocument: (sourceId, file, opts) => uploadDocument(sourceId, file, opts),
  reindexSource: (sourceId) =>
    aiApi(`/knowledge/sources/${sourceId}/reindex`, { method: "POST" }),
  deleteDocument: (id) => aiApi(`/knowledge/documents/${id}`, { method: "DELETE" }),
  downloadDocument: (id, filename) => downloadDocument(id, filename),
  requestIndex: (body) => aiApi("/knowledge/index", { method: "POST", body }),
  retryJob: (id) => aiApi(`/knowledge/jobs/${id}/retry`, { method: "POST" }),
  job: (id) => aiApi(`/knowledge/jobs/${id}`),
  jobs: (params) => aiApi(`/knowledge/jobs${qs(params)}`),

  conversations: (params) => aiApi(`/assistant/conversations${qs(params)}`),
  createConversation: (body) => aiApi("/assistant/conversations", { method: "POST", body }),
  conversation: (id) => aiApi(`/assistant/conversations/${id}`),
  deleteConversation: (id) => aiApi(`/assistant/conversations/${id}`, { method: "DELETE" }),
  sendAssistantMessage: (id, body) =>
    aiApi(`/assistant/conversations/${id}/messages`, { method: "POST", body }),
  assistantFeedback: (body) => aiApi("/assistant/feedback", { method: "POST", body }),

  audit: (params) => aiApi(`/audit${qs(params)}`),

  usage: (params) => aiApi(`/usage${qs(params)}`),
  usageRecords: (params) => aiApi(`/usage/records${qs(params)}`),

  feedback: (params) => aiApi(`/feedback${qs(params)}`),
  createFeedback: (body) => aiApi("/feedback", { method: "POST", body }),

  agents: () => aiApi("/agents"),
  agent: (id) => aiApi(`/agents/${id}`),
  agentVersions: (id) => aiApi(`/agents/${id}/versions`),
  agentExecutions: (params) => aiApi(`/agents/executions${qs(params)}`),
  executeAgent: (id, body) => aiApi(`/agents/${id}/execute`, { method: "POST", body }),

  events: (params) => aiApi(`/events${qs(params)}`),
  deadLetters: (params) => aiApi(`/events/dead-letters${qs(params)}`),
  eventStats: (params) => aiApi(`/events/stats${qs(params)}`),
  replayEvent: (eventId, params) =>
    aiApi(`/events/${encodeURIComponent(eventId)}/replay${qs(params)}`, { method: "POST" }),

  mlStatus: () => aiApi("/ml/status"),
  experiments: (params) => aiApi(`/ml/experiments${qs(params)}`),
  createExperiment: (body) => aiApi("/ml/experiments", { method: "POST", body }),
  experiment: (id) => aiApi(`/ml/experiments/${id}`),
  runs: (params) => aiApi(`/ml/runs${qs(params)}`),
  createRun: (experimentId, body) =>
    aiApi(`/ml/experiments/${experimentId}/runs`, { method: "POST", body }),
  finishRun: (id, body) => aiApi(`/ml/runs/${id}/finish`, { method: "POST", body }),
  mlModels: (params) => aiApi(`/ml/models${qs(params)}`),
  registerMlModel: (body) => aiApi("/ml/models", { method: "POST", body }),
  mlModel: (id) => aiApi(`/ml/models/${id}`),
  modelVersions: (id) => aiApi(`/ml/models/${id}/versions`),
  createModelVersion: (id, body) =>
    aiApi(`/ml/models/${id}/versions`, { method: "POST", body }),
  setModelVersionStatus: (id, version, body) =>
    aiApi(`/ml/models/${id}/versions/${version}/status`, { method: "POST", body }),
  mlEvaluations: (params) => aiApi(`/ml/evaluations${qs(params)}`),
  createMlEvaluation: (body) => aiApi("/ml/evaluations", { method: "POST", body }),
  mlEvaluationResults: (id, params) => aiApi(`/ml/evaluations/${id}/results${qs(params)}`),
};
