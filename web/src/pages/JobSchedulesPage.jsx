import React, { useCallback, useEffect, useState } from "react";
import { jobExecution, jobs } from "../api.js";
import { ScheduleStatusBadge, describeCadence, formatDateTime } from "../components/JobEngineBadges.jsx";

const EMPTY = {
  code: "",
  name: "",
  job_type_code: "",
  queue: "DEFAULT",
  priority: "normal",
  schedule_type: "cron",
  cron_expression: "0 * * * *",
  interval_seconds: 3600,
  daily_time: "02:00",
  weekdays: "1,2,3,4,5",
  day_of_month: 1,
  timezone: "UTC",
  start_at: "",
  end_at: "",
  max_executions: 0,
  max_retries: 0,
  timeout_seconds: 0,
  failure_policy: "continue",
  concurrency_policy: "allow",
  catchup_policy: "skip",
};

function buildBody(draft) {
  const body = {
    name: draft.name,
    job_type_code: String(draft.job_type_code).toUpperCase(),
    queue: draft.queue,
    priority: draft.priority,
    schedule_type: draft.schedule_type,
    timezone: draft.timezone,
    max_executions: Number(draft.max_executions) || 0,
    max_retries: Number(draft.max_retries) || 0,
    timeout_seconds: Number(draft.timeout_seconds) || 0,
    failure_policy: draft.failure_policy,
    concurrency_policy: draft.concurrency_policy,
    catchup_policy: draft.catchup_policy,
    start_at: draft.start_at || null,
    end_at: draft.end_at || null,
  };
  if (draft.schedule_type === "cron") body.cron_expression = draft.cron_expression;
  if (draft.schedule_type === "interval") body.interval_seconds = Number(draft.interval_seconds) || 0;
  if (["daily", "weekly", "monthly"].includes(draft.schedule_type)) body.daily_time = draft.daily_time;
  if (draft.schedule_type === "weekly") {
    body.weekdays = String(draft.weekdays).split(",").map((item) => Number(item.trim())).filter((n) => Number.isInteger(n));
  }
  if (draft.schedule_type === "monthly") body.day_of_month = Number(draft.day_of_month) || 1;
  return body;
}

