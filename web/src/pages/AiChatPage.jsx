import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AiApiError, ai, streamChat } from "../aiApi.js";
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
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const idRef = useRef(0);

  useEffect(() => () => abortRef.current?.abort(), []);

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
      const detail = await ai.conversation(id);
      setConvo(detail);
    } catch (err) {
      setError(describe(err));
    } finally {
      setConvoBusy(false);
    }
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

  async function rateMessage(messageId, rating) {
    try {
      await ai.assistantFeedback({ message_id: messageId, rating });
      setConvo((prev) => ({
        ...prev,
        messages: prev.messages.map((m) => (m.id === messageId ? { ...m, rating } : m)),
      }));
    } catch (err) {
      setError(describe(err));
    }
  }

  async function sendAssistant(text) {
    let id = convoId;
    if (!id) {
      const created = await ai.createConversation({ title: text.slice(0, 120) });
      id = created.id;
      setConvoId(id);
      setConversations((prev) => [created, ...prev]);
      setConvo({ conversation: created, messages: [] });
    }
    const optimistic = [
      { id: `u-${nextId()}`, role: "user", content: text },
      { id: `p-${nextId()}`, role: "assistant", content: "", pending: true },
    ];
    setConvo((prev) => ({ ...prev, messages: [...prev.messages, ...optimistic] }));
    try {
      await ai.sendAssistantMessage(id, { content: text });
      const detail = await ai.conversation(id);
      setConvo(detail);
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...detail.conversation } : c))
      );
    } catch (err) {
      setConvo((prev) => ({
        ...prev,
        messages: prev.messages.filter((m) => !m.pending),
      }));
      throw err;
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
            <div className="stack" style={{ flex: "0 0 220px" }}>
              <button className="btn secondary" onClick={newConversation}>New conversation</button>
              {conversations.length === 0 ? (
                <p className="muted">No conversations yet.</p>
              ) : (
                conversations.map((c) => (
                  <div
                    key={c.id}
                    className={`notice ${c.id === convoId ? "active" : ""}`}
                    style={{ cursor: "pointer" }}
                  >
                    <div onClick={() => openConversation(c.id)}>
                      <div className="result-title">
                        {c.title || `Conversation ${c.id}`}
                      </div>
                      <div className="result-sub">
                        {c.message_count} messages · {new Date(c.updated_at).toLocaleString()}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => removeConversation(c.id)}
                    >
                      Delete
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="stack grow">
              {convoBusy ? <p className="muted">Loading conversation…</p> : null}
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
                    <div className="result-sub">{m.role}</div>
                    {m.role === "user" ? (
                      <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                    ) : m.pending ? (
                      <div className="result-sub">thinking…</div>
                    ) : (
                      <>
                        <AiMarkdown text={m.content} />
                        <div className="result-sub">
                          {m.answer_status || "answered"}
                          {m.confidence != null ? ` · confidence ${Number(m.confidence).toFixed(4)}` : ""}
                          {m.is_mock ? " · mock provider" : ""}
                          {m.model_code ? ` · ${m.model_code}` : ""}
                          {m.latency_ms != null ? ` · ${m.latency_ms} ms` : ""}
                        </div>
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
                        <div className="row" style={{ gap: 8, marginTop: 6 }}>
                          <button
                            type="button"
                            className="btn ghost"
                            disabled={m.rating != null || m.id < 0}
                            onClick={() => rateMessage(m.id, 1)}
                          >
                            {m.rating === 1 ? "Rated helpful" : "Helpful"}
                          </button>
                          <button
                            type="button"
                            className="btn ghost"
                            disabled={m.rating != null || m.id < 0}
                            onClick={() => rateMessage(m.id, -1)}
                          >
                            {m.rating === -1 ? "Rated unhelpful" : "Not helpful"}
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
          {busy && mode === "chat" && streaming ? (
            <button type="button" className="btn secondary" onClick={cancel}>
              Cancel
            </button>
          ) : (
            <button className="btn" disabled={busy}>{busy ? "Working…" : "Send"}</button>
          )}
        </form>
      </div>
    </>
  );
}
