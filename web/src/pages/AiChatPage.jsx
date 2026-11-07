import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AiApiError, ai, streamAssistantMessage, streamChat } from "../aiApi.js";
import AiMarkdown from "../aiMarkdown.jsx";

function CitationList({ citations }) {
  if (!citations?.length) return null;
  return (
    <div className="result-list">
      {citations.map((c) => (
        <div className="result-card" key={`${c.chunk_id}-${c.rank}`}>
          <div className="result-main">
            <div className="result-title">
              [{c.rank}]{" "}
              <Link to={`/ai/knowledge?source=${c.source_id}&document=${c.document_id}`}>
                {c.source_code} · document {c.document_id}
              </Link>
            </div>
            <div className="result-sub">
              chunk {c.chunk_index}
              {c.page != null ? ` · page ${c.page}` : ""}
              {c.section ? ` · ${c.section}` : ""} · score {Number(c.score).toFixed(4)}
            </div>
            <p>{c.snippet}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function ToolList({ tools }) {
  if (!tools?.length) return null;
  return (
    <div className="result-sub" style={{ marginTop: 6 }}>
      tools:{" "}
      {tools.map((t, i) => (
        <span key={`${t.tool_code}-${i}`}>
          {i ? " · " : ""}
          <code>{t.tool_code}</code> ({(t.status || "unknown").replace(/_/g, " ")}
          {t.duplicate ? ", duplicate" : ""}
          {t.error_class ? `: ${t.error_class}` : ""})
        </span>
      ))}
    </div>
  );
}

function ActionCard({ action, busy, onDecide }) {
  const status = action.status || "proposed";
  const canDecide = status === "proposed";
  const canExecute = status === "approved";
  return (
    <div className="notice" style={{ marginTop: 8 }}>
      <div className="result-title">
        Proposed action · {action.action_type}
        {action.target ? ` · ${action.target}` : ""}
      </div>
      <div>{action.summary}</div>
      {action.expected_effect ? (
        <div className="result-sub">Expected effect: {action.expected_effect}</div>
      ) : null}
      <div className="result-sub">
        status {status}
        {action.requested_by_name ? ` · requested by ${action.requested_by_name}` : ""}
        {action.approved_by_name ? ` · decided by ${action.approved_by_name}` : ""}
        {action.executed_by_name ? ` · executed by ${action.executed_by_name}` : ""}
        {action.decision_reason ? ` · ${action.decision_reason}` : ""}
      </div>
      {action.status === "approved" ? (
        <div className="result-sub">This action is approved but not yet executed.</div>
      ) : null}
      {canDecide || canExecute ? (
        <div className="row" style={{ gap: 8, marginTop: 6 }}>
          {canDecide ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => onDecide(action, "approve")}
              >
                Approve
              </button>
              <button
                type="button"
                className="btn secondary"
                disabled={busy}
                onClick={() => onDecide(action, "reject")}
              >
                Reject
              </button>
            </>
          ) : null}
          {canExecute ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => onDecide(action, "execute")}
            >
              Execute approved action
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function AiChatPage() {
  const [mode, setMode] = useState("chat");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(true);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState([]);
  const [answers, setAnswers] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [convoId, setConvoId] = useState(null);
  const [convo, setConvo] = useState({ conversation: null, messages: [] });
  const [convoBusy, setConvoBusy] = useState(false);
  const [task, setTask] = useState("ask");
  const [outputFormat, setOutputFormat] = useState("markdown");
  const [contextRefs, setContextRefs] = useState([]);
  const [docQuery, setDocQuery] = useState("");
  const [docResults, setDocResults] = useState([]);
  const [docBusy, setDocBusy] = useState(false);
  const [streamingAssistant, setStreamingAssistant] = useState(true);
  const [extractFieldText, setExtractFieldText] = useState("");
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const assistantAbortRef = useRef(null);
  const idRef = useRef(0);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      assistantAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (mode !== "assistant") return;
    ai.conversations({ limit: 30 })
      .then((page) => setConversations(page.items))
      .catch((err) => setError(describe(err)));
  }, [mode]);

  function nextId() {
    idRef.current += 1;
    return idRef.current;
  }

  function describe(err) {
    if (err instanceof AiApiError) {
      if (err.code === "aborted") return "Cancelled.";
      const rid = err.requestId ? ` (request ${err.requestId})` : "";
      return `${err.code}: ${err.message}${rid}`;
    }
    return err?.message || "Request failed";
  }

  function updateMessage(id, patch) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  async function sendChat(history) {
    if (streaming) {
      const id = nextId();
      abortRef.current = new AbortController();
      setMessages([...history, { id, role: "assistant", content: "", streaming: true }]);
      try {
        const done = await streamChat(
          { messages: history.map(({ role, content }) => ({ role, content })) },
          {
            signal: abortRef.current.signal,
            onEvent: (evt) => {
              if (evt.type === "delta") {
                setMessages((prev) =>
                  prev.map((m) => (m.id === id ? { ...m, content: m.content + evt.content } : m))
                );
              }
            },
          }
        );
        updateMessage(id, {
          streaming: false,
          meta: done
            ? `${done.model} · ${done.provider}${done.is_mock ? " · mock" : ""} · ${done.usage?.total_tokens ?? 0} tokens`
            : undefined,
        });
      } catch (err) {
        updateMessage(id, { streaming: false });
        setError(describe(err));
      } finally {
        abortRef.current = null;
      }
      return;
    }

    setMessages([...history, { role: "assistant", content: "…", pending: true }]);
    const res = await ai.chat({
      messages: history.map(({ role, content }) => ({ role, content })),
    });
    setMessages([
      ...history,
      {
        role: "assistant",
        content: res.content,
        meta: `${res.model} · ${res.provider}${res.is_mock ? " · mock" : ""} · ${res.usage.total_tokens} tokens`,
      },
    ]);
  }

  async function send(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    setInput("");
    try {
      if (mode === "chat") {
        const history = [...messages, { role: "user", content: text }];
        await sendChat(history);
      } else if (mode === "assistant") {
        await sendAssistant(text);
      } else {
        const res = await ai.rag({ query: text, limit: 5 });
        setAnswers((prev) => [{ question: text, ...res }, ...prev]);
      }
    } catch (err) {
      setError(describe(err));
      setMessages((prev) => prev.filter((m) => !m.pending));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  async function rate(index, rating) {
    try {
      await ai.createFeedback({ rating });
      setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, rating } : m)));
    } catch (err) {
      setError(describe(err));
    }
  }

  async function refreshConversations() {
    const page = await ai.conversations({ limit: 30 });
    setConversations(page.items);
  }

  async function openConversation(id) {
    setError("");
    setConvoId(id);
    setConvoBusy(true);
    try {
      const detail = await ai.conversation(id, { limit: 50 });
      setConvo(detail);
    } catch (err) {
      setError(describe(err));
    } finally {
      setConvoBusy(false);
    }
  }

  async function decideAction(action, decision) {
    setError("");
    setBusy(true);
    try {
      if (decision === "approve") {
        await ai.approveAssistantAction(action.id, { reason: "Approved in Copilot" });
      } else if (decision === "reject") {
        const reason = window.prompt("Reason for rejecting this action", "");
        if (reason == null) return;
        await ai.rejectAssistantAction(action.id, { reason: reason.trim() });
      } else {
        await ai.executeAssistantAction(action.id);
      }
      if (convoId) await refreshConversation(convoId);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function refreshConversation(id) {
    const detail = await ai.conversation(id, { limit: 50 });
    setConvo(detail);
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...detail.conversation } : c)),
    );
  }

  async function renameConversation(item) {
    const next = window.prompt("Rename conversation", item.title || "");
    if (next == null) return;
    const title = next.trim();
    if (!title) return;
    setError("");
    try {
      const updated = await ai.updateConversation(item.id, { title });
      setConversations((prev) => prev.map((c) => (c.id === item.id ? updated : c)));
      if (convoId === item.id) {
        setConvo((prev) => ({ ...prev, conversation: updated }));
      }
    } catch (err) {
      setError(describe(err));
    }
  }

  async function findDocuments(e) {
    e.preventDefault();
    const term = docQuery.trim();
    if (!term || docBusy) return;
    setDocBusy(true);
    try {
      const result = await ai.search({ query: term, limit: 8 });
      setDocResults(result.results || []);
    } catch (err) {
      setError(describe(err));
    } finally {
      setDocBusy(false);
    }
  }

  function addContext(item) {
    const documentId = item.document_id;
    if (!documentId) return;
    setContextRefs((prev) =>
      prev.some((ref) => ref.id === String(documentId))
        ? prev
        : [
            ...prev,
            {
              type: "knowledge_document",
              id: String(documentId),
              title: item.title || `Document ${documentId}`,
            },
          ],
    );
  }

  function removeContext(id) {
    setContextRefs((prev) => prev.filter((ref) => ref.id !== id));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      setError("Clipboard is not available in this browser.");
    }
  }

  function extractionFields() {
    return extractFieldText
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ name, type: "string" }));
  }

  function buildAssistantPayload(text) {
    const payload = { content: text };
    if (task !== "ask") payload.task = task;
    if (outputFormat !== "markdown") payload.output_format = outputFormat;
    if (contextRefs.length) {
      payload.context = contextRefs.map(({ type, id }) => ({ type, id }));
    }
    if (task === "extract") {
      const fields = extractionFields();
      if (fields.length) payload.fields = fields;
    }
    return payload;
  }

  async function newConversation() {
    setError("");
    try {
      const created = await ai.createConversation({});
      setConversations((prev) => [created, ...prev]);
      setConvoId(created.id);
      setConvo({ conversation: created, messages: [] });
    } catch (err) {
      setError(describe(err));
    }
  }

  async function removeConversation(id) {
    setError("");
    try {
      await ai.deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (convoId === id) {
        setConvoId(null);
        setConvo({ conversation: null, messages: [] });
      }
    } catch (err) {
      setError(describe(err));
    }
  }

  async function rateMessage(messageId, rating, category) {
    try {
      await ai.assistantFeedback({ message_id: messageId, rating, category });
      setConvo((prev) => ({
        ...prev,
        messages: prev.messages.map((m) => (m.id === messageId ? { ...m, rating } : m)),
      }));
    } catch (err) {
      setError(describe(err));
    }
  }

  async function ensureConversation(text) {
    if (convoId) return convoId;
    const created = await ai.createConversation({ title: text.slice(0, 120) });
    setConvoId(created.id);
    setConversations((prev) => [created, ...prev]);
    setConvo({ conversation: created, messages: [], total_messages: 0 });
    return created.id;
  }

  async function sendAssistant(text, { parentMessageId = null } = {}) {
    const id = await ensureConversation(text);
    const payload = buildAssistantPayload(text);
    if (parentMessageId) payload.parent_message_id = parentMessageId;
    const useStream =
      streamingAssistant && (task === "ask" || task === "explain");
    const assistantId = `p-${nextId()}`;
    const optimistic = [
      { id: `u-${nextId()}`, role: "user", content: text, task_type: task },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        pending: true,
        streaming: useStream,
        task_type: task,
        context: contextRefs.map(({ type, id: objectId, title }) => ({
          type,
          object_id: objectId,
          display_name: title,
        })),
      },
    ];
    setConvo((prev) => ({
      ...prev,
      messages: [...(prev.messages || []), ...optimistic],
    }));
    try {
      if (useStream) {
        const controller = new AbortController();
        let liveId = assistantId;
        assistantAbortRef.current = controller;
        await streamAssistantMessage(id, payload, {
          signal: controller.signal,
          onEvent: (evt) => {
            if (evt.type === "start") {
              liveId = evt.message_id;
              setConvo((prev) => ({
                ...prev,
                messages: prev.messages.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        id: liveId,
                        streaming: true,
                        pending: false,
                        sources: evt.citations || [],
                        context: evt.context || m.context,
                        prompt_version: evt.prompt_version,
                      }
                    : m,
                ),
              }));
            } else if (evt.type === "delta") {
              setConvo((prev) => ({
                ...prev,
                messages: prev.messages.map((m) =>
                  m.id === liveId || m.id === assistantId
                    ? { ...m, content: (m.content || "") + evt.content, pending: false }
                    : m,
                ),
              }));
            }
          },
        });
      } else {
        await ai.sendAssistantMessage(id, payload);
      }
      await refreshConversation(id);
    } catch (err) {
      setConvo((prev) => ({
        ...prev,
        messages: (prev.messages || []).filter((m) => !m.pending),
      }));
      throw err;
    } finally {
      assistantAbortRef.current = null;
    }
  }

  async function retryAssistant(message) {
    const messages = convo.messages || [];
    const index = messages.findIndex((m) => m.id === message.id);
    const previous = [...messages.slice(0, index)]
      .reverse()
      .find((m) => m.role === "user");
    if (!previous) return;
    setError("");
    setBusy(true);
    try {
      await sendAssistant(previous.content, { parentMessageId: message.id });
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function stopAssistant() {
    assistantAbortRef.current?.abort();
    if (convoId) {
      try {
        await ai.cancelGeneration?.(convoId);
      } catch {
        /* the abort already stopped the display; cancellation is best effort */
      }
      try {
        await refreshConversation(convoId);
      } catch {
        /* keep the optimistic state */
      }
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">AI Platform</div>
          <h1>Enterprise Copilot</h1>
          <p className="sub">
            Chat with the model gateway, or ground answers in your authorized knowledge with
            source citations.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="tabs">
          <button className={`tab ${mode === "chat" ? "active" : ""}`} onClick={() => setMode("chat")}>
            Chat
          </button>
          <button className={`tab ${mode === "rag" ? "active" : ""}`} onClick={() => setMode("rag")}>
            Knowledge (RAG)
          </button>
          <button
            className={`tab ${mode === "assistant" ? "active" : ""}`}
            onClick={() => setMode("assistant")}
          >
            Assistant
          </button>
        </div>

        {error ? <div className="error">{error}</div> : null}

        {mode === "chat" ? (
          <div className="stack">
            {messages.length === 0 ? (
              <p className="muted">Start a conversation. Answers are not grounded in your documents.</p>
            ) : (
              messages.map((m, i) => (
                <div className={`panel ${m.role === "user" ? "" : "notice"}`} key={m.id ?? i}>
                  <div className="result-sub">{m.role}</div>
                  {m.role === "user" ? (
                    <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                  ) : (
                    <AiMarkdown text={m.content} />
                  )}
                  {m.streaming ? <div className="result-sub">streaming…</div> : null}
                  {m.meta ? <div className="result-sub">{m.meta}</div> : null}
                  {m.role === "assistant" && !m.streaming && m.content ? (
                    <div className="row" style={{ gap: 8, marginTop: 6 }}>
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={m.rating != null}
                        onClick={() => rate(i, 1)}
                      >
                        {m.rating === 1 ? "Rated helpful" : "Helpful"}
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={m.rating != null}
                        onClick={() => rate(i, -1)}
                      >
                        {m.rating === -1 ? "Rated unhelpful" : "Not helpful"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : mode === "rag" ? (
          <div className="stack">
            {answers.length === 0 ? (
              <p className="muted">
                Ask a question. Answers cite only the chunks your permissions allow you to see.
              </p>
            ) : (
              answers.map((a, i) => (
                <div className="panel" key={i}>
                  <div className="result-title">{a.question}</div>
                  {a.insufficient_evidence ? (
                    <div className="notice">
                      Insufficient evidence (confidence {Number(a.confidence).toFixed(4)}). No
                      citations — the platform does not fabricate sources.
                    </div>
                  ) : (
                    <>
                      <AiMarkdown text={a.answer} />
                      <div className="result-sub">
                        confidence {Number(a.confidence).toFixed(4)}
                        {a.is_mock ? " · mock provider" : ""}
                      </div>
                      <CitationList citations={a.citations} />
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
            <div className="stack" style={{ flex: "0 0 230px" }}>
              <button className="btn secondary" onClick={newConversation}>New conversation</button>
              {conversations.length === 0 ? (
                <p className="muted">No conversations yet.</p>
              ) : (
                conversations.map((c) => (
                  <div
                    key={c.id}
                    className={`notice ${c.id === convoId ? "active" : ""}`}
                  >
                    <div style={{ cursor: "pointer" }} onClick={() => openConversation(c.id)}>
                      <div className="result-title">
                        {c.title || `Conversation ${c.id}`}
                      </div>
                      <div className="result-sub">
                        {c.message_count} messages · {new Date(c.updated_at).toLocaleString()}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 4 }}>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => renameConversation(c)}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => removeConversation(c.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="stack grow">
              <div className="panel">
                <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                  <label className="field">
                    <span>Task</span>
                    <select value={task} onChange={(e) => setTask(e.target.value)}>
                      <option value="ask">Ask</option>
                      <option value="summarize">Summarize</option>
                      <option value="explain">Explain</option>
                      <option value="compare">Compare</option>
                      <option value="extract">Extract</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Format</span>
                    <select
                      value={outputFormat}
                      onChange={(e) => setOutputFormat(e.target.value)}
                      disabled={task === "extract"}
                    >
                      <option value="markdown">Markdown</option>
                      <option value="executive">Executive</option>
                      <option value="technical">Technical</option>
                      <option value="bullets">Bullets</option>
                      <option value="json">JSON</option>
                    </select>
                  </label>
                  {(task === "ask" || task === "explain") ? (
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={streamingAssistant}
                        onChange={(e) => setStreamingAssistant(e.target.checked)}
                      />
                      Stream
                    </label>
                  ) : null}
                </div>
                {task === "extract" ? (
                  <label className="field">
                    <span>Fields (comma separated)</span>
                    <input
                      value={extractFieldText}
                      onChange={(e) => setExtractFieldText(e.target.value)}
                      placeholder="interval, owner, risks"
                    />
                  </label>
                ) : null}
                <form onSubmit={findDocuments} className="row" style={{ marginTop: 8 }}>
                  <label className="field grow">
                    <span>Attach authorized documents</span>
                    <input
                      value={docQuery}
                      onChange={(e) => setDocQuery(e.target.value)}
                      placeholder="Search documents to attach"
                    />
                  </label>
                  <button className="btn secondary" disabled={docBusy}>
                    {docBusy ? "Searching…" : "Find"}
                  </button>
                </form>
                {docResults.length ? (
                  <div className="stack" style={{ marginTop: 8 }}>
                    {docResults.map((item) => (
                      <div className="row" key={item.document_id} style={{ gap: 8 }}>
                        <span className="grow">
                          {item.title || item.external_id || `Document ${item.document_id}`}
                          {item.source_code ? ` · ${item.source_code}` : ""}
                        </span>
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => addContext(item)}
                        >
                          Attach
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {contextRefs.length ? (
                  <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                    {contextRefs.map((ref) => (
                      <span className="notice" key={ref.id}>
                        {ref.title}{" "}
                        <button
                          type="button"
                          className="btn ghost"
                          aria-label={`Remove ${ref.title}`}
                          onClick={() => removeContext(ref.id)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                {["summarize", "compare", "extract"].includes(task) ? (
                  <div className="result-sub">
                    This task requires at least {task === "compare" ? "two" : "one"} attached
                    authorized document{task === "compare" ? "s" : ""}.
                  </div>
                ) : null}
              </div>

              {convoBusy ? <p className="muted">Loading conversation…</p> : null}
              {convo.summary ? (
                <div className="notice">
                  <div className="result-sub">Derived conversation summary</div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{convo.summary}</div>
                </div>
              ) : null}
              {!convoBusy && convo.messages.length === 0 ? (
                <p className="muted">
                  Start a grounded assistant conversation. Every answer is cited from documents
                  your permissions allow you to see.
                </p>
              ) : (
                convo.messages.map((m) => (
                  <div
                    className={`panel ${m.role === "user" ? "" : "notice"}`}
                    key={m.id}
                  >
                    <div className="result-sub">
                      {m.role}
                      {m.task_type ? ` · ${m.task_type}` : ""}
                      {m.generation_status && m.generation_status !== "completed"
                        ? ` · ${m.generation_status}`
                        : ""}
                    </div>
                    {m.role === "user" ? (
                      <>
                        <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                        {m.context?.length ? (
                          <div className="result-sub">
                            attached: {m.context.map((c) => c.display_name || c.object_id).join(", ")}
                          </div>
                        ) : null}
                      </>
                    ) : m.pending ? (
                      <div className="result-sub">thinking…</div>
                    ) : (
                      <>
                        <AiMarkdown text={m.content} />
                        {m.structured ? (
                          <pre style={{ overflowX: "auto" }}>
                            {JSON.stringify(m.structured, null, 2)}
                          </pre>
                        ) : null}
                        <div className="result-sub">
                          {m.answer_status || "answered"}
                          {m.confidence != null ? ` · confidence ${Number(m.confidence).toFixed(4)}` : ""}
                          {m.is_mock ? " · mock provider" : ""}
                          {m.model_code ? ` · ${m.model_code}` : ""}
                          {m.latency_ms != null ? ` · ${m.latency_ms} ms` : ""}
                          {m.prompt_version ? ` · ${m.prompt_version}` : ""}
                        </div>
                        {m.warnings?.length ? (
                          <div className="notice">
                            {m.warnings.join(" · ")}
                          </div>
                        ) : null}
                        {m.sources?.length ? (
                          <CitationList
                            citations={m.sources.map((s) => ({
                              rank: s.rank,
                              source_id: s.source_id,
                              source_code: s.source_code,
                              document_id: s.document_id,
                              chunk_id: s.chunk_id,
                              chunk_index: s.chunk_index,
                              page: s.page,
                              section: s.section,
                              score: s.score,
                              snippet: s.snippet,
                            }))}
                          />
                        ) : null}
                        {m.context?.length ? (
                          <div className="result-sub">
                            context: {m.context.map((c) => c.display_name || c.object_id).join(", ")}
                          </div>
                        ) : null}
                        <ToolList tools={m.tools} />
                        {m.actions?.length
                          ? m.actions.map((action) => (
                              <ActionCard
                                key={action.id}
                                action={action}
                                busy={busy}
                                onDecide={decideAction}
                              />
                            ))
                          : null}
                        <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="btn ghost"
                            disabled={m.rating != null || m.id < 0}
                            onClick={() => rateMessage(m.id, 1, "helpful")}
                          >
                            {m.rating === 1 ? "Rated helpful" : "Helpful"}
                          </button>
                          <button
                            type="button"
                            className="btn ghost"
                            disabled={m.rating != null || m.id < 0}
                            onClick={() => rateMessage(m.id, -1, "incorrect")}
                          >
                            Incorrect
                          </button>
                          <button
                            type="button"
                            className="btn ghost"
                            disabled={m.rating != null || m.id < 0}
                            onClick={() => rateMessage(m.id, -1, "missing_information")}
                          >
                            Missing information
                          </button>
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={() => copyText(m.content)}
                          >
                            Copy
                          </button>
                          <button
                            type="button"
                            className="btn ghost"
                            disabled={busy}
                            onClick={() => retryAssistant(m)}
                          >
                            Retry
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        <form onSubmit={send} className="row" style={{ marginTop: 12 }}>
          <label className="field grow">
            <span>{mode === "chat" ? "Message" : mode === "assistant" ? "Message" : "Question"}</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                mode === "chat"
                  ? "Ask anything…"
                  : mode === "assistant"
                    ? "Ask your grounded assistant…"
                    : "Ask about your knowledge sources…"
              }
            />
          </label>
          {mode === "chat" ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={streaming}
                onChange={(e) => setStreaming(e.target.checked)}
              />
              Stream
            </label>
          ) : null}
          {busy && ((mode === "chat" && streaming) || mode === "assistant") ? (
            <button
              type="button"
              className="btn secondary"
              onClick={mode === "assistant" ? stopAssistant : cancel}
            >
              Stop
            </button>
          ) : (
            <button className="btn" disabled={busy}>{busy ? "Working…" : "Send"}</button>
          )}
        </form>
      </div>
    </>
  );
}
