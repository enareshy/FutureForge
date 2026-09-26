// In-process cooperative cancellation signals.
//
// Cancellation is cooperative: an operator request is persisted on the job
// (jobs.cancel_requested / status=cancel_requested) and, when the job is being
// executed by this process, a signal is also recorded here for instant
// detection. Handlers call `context.checkCancelled()` (or read
// `context.signal`) and stop cleanly. Cross-process requests are detected by
// polling the persisted job status inside `checkCancelled`.

const signals = new Map();

export function requestSignal(jobId, reason = "") {
  signals.set(Number(jobId), { cancelled: true, reason: String(reason || ""), at: Date.now() });
}

export function clearSignal(jobId) {
  signals.delete(Number(jobId));
}

export function getSignal(jobId) {
  return signals.get(Number(jobId)) || null;
}

export function isCancelled(jobId) {
  return signals.has(Number(jobId));
}

export function activeSignalCount() {
  return signals.size;
}
