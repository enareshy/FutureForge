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
async function streamSse(path, body, { signal, timeoutMs, onEvent } = {}) {
  const headers = { Accept: "text/event-stream", "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const timeout = withTimeout({ signal, timeoutMs });
  let res;
  try {
    res = await fetch(`${AI_BASE}${path}`, {
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
        if (parsed.event === "start") {
          onEvent?.({ type: "start", ...parsed.data });
        } else if (parsed.event === "delta") {
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

/**
 * Stream a chat completion via Server-Sent Events.
 * @param {{ messages: Array<{role: string, content: string}>, model?: string|null }} body
 * @param {{ signal?: AbortSignal, timeoutMs?: number, onEvent?: (evt: Object) => void }} [opts]
 * @returns {Promise<Object|null>} the `done` payload, if one was received
 */
export async function streamChat(body, opts = {}) {
  return streamSse("/chat/stream", body, opts);
}

/**
 * Stream a grounded Copilot answer. The `start` event carries the persisted
 * message id and citations; `done` carries the final status.
 */
export async function streamAssistantMessage(conversationId, body, opts = {}) {
  return streamSse(
    `/assistant/conversations/${conversationId}/messages/stream`,
    body,
    opts,
  );
}

export const ai = {
  health: () => aiApi("/health"),
  capabilities: () => aiApi("/capabilities"),
  models: () => aiApi("/models"),
  providers: () => aiApi("/providers"),

  chat: (body, opts) => aiApi("/chat", { method: "POST", body, ...opts }),
  summarize: (body) => aiApi("/summarize", { method: "POST", body }),
  search: (body) => aiApi("/search", { method: "POST", body }),
  searchFacets: (params) => aiApi(`/search/facets${qs(params)}`),
  searchSuggestions: (params) => aiApi(`/search/suggestions${qs(params)}`),
  searchHealth: () => aiApi("/search/health"),
  savedSearches: (params) => aiApi(`/search/saved${qs(params)}`),
  createSavedSearch: (body) => aiApi("/search/saved", { method: "POST", body }),
  deleteSavedSearch: (id) => aiApi(`/search/saved/${id}`, { method: "DELETE" }),
  searchHistory: (params) => aiApi(`/search/history${qs(params)}`),
  clearSearchHistory: () => aiApi("/search/history", { method: "DELETE" }),
  deleteSearchHistory: (id) => aiApi(`/search/history/${id}`, { method: "DELETE" }),
  indexStatus: () => aiApi("/knowledge/index-status"),
  reconcileIndex: () => aiApi("/knowledge/reconcile", { method: "POST" }),
  duplicates: (params) => aiApi(`/knowledge/duplicates${qs(params)}`),
  scanDuplicates: () => aiApi("/knowledge/duplicates/scan", { method: "POST" }),
  reviewDuplicate: (id, body) =>
    aiApi(`/knowledge/duplicates/${id}/review`, { method: "POST", body }),
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
  document: (id) => aiApi(`/knowledge/documents/${id}`),
  updateDocument: (id, body) =>
    aiApi(`/knowledge/documents/${id}`, { method: "PATCH", body }),
  documentVersions: (id, params) =>
    aiApi(`/knowledge/documents/${id}/versions${qs(params)}`),
  reindexDocument: (id) =>
    aiApi(`/knowledge/documents/${id}/reindex`, { method: "POST" }),
  downloadDocument: (id, filename) => downloadDocument(id, filename),
  requestIndex: (body) => aiApi("/knowledge/index", { method: "POST", body }),
  retryJob: (id) => aiApi(`/knowledge/jobs/${id}/retry`, { method: "POST" }),
  job: (id) => aiApi(`/knowledge/jobs/${id}`),
  jobs: (params) => aiApi(`/knowledge/jobs${qs(params)}`),

  copilotCapabilities: () => aiApi("/assistant/capabilities"),
  conversations: (params) => aiApi(`/assistant/conversations${qs(params)}`),
  createConversation: (body) => aiApi("/assistant/conversations", { method: "POST", body }),
  conversation: (id, params) => aiApi(`/assistant/conversations/${id}${qs(params)}`),
  updateConversation: (id, body) =>
    aiApi(`/assistant/conversations/${id}`, { method: "PATCH", body }),
  deleteConversation: (id) => aiApi(`/assistant/conversations/${id}`, { method: "DELETE" }),
  conversationMessages: (id, params) =>
    aiApi(`/assistant/conversations/${id}/messages${qs(params)}`),
  sendAssistantMessage: (id, body) =>
    aiApi(`/assistant/conversations/${id}/messages`, { method: "POST", body }),
  cancelGeneration: (id) =>
    aiApi(`/assistant/conversations/${id}/cancel`, { method: "POST" }),
  summarize: (body) => aiApi("/assistant/summarize", { method: "POST", body }),
  explain: (body) => aiApi("/assistant/explain", { method: "POST", body }),
  compare: (body) => aiApi("/assistant/compare", { method: "POST", body }),
  extract: (body) => aiApi("/assistant/extract", { method: "POST", body }),
  assistantFeedback: (body) => aiApi("/assistant/feedback", { method: "POST", body }),
  assistantActions: (params) => aiApi(`/assistant/actions${qs(params)}`),
  proposeAssistantAction: (body) =>
    aiApi("/assistant/actions", { method: "POST", body }),
  assistantAction: (id) => aiApi(`/assistant/actions/${id}`),
  approveAssistantAction: (id, body = {}) =>
    aiApi(`/assistant/actions/${id}/approve`, { method: "POST", body }),
  rejectAssistantAction: (id, body) =>
    aiApi(`/assistant/actions/${id}/reject`, { method: "POST", body }),
  executeAssistantAction: (id) =>
    aiApi(`/assistant/actions/${id}/execute`, { method: "POST" }),

  audit: (params) => aiApi(`/audit${qs(params)}`),

  usage: (params) => aiApi(`/usage${qs(params)}`),
  usageRecords: (params) => aiApi(`/usage/records${qs(params)}`),

  feedback: (params) => aiApi(`/feedback${qs(params)}`),
  createFeedback: (body) => aiApi("/feedback", { method: "POST", body }),

  agents: (params) => aiApi(`/agents${qs(params)}`),
  agent: (id) => aiApi(`/agents/${id}`),
  createAgent: (body) => aiApi("/agents", { method: "POST", body }),
  updateAgent: (id, body) => aiApi(`/agents/${id}`, { method: "PATCH", body }),
  validateAgent: (id, body = {}) =>
    aiApi(`/agents/${id}/validate`, { method: "POST", body }),
  publishAgent: (id, body = {}) =>
    aiApi(`/agents/${id}/publish`, { method: "POST", body }),
  disableAgent: (id, body = {}) =>
    aiApi(`/agents/${id}/disable`, { method: "POST", body }),
  rollbackAgent: (id, body) =>
    aiApi(`/agents/${id}/rollback`, { method: "POST", body }),
  agentVersions: (id) => aiApi(`/agents/${id}/versions`),
  agentVersionTools: (id, versionId) =>
    aiApi(`/agents/${id}/versions/${versionId}/tools`),
  agentExecutions: (params) => aiApi(`/agent-executions${qs(params)}`),
  agentExecution: (id) => aiApi(`/agent-executions/${id}`),
  agentExecutionTrace: (id) => aiApi(`/agent-executions/${id}/trace`),
  agentExecutionResult: (id) => aiApi(`/agent-executions/${id}/result`),
  createAgentExecution: (body) =>
    aiApi("/agent-executions", { method: "POST", body }),
  cancelAgentExecution: (id) =>
    aiApi(`/agent-executions/${id}/cancel`, { method: "POST" }),
  retryAgentExecution: (id) =>
    aiApi(`/agent-executions/${id}/retry`, { method: "POST" }),
  executeAgent: (id, body) => aiApi(`/agents/${id}/execute`, { method: "POST", body }),
  agentTools: (params) => aiApi(`/agent-tools${qs(params)}`),
  agentTool: (id) => aiApi(`/agent-tools/${id}`),
  createAgentTool: (body) => aiApi("/agent-tools", { method: "POST", body }),
  updateAgentTool: (id, body) =>
    aiApi(`/agent-tools/${id}`, { method: "PATCH", body }),
  agentToolVersions: (id) => aiApi(`/agent-tools/${id}/versions`),
  createAgentToolVersion: (id, body) =>
    aiApi(`/agent-tools/${id}/versions`, { method: "POST", body }),
  validateAgentTool: (id, params) =>
    aiApi(`/agent-tools/${id}/validate${qs(params)}`, { method: "POST" }),
  publishAgentTool: (id, params) =>
    aiApi(`/agent-tools/${id}/publish${qs(params)}`, { method: "POST" }),
  activateAgent: (id, body = {}) =>
    aiApi(`/agents/${id}/activate`, { method: "POST", body }),
  deactivateAgent: (id, body = {}) =>
    aiApi(`/agents/${id}/deactivate`, { method: "POST", body }),
  suspendAgent: (id, body = {}) =>
    aiApi(`/agents/${id}/suspend`, { method: "POST", body }),
  duplicateAgent: (id, body) =>
    aiApi(`/agents/${id}/duplicate`, { method: "POST", body }),
  deleteAgent: (id, body) =>
    aiApi(`/agents/${id}`, { method: "DELETE", body }),
  agentWorkingConfig: (id) => aiApi(`/agents/${id}/working-config`),
  updateAgentWorkingConfig: (id, body) =>
    aiApi(`/agents/${id}/working-config`, { method: "PUT", body }),
  agentTemplates: (params) => aiApi(`/agent-templates${qs(params)}`),
  agentTemplate: (id) => aiApi(`/agent-templates/${id}`),
  instantiateAgentTemplate: (id, body) =>
    aiApi(`/agent-templates/${id}/instantiate`, { method: "POST", body }),
  agentMemory: (params) => aiApi(`/agent-memory${qs(params)}`),
  writeAgentMemory: (body) => aiApi("/agent-memory", { method: "POST", body }),
  deleteAgentMemory: (id) => aiApi(`/agent-memory/${id}`, { method: "DELETE" }),
  purgeAgentMemory: () => aiApi("/agent-memory/purge", { method: "POST" }),
  agentSchedules: (params) => aiApi(`/agent-schedules${qs(params)}`),
  agentSchedule: (id) => aiApi(`/agent-schedules/${id}`),
  createAgentSchedule: (body) =>
    aiApi("/agent-schedules", { method: "POST", body }),
  updateAgentSchedule: (id, body) =>
    aiApi(`/agent-schedules/${id}`, { method: "PATCH", body }),
  deleteAgentSchedule: (id) =>
    aiApi(`/agent-schedules/${id}`, { method: "DELETE" }),
  agentMonitoringOverview: () => aiApi("/agent-monitoring/overview"),
  agentMonitoringFailures: (params) =>
    aiApi(`/agent-monitoring/failures${qs(params)}`),
  agentStats: (id) => aiApi(`/agents/${id}/stats`),
  agentHealth: (id) => aiApi(`/agents/${id}/health`),
  agentExecutionDelegations: (id) =>
    aiApi(`/agent-executions/${id}/delegations`),
  agentApprovals: (params) => aiApi(`/agent-approvals${qs(params)}`),
  agentApproval: (id) => aiApi(`/agent-approvals/${id}`),
  approveAgentApproval: (id, body = {}) =>
    aiApi(`/agent-approvals/${id}/approve`, { method: "POST", body }),
  rejectAgentApproval: (id, body) =>
    aiApi(`/agent-approvals/${id}/reject`, { method: "POST", body }),

  graphTypes: () => aiApi("/graph/types"),
  graphStats: () => aiApi("/graph/stats"),
  graphEntities: (params) => aiApi(`/graph/entities${qs(params)}`),
  graphEntity: (id) => aiApi(`/graph/entities/${id}`),
  createGraphEntity: (body) => aiApi("/graph/entities", { method: "POST", body }),
  updateGraphEntity: (id, body) =>
    aiApi(`/graph/entities/${id}`, { method: "PATCH", body }),
  deleteGraphEntity: (id) => aiApi(`/graph/entities/${id}`, { method: "DELETE" }),
  graphEntityVersions: (id) => aiApi(`/graph/entities/${id}/versions`),
  graphSearch: (params) => aiApi(`/graph/search${qs(params)}`),
  graphRelationships: (params) => aiApi(`/graph/relationships${qs(params)}`),
  createGraphRelationship: (body) =>
    aiApi("/graph/relationships", { method: "POST", body }),
  deleteGraphRelationship: (id) =>
    aiApi(`/graph/relationships/${id}`, { method: "DELETE" }),
  graphNeighborhood: (id, params) =>
    aiApi(`/graph/entities/${id}/neighborhood${qs(params)}`),
  graphTraverse: (id, body) =>
    aiApi(`/graph/entities/${id}/traverse`, { method: "POST", body }),
  graphPaths: (id, body) =>
    aiApi(`/graph/entities/${id}/paths`, { method: "POST", body }),
  graphDigitalThread: (productId) =>
    aiApi(`/graph/products/${productId}/digital-thread`),
  graphWhereUsed: (partId, params) =>
    aiApi(`/graph/parts/${partId}/where-used${qs(params)}`),
  graphChangeImpact: (changeId, params) =>
    aiApi(`/graph/changes/${changeId}/impact${qs(params)}`),
  graphTraceability: (id, body) =>
    aiApi(`/graph/entities/${id}/traceability`, { method: "POST", body }),
  graphIngest: (body) => aiApi("/graph/ingest", { method: "POST", body }),

  productStats: () => aiApi("/products/stats"),
  productItems: (params) => aiApi(`/products/items${qs(params)}`),
  productItem: (id) => aiApi(`/products/items/${id}`),
  createProductItem: (body) =>
    aiApi("/products/items", { method: "POST", body }),
  updateProductItem: (id, body) =>
    aiApi(`/products/items/${id}`, { method: "PATCH", body }),
  productRevisions: (params) => aiApi(`/products/revisions${qs(params)}`),
  productRevision: (id) => aiApi(`/products/revisions/${id}`),
  createProductRevision: (itemId, body) =>
    aiApi(`/products/items/${itemId}/revisions`, { method: "POST", body }),
  updateProductRevision: (id, body) =>
    aiApi(`/products/revisions/${id}`, { method: "PATCH", body }),
  boms: (params) => aiApi(`/boms${qs(params)}`),
  bom: (id) => aiApi(`/boms/${id}`),
  createBom: (body) => aiApi("/boms", { method: "POST", body }),
  updateBom: (id, body) => aiApi(`/boms/${id}`, { method: "PATCH", body }),
  deleteBom: (id) => aiApi(`/boms/${id}`, { method: "DELETE" }),
  bomLines: (params) => aiApi(`/boms/lines${qs(params)}`),
  createBomLine: (headerId, body) =>
    aiApi(`/boms/${headerId}/lines`, { method: "POST", body }),
  updateBomLine: (id, body) =>
    aiApi(`/boms/lines/${id}`, { method: "PATCH", body }),
  deleteBomLine: (id) => aiApi(`/boms/lines/${id}`, { method: "DELETE" }),
  bomStructure: (id, params) =>
    aiApi(`/boms/${id}/structure${qs(params)}`),
  bomCompare: (body) => aiApi("/boms/compare", { method: "POST", body }),
  bomTransform: (body) => aiApi("/boms/transform", { method: "POST", body }),
  bomTransformationRuns: (params) =>
    aiApi(`/boms/transformation-runs${qs(params)}`),
  bomReconcile: (body) => aiApi("/boms/reconcile", { method: "POST", body }),
  bomReconciliations: (params) =>
    aiApi(`/boms/reconciliations${qs(params)}`),
  bomQuality: (id) => aiApi(`/boms/${id}/quality`),
  bomWhereUsed: (itemId, params) =>
    aiApi(`/products/items/${itemId}/where-used${qs(params)}`),
  productReuse: () => aiApi("/products/reuse"),
  productDuplicates: () => aiApi("/products/duplicates"),
  bomChangeImpact: (params) =>
    aiApi(`/boms/change-impact${qs(params)}`, { method: "POST" }),

  manufacturingStats: () => aiApi("/manufacturing/stats"),
  manufacturingPlants: (params) =>
    aiApi(`/manufacturing/plants${qs(params)}`),
  createManufacturingPlant: (body) =>
    aiApi("/manufacturing/plants", { method: "POST", body }),
  updateManufacturingPlant: (id, body) =>
    aiApi(`/manufacturing/plants/${id}`, { method: "PATCH", body }),
  manufacturingLines: (params) =>
    aiApi(`/manufacturing/lines${qs(params)}`),
  manufacturingWorkCentres: (params) =>
    aiApi(`/manufacturing/work-centres${qs(params)}`),
  manufacturingProcesses: (params) =>
    aiApi(`/manufacturing/processes${qs(params)}`),
  manufacturingProcess: (id) => aiApi(`/manufacturing/processes/${id}`),
  createManufacturingProcess: (body) =>
    aiApi("/manufacturing/processes", { method: "POST", body }),
  manufacturingProcessStructure: (id, params) =>
    aiApi(`/manufacturing/processes/${id}/structure${qs(params)}`),
  manufacturingProcessValidate: (id) =>
    aiApi(`/manufacturing/processes/${id}/validate`),
  manufacturingProcessCompare: (body) =>
    aiApi("/manufacturing/processes/compare", { method: "POST", body }),
  manufacturingOperations: (params) =>
    aiApi(`/manufacturing/operations${qs(params)}`),
  manufacturingWorkInstructions: (params) =>
    aiApi(`/manufacturing/work-instructions${qs(params)}`),
  manufacturingAnalytics: (kind) =>
    aiApi(`/manufacturing/analytics/${kind}`),
  manufacturingImpact: (body) =>
    aiApi("/manufacturing/impact", { method: "POST", body }),

  qualityStats: () => aiApi("/quality/stats"),
  qualityIssues: (params) => aiApi(`/quality/issues${qs(params)}`),
  qualityIssue: (id) => aiApi(`/quality/issues/${id}`),
  createQualityIssue: (body) =>
    aiApi("/quality/issues", { method: "POST", body }),
  updateQualityIssue: (id, body) =>
    aiApi(`/quality/issues/${id}`, { method: "PATCH", body }),
  qualityIssueTraceability: (id) =>
    aiApi(`/quality/issues/${id}/traceability`),
  qualityRootCauses: (id, params) =>
    aiApi(`/quality/issues/${id}/root-causes${qs(params)}`),
  qualityInspections: (params) =>
    aiApi(`/quality/inspections${qs(params)}`),
  qualityInspectionResults: (id, params) =>
    aiApi(`/quality/inspections/${id}/results${qs(params)}`),
  qualityActions: (params) => aiApi(`/quality/actions${qs(params)}`),
  qualitySupplierQuality: () =>
    aiApi("/quality/supplier-quality"),
  qualitySupplierIssues: (params) =>
    aiApi(`/quality/supplier-issues${qs(params)}`),
  qualityRepeatIssues: (params) =>
    aiApi(`/quality/repeat-issues${qs(params)}`),
  qualityAnalytics: (kind) => aiApi(`/quality/analytics/${kind}`),
  qualityImpact: (body) =>
    aiApi("/quality/impact", { method: "POST", body }),

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

  predictiveStats: () => aiApi("/predictive-intelligence/stats"),
  predictiveFeatures: (params) =>
    aiApi(`/predictive-intelligence/features${qs(params)}`),
  predictiveFeature: (id) => aiApi(`/predictive-intelligence/features/${id}`),
  upsertPredictiveFeature: (body) =>
    aiApi("/predictive-intelligence/features", { method: "POST", body }),
  updatePredictiveFeature: (id, body) =>
    aiApi(`/predictive-intelligence/features/${id}`, { method: "PATCH", body }),
  predictiveFeatureValues: (params) =>
    aiApi(`/predictive-intelligence/feature-values${qs(params)}`),
  recordPredictiveFeatureValue: (body) =>
    aiApi("/predictive-intelligence/feature-values", { method: "POST", body }),
  predictiveFeatureStatus: (featureKey) =>
    aiApi(`/predictive-intelligence/features/${encodeURIComponent(featureKey)}/status`),
  predictiveDatasets: (params) =>
    aiApi(`/predictive-intelligence/datasets${qs(params)}`),
  predictiveDataset: (id) => aiApi(`/predictive-intelligence/datasets/${id}`),
  upsertPredictiveDataset: (body) =>
    aiApi("/predictive-intelligence/datasets", { method: "POST", body }),
  updatePredictiveDataset: (id, body) =>
    aiApi(`/predictive-intelligence/datasets/${id}`, { method: "PATCH", body }),
  predictiveDatasetVersions: (id) =>
    aiApi(`/predictive-intelligence/datasets/${id}/versions`),
  addPredictiveDatasetVersion: (id, body) =>
    aiApi(`/predictive-intelligence/datasets/${id}/versions`, { method: "POST", body }),
  predictiveModels: (params) =>
    aiApi(`/predictive-intelligence/models${qs(params)}`),
  predictiveModel: (id) => aiApi(`/predictive-intelligence/models/${id}`),
  upsertPredictiveModel: (body) =>
    aiApi("/predictive-intelligence/models", { method: "POST", body }),
  updatePredictiveModel: (id, body) =>
    aiApi(`/predictive-intelligence/models/${id}`, { method: "PATCH", body }),
  predictiveModelPerformance: (params) =>
    aiApi(`/predictive-intelligence/models/performance${qs(params)}`),
  predictiveModelVersions: (id) =>
    aiApi(`/predictive-intelligence/models/${id}/versions`),
  addPredictiveModelVersion: (id, body) =>
    aiApi(`/predictive-intelligence/models/${id}/versions`, { method: "POST", body }),
  predictions: (params) =>
    aiApi(`/predictive-intelligence/predictions${qs(params)}`),
  prediction: (id) => aiApi(`/predictive-intelligence/predictions/${id}`),
  runPrediction: (body) =>
    aiApi("/predictive-intelligence/predictions", { method: "POST", body }),
  predictionExplanation: (id) =>
    aiApi(`/predictive-intelligence/predictions/${id}/explanation`),
  predictionAnalytics: (kind) =>
    aiApi(`/predictive-intelligence/analytics/${encodeURIComponent(kind)}`),
  markPredictionsStale: (params) =>
    aiApi(`/predictive-intelligence/predictions/mark-stale${qs(params)}`, {
      method: "POST",
    }),
  recommendations: (params) =>
    aiApi(`/predictive-intelligence/recommendations${qs(params)}`),
  recommendation: (id) =>
    aiApi(`/predictive-intelligence/recommendations/${id}`),
  createRecommendation: (body) =>
    aiApi("/predictive-intelligence/recommendations", { method: "POST", body }),
  generateRecommendations: (body) =>
    aiApi("/predictive-intelligence/recommendations/generate", {
      method: "POST",
      body,
    }),
  updateRecommendation: (id, body) =>
    aiApi(`/predictive-intelligence/recommendations/${id}`, { method: "PATCH", body }),
  recommendationFeedback: (id, params) =>
    aiApi(`/predictive-intelligence/recommendations/${id}/feedback${qs(params)}`),
  addRecommendationFeedback: (id, body) =>
    aiApi(`/predictive-intelligence/recommendations/${id}/feedback`, {
      method: "POST",
      body,
    }),
  predictiveSchedules: (params) =>
    aiApi(`/predictive-intelligence/schedules${qs(params)}`),
  upsertPredictiveSchedule: (body) =>
    aiApi("/predictive-intelligence/schedules", { method: "POST", body }),
  updatePredictiveSchedule: (id, body) =>
    aiApi(`/predictive-intelligence/schedules/${id}`, { method: "PATCH", body }),
};