export default function JobSchedulesPage() {
  const [list, setList] = useState({ items: [], total: 0 });
  const [meta, setMeta] = useState(null);
  const [types, setTypes] = useState([]);
  const [queues, setQueues] = useState([]);
  const [filters, setFilters] = useState({ status: "", q: "" });
  const [draft, setDraft] = useState(EMPTY);
  const [edit, setEdit] = useState(null);
  const [selected, setSelected] = useState(null);
  const [runs, setRuns] = useState({ items: [], total: 0 });
  const [allTenants, setAllTenants] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const scope = allTenants ? "all=true&" : "";

  useEffect(() => {
    jobExecution.meta().then(setMeta).catch(() => {});
    jobs.types("?pageSize=200")
      .then((res) => {
        const active = (res.items || []).filter((type) => type.active);
        setTypes(active);
        setDraft((prev) => ({ ...prev, job_type_code: prev.job_type_code || active[0]?.code || "" }));
      })
      .catch(() => {});
    jobExecution.queues("?pageSize=100").then((res) => setQueues(res.items || [])).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      const params = new URLSearchParams({ pageSize: "200" });
      if (filters.status) params.set("status", filters.status);
      if (filters.q) params.set("q", filters.q);
      setList(await jobExecution.schedules(`?${scope}${params.toString()}`));
    } catch (err) {
      setError(err.message);
    }
  }, [filters, scope]);

  useEffect(() => { load(); }, [load]);

  const loadRuns = useCallback(async (schedule) => {
    setSelected(schedule);
    try {
      setRuns(await jobExecution.scheduleRuns(schedule.id, "?pageSize=25"));
    } catch (err) {
      setError(err.message);
    }
  }, []);

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
      const created = await jobExecution.createSchedule({
        ...buildBody(draft),
        code: draft.code.trim().toUpperCase(),
        name: draft.name || draft.code.trim().toUpperCase(),
      });
      setNotice(`Created schedule ${created.code}.`);
      setDraft((prev) => ({ ...EMPTY, job_type_code: prev.job_type_code }));
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
      await jobExecution.updateSchedule(edit.id, buildBody(edit));
      setNotice(`Updated schedule ${edit.code}.`);
      setEdit(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  const statuses = meta?.schedule_statuses || [];
  const typesList = ["cron", "interval", "daily", "weekly", "monthly", "once"];
  const schedules = list.items || [];

  const cadenceFields = (value, set) => (
    <>
      <div className="row">
        <label className="field"><span>Schedule type</span>
          <select value={value.schedule_type} onChange={(e) => set({ ...value, schedule_type: e.target.value })}>
            {typesList.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="field"><span>Timezone</span>
          <input value={value.timezone} onChange={(e) => set({ ...value, timezone: e.target.value })} />
        </label>
        {value.schedule_type === "cron" ? (
          <label className="field grow"><span>Cron expression</span>
            <input value={value.cron_expression} onChange={(e) => set({ ...value, cron_expression: e.target.value })} />
          </label>
        ) : null}
        {value.schedule_type === "interval" ? (
          <label className="field"><span>Interval (seconds)</span>
            <input type="number" min="0" value={value.interval_seconds} onChange={(e) => set({ ...value, interval_seconds: e.target.value })} />
          </label>
        ) : null}
        {["daily", "weekly", "monthly"].includes(value.schedule_type) ? (
          <label className="field"><span>Time (HH:MM)</span>
            <input value={value.daily_time} onChange={(e) => set({ ...value, daily_time: e.target.value })} />
          </label>
        ) : null}
        {value.schedule_type === "weekly" ? (
          <label className="field"><span>Weekdays (0-6)</span>
            <input value={value.weekdays} onChange={(e) => set({ ...value, weekdays: e.target.value })} />
          </label>
        ) : null}
        {value.schedule_type === "monthly" ? (
          <label className="field"><span>Day of month</span>
            <input type="number" min="1" max="31" value={value.day_of_month} onChange={(e) => set({ ...value, day_of_month: e.target.value })} />
          </label>
        ) : null}
      </div>
      <div className="row">
        <label className="field"><span>Start at</span>
          <input value={value.start_at || ""} placeholder="YYYY-MM-DD HH:MM" onChange={(e) => set({ ...value, start_at: e.target.value })} />
        </label>
        <label className="field"><span>End at</span>
          <input value={value.end_at || ""} placeholder="YYYY-MM-DD HH:MM" onChange={(e) => set({ ...value, end_at: e.target.value })} />
        </label>
        <label className="field"><span>Max executions</span>
          <input type="number" min="0" value={value.max_executions} onChange={(e) => set({ ...value, max_executions: e.target.value })} />
        </label>
        <label className="field"><span>Failure policy</span>
          <select value={value.failure_policy} onChange={(e) => set({ ...value, failure_policy: e.target.value })}>
            {(meta?.failure_policies || ["continue", "pause", "disable"]).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="field"><span>Catch-up</span>
          <select value={value.catchup_policy} onChange={(e) => set({ ...value, catchup_policy: e.target.value })}>
            {(meta?.catchup_policies || ["skip", "run_once", "run_all"]).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="field"><span>Concurrency</span>
          <select value={value.concurrency_policy} onChange={(e) => set({ ...value, concurrency_policy: e.target.value })}>
            {(meta?.concurrency_policies || ["allow", "skip", "queue", "cancel_previous"]).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>
    </>
  );

  return (
    <>
      <div className="topbar">
        <div>
          <div className="brand">Jobs</div>
          <h1>Schedule administration</h1>
          <div className="sub">Time-based, interval and cron schedules with time zones, catch-up and failure policies.</div>
        </div>
        <label className="notif-check">
          <input type="checkbox" checked={allTenants} onChange={(e) => setAllTenants(e.target.checked)} />
          <span>All tenants</span>
        </label>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="valid">{notice}</div> : null}

      <div className="row" style={{ marginBottom: 12 }}>
        <label className="field grow"><span>Search</span>
          <input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        </label>
        <label className="field"><span>Status</span>
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            <option value="">Any</option>
            {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <button className="btn" type="button" onClick={load}>Apply</button>
      </div>

      <table>
        <thead>
          <tr><th>Schedule</th><th>Cadence</th><th>Job type</th><th>Queue</th><th>Status</th><th>Next run</th><th>Executions</th><th>Failures</th><th /></tr>
        </thead>
        <tbody>
          {schedules.map((schedule) => (
            <tr key={schedule.id}>
              <td style={{ cursor: "pointer" }} onClick={() => loadRuns(schedule)}>
                <div>{schedule.name}</div>
                <div className="mono">{schedule.code}</div>
              </td>
              <td>{describeCadence(schedule)}</td>
              <td className="mono">{schedule.job_type_code}</td>
              <td className="mono">{schedule.queue}</td>
              <td><ScheduleStatusBadge status={schedule.status} /></td>
              <td className="mono">{formatDateTime(schedule.next_run_at)}</td>
              <td>{schedule.execution_count}</td>
              <td>{schedule.failure_count}</td>
              <td className="inline">
                <button className="btn ghost" type="button" onClick={() => setEdit({ ...schedule })}>Edit</button>
                <button className="btn ghost" type="button" onClick={() => act(() => jobExecution.runScheduleNow(schedule.id), `Dispatched ${schedule.code} now.`)}>Run now</button>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => act(
                    () => (schedule.enabled ? jobExecution.disableSchedule(schedule.id) : jobExecution.enableSchedule(schedule.id)),
                    `${schedule.code} ${schedule.enabled ? "disabled" : "enabled"}.`
                  )}
                >
                  {schedule.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => act(
                    () => (schedule.status === "paused" ? jobExecution.resumeSchedule(schedule.id) : jobExecution.pauseSchedule(schedule.id)),
                    `${schedule.code} ${schedule.status === "paused" ? "resumed" : "paused"}.`
                  )}
                >
                  {schedule.status === "paused" ? "Resume" : "Pause"}
                </button>
              </td>
            </tr>
          ))}
          {!schedules.length ? <tr><td colSpan={9} className="muted">No schedules configured.</td></tr> : null}
        </tbody>
      </table>

      {selected ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h3>Recent runs · {selected.code}</h3>
            <button className="btn ghost" type="button" onClick={() => setSelected(null)}>Close</button>
          </div>
          <table>
            <thead><tr><th>Scheduled for</th><th>Status</th><th>Job</th><th>Detail</th></tr></thead>
            <tbody>
              {(runs.items || []).map((run) => (
                <tr key={run.id}>
                  <td className="mono">{formatDateTime(run.scheduled_for)}</td>
                  <td>{run.status}</td>
                  <td className="mono">{run.job_ref || "—"}</td>
                  <td className="muted">{run.job_status || run.detail?.reason || run.detail?.error || "—"}</td>
                </tr>
              ))}
              {!runs.items?.length ? <tr><td colSpan={4} className="muted">No runs recorded.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

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
              <label className="field"><span>Queue</span>
                <select value={edit.queue} onChange={(e) => setEdit({ ...edit, queue: e.target.value })}>
                  {(queues.length ? queues.map((q) => q.code) : [edit.queue]).map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
              </label>
              <label className="field"><span>Max retries</span>
                <input type="number" min="0" value={edit.max_retries} onChange={(e) => setEdit({ ...edit, max_retries: e.target.value })} />
              </label>
              <label className="field"><span>Timeout (s)</span>
                <input type="number" min="0" value={edit.timeout_seconds} onChange={(e) => setEdit({ ...edit, timeout_seconds: e.target.value })} />
              </label>
            </div>
            {cadenceFields({
              schedule_type: edit.schedule_type,
              timezone: edit.timezone,
              cron_expression: edit.cron_expression,
              interval_seconds: edit.interval_seconds,
              daily_time: edit.daily_time,
              weekdays: Array.isArray(edit.weekdays) ? edit.weekdays.join(",") : edit.weekdays || "",
              day_of_month: edit.day_of_month,
              start_at: edit.start_at || "",
              end_at: edit.end_at || "",
              max_executions: edit.max_executions,
              failure_policy: edit.failure_policy,
              catchup_policy: edit.catchup_policy,
              concurrency_policy: edit.concurrency_policy,
            }, setEdit)}
            <button className="btn" type="button" onClick={saveEdit}>Save changes</button>
          </>
        ) : (
          <>
            <div className="panel-head"><h3>Create a schedule</h3></div>
            <div className="row">
              <label className="field"><span>Code</span>
                <input value={draft.code} placeholder="MY_SCHEDULE" onChange={(e) => patch("code", e.target.value)} />
              </label>
              <label className="field grow"><span>Name</span>
                <input value={draft.name} onChange={(e) => patch("name", e.target.value)} />
              </label>
              <label className="field grow"><span>Job type</span>
                <select value={draft.job_type_code} onChange={(e) => patch("job_type_code", e.target.value)}>
                  {types.map((type) => <option key={type.code} value={type.code}>{type.code}</option>)}
                </select>
              </label>
              <label className="field"><span>Queue</span>
                <select value={draft.queue} onChange={(e) => patch("queue", e.target.value)}>
                  {(queues.length ? queues.map((q) => q.code) : ["DEFAULT"]).map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
              </label>
            </div>
            {cadenceFields(draft, (value) => setDraft(value))}
            <button className="btn" type="button" disabled={busy || !draft.code.trim() || !draft.job_type_code} onClick={create}>Create schedule</button>
          </>
        )}
      </div>
    </>
  );
}
