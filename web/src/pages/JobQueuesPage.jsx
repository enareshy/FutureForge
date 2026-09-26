import React, { useCallback, useEffect, useState } from "react";
import { jobExecution } from "../api.js";
import { QueueStatusBadge } from "../components/JobEngineBadges.jsx";

const EMPTY = {
  code: "",
  name: "",
  description: "",
  priority: 50,
  max_concurrency: 4,
  worker_allocation: 0,
  rate_limit_per_minute: 60,
  retry_max_attempts: 3,
  retry_strategy: "exponential",
  retry_delay_seconds: 30,
  retry_max_delay_seconds: 3600,
  timeout_seconds: 600,
};

export default function JobQueuesPage() {
  const [list, setList] = useState({ items: [], total: 0 });
  const [meta, setMeta] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [queues, m] = await Promise.all([jobExecution.queues("?pageSize=100"), jobExecution.meta()]);
      setList(queues);
      setMeta(m);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function act(fn, message) {
    setNotice("");
    setError("");
    try {
      await fn();
      setNotice(message);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function patch(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function create() {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const created = await jobExecution.createQueue({
        ...draft,
        code: draft.code.trim().toUpperCase(),
        name: draft.name || draft.code.trim().toUpperCase(),
      });
      setNotice(`Created queue ${created.code}.`);
      setDraft(EMPTY);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    setNotice("");
    setError("");
    try {
      await jobExecution.updateQueue(edit.id, {
        name: edit.name,
        description: edit.description,
        priority: Number(edit.priority),
        max_concurrency: Number(edit.max_concurrency),
        worker_allocation: Number(edit.worker_allocation),
        rate_limit_per_minute: Number(edit.rate_limit_per_minute),
        retry_max_attempts: Number(edit.retry_max_attempts),
        retry_strategy: edit.retry_strategy,
        retry_delay_seconds: Number(edit.retry_delay_seconds),
        retry_max_delay_seconds: Number(edit.retry_max_delay_seconds),
        timeout_seconds: Number(edit.timeout_seconds),
      });
      setNotice(`Updated queue ${edit.code}.`);
      setEdit(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  const strategies = meta?.retry_strategies || ["none", "fixed", "exponential"];
  const queues = list.items || [];

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Jobs</div>
          <h1>Queue administration</h1>
          <div className="sub">Logical execution queues own concurrency, priority, rate limits, retry policy and timeouts.</div>
        </div>
        <button className="btn ghost" type="button" onClick={load}>Refresh</button>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}

      <table>
        <thead>
          <tr>
            <th>Queue</th><th>Status</th><th>Priority</th><th>Concurrency</th><th>Depth</th>
            <th>Rate limit</th><th>Retry</th><th>Timeout</th><th />
          </tr>
        </thead>
        <tbody>
          {queues.map((queue) => (
            <tr key={queue.id}>
              <td>
                <div>{queue.name}</div>
                <div className="mono">{queue.code}{queue.is_system ? " · system" : ""}</div>
              </td>
              <td><QueueStatusBadge queue={queue} /></td>
              <td>{queue.priority}</td>
              <td>{queue.running}/{queue.max_concurrency}{queue.worker_allocation ? ` · alloc ${queue.worker_allocation}` : ""}</td>
              <td>{queue.depth}</td>
              <td className="mono">{queue.rate_limit_per_minute ? `${queue.rate_limit_per_minute}/min` : "unlimited"}</td>
              <td className="mono">{queue.retry_max_attempts}× {queue.retry_strategy}</td>
              <td className="mono">{queue.timeout_seconds}s</td>
              <td className="inline">
                <button className="btn ghost" type="button" onClick={() => setEdit({ ...queue })}>Edit</button>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => act(
                    () => jobExecution.setQueueStatus(queue.id, { paused: !queue.paused }),
                    `${queue.code} ${queue.paused ? "resumed" : "paused"}.`
                  )}
                >
                  {queue.paused ? "Resume" : "Pause"}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => act(
                    () => jobExecution.setQueueStatus(queue.id, { enabled: !queue.enabled }),
                    `${queue.code} ${queue.enabled ? "disabled" : "enabled"}.`
                  )}
                >
                  {queue.enabled ? "Disable" : "Enable"}
                </button>
              </td>
            </tr>
          ))}
          {!queues.length ? <tr><td colSpan={9} className="muted">No queues configured.</td></tr> : null}
        </tbody>
      </table>

      <div className="panel" style={{ marginTop: 16 }}>
        {edit ? (
          <>
            <div className="panel-head">
              <h3>Edit {edit.code}</h3>
              <button className="btn ghost" type="button" onClick={() => setEdit(null)}>Close</button>
            </div>
            <div className="row">
              <label className="field grow"><span>Name</span>
                <input value={edit.name || ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </label>
              <label className="field"><span>Priority</span>
                <input type="number" value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })} />
              </label>
              <label className="field"><span>Max concurrency</span>
                <input type="number" min="1" value={edit.max_concurrency} onChange={(e) => setEdit({ ...edit, max_concurrency: e.target.value })} />
              </label>
            </div>
            <div className="row">
              <label className="field"><span>Worker allocation</span>
                <input type="number" min="0" value={edit.worker_allocation} onChange={(e) => setEdit({ ...edit, worker_allocation: e.target.value })} />
              </label>
              <label className="field"><span>Rate limit / min</span>
                <input type="number" min="0" value={edit.rate_limit_per_minute} onChange={(e) => setEdit({ ...edit, rate_limit_per_minute: e.target.value })} />
              </label>
              <label className="field"><span>Timeout (s)</span>
                <input type="number" min="0" value={edit.timeout_seconds} onChange={(e) => setEdit({ ...edit, timeout_seconds: e.target.value })} />
              </label>
            </div>
            <div className="row">
              <label className="field"><span>Retry strategy</span>
                <select value={edit.retry_strategy} onChange={(e) => setEdit({ ...edit, retry_strategy: e.target.value })}>
                  {strategies.map((strategy) => <option key={strategy} value={strategy}>{strategy}</option>)}
                </select>
              </label>
              <label className="field"><span>Max attempts</span>
                <input type="number" min="0" value={edit.retry_max_attempts} onChange={(e) => setEdit({ ...edit, retry_max_attempts: e.target.value })} />
              </label>
              <label className="field"><span>Retry delay (s)</span>
                <input type="number" min="0" value={edit.retry_delay_seconds} onChange={(e) => setEdit({ ...edit, retry_delay_seconds: e.target.value })} />
              </label>
              <label className="field"><span>Max retry delay (s)</span>
                <input type="number" min="0" value={edit.retry_max_delay_seconds} onChange={(e) => setEdit({ ...edit, retry_max_delay_seconds: e.target.value })} />
              </label>
            </div>
            <label className="field"><span>Description</span>
              <textarea rows={2} value={edit.description || ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </label>
            <button className="btn" type="button" onClick={saveEdit}>Save changes</button>
          </>
        ) : (
          <>
            <div className="panel-head"><h3>Register a queue</h3></div>
            <div className="row">
              <label className="field grow"><span>Code</span>
                <input value={draft.code} placeholder="CUSTOM_QUEUE" onChange={(e) => patch("code", e.target.value)} />
              </label>
              <label className="field grow"><span>Name</span>
                <input value={draft.name} onChange={(e) => patch("name", e.target.value)} />
              </label>
            </div>
            <div className="row">
              <label className="field"><span>Priority</span>
                <input type="number" value={draft.priority} onChange={(e) => patch("priority", e.target.value)} />
              </label>
              <label className="field"><span>Max concurrency</span>
                <input type="number" min="1" value={draft.max_concurrency} onChange={(e) => patch("max_concurrency", e.target.value)} />
              </label>
              <label className="field"><span>Rate limit / min</span>
                <input type="number" min="0" value={draft.rate_limit_per_minute} onChange={(e) => patch("rate_limit_per_minute", e.target.value)} />
              </label>
              <label className="field"><span>Timeout (s)</span>
                <input type="number" min="0" value={draft.timeout_seconds} onChange={(e) => patch("timeout_seconds", e.target.value)} />
              </label>
            </div>
            <div className="row">
              <label className="field"><span>Retry strategy</span>
                <select value={draft.retry_strategy} onChange={(e) => patch("retry_strategy", e.target.value)}>
                  {strategies.map((strategy) => <option key={strategy} value={strategy}>{strategy}</option>)}
                </select>
              </label>
              <label className="field"><span>Max attempts</span>
                <input type="number" min="0" value={draft.retry_max_attempts} onChange={(e) => patch("retry_max_attempts", e.target.value)} />
              </label>
              <label className="field"><span>Retry delay (s)</span>
                <input type="number" min="0" value={draft.retry_delay_seconds} onChange={(e) => patch("retry_delay_seconds", e.target.value)} />
              </label>
            </div>
            <label className="field"><span>Description</span>
              <textarea rows={2} value={draft.description} onChange={(e) => patch("description", e.target.value)} />
            </label>
            <button className="btn" type="button" disabled={busy || !draft.code.trim()} onClick={create}>Create queue</button>
          </>
        )}
      </div>
    </>
  );
}
