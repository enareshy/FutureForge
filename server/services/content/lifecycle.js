import { queryOne, run, nowIso, transaction } from "../../db.js";
import { CONTENT_TRANSITIONS, CONTENT_STATUSES, allowedTransitions } from "./constants.js";
import { Errors } from "./errors.js";
import { recordContentEvent, auditContent } from "./events.js";
import { findContentRow } from "./repository.js";

// Content lifecycle (spec §24). These states describe the physical content only;
// business object lifecycle remains with the platform Lifecycle Management
// service. This is a small, explicit state machine — not a second enterprise
// lifecycle engine — and it emits auditable transitions and domain events.

const STATUS_EVENT = {
  archived: "ContentArchived",
  available: null,
  locked: "ContentCheckedOut",
  quarantined: "ContentQuarantined",
  superseded: null,
  retained: "ContentRetentionExpired",
};

export function availableContentTransitions(content) {
  const from = content?.status || "initiated";
  return (CONTENT_TRANSITIONS[from] || []).filter((state) => CONTENT_STATUSES.includes(state));
}

export function transitionContent(db, content, toStatus, { actor = null, reason = "", ip = null } = {}) {
  return transaction(db, () => {
    const from = content.status;
    if (from === toStatus) {
      return queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(content.id)]);
    }
    if (!allowedTransitions(from).includes(toStatus)) {
      throw Errors.unauthorized(`Illegal content lifecycle transition ${from} -> ${toStatus}`);
    }
    const ts = nowIso();
    run(
      db,
      "UPDATE content SET status = ?, updated_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
      [toStatus, actor?.id ?? null, ts, Number(content.id)]
    );
    const updated = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(content.id)]);
    const eventType = STATUS_EVENT[toStatus];
    if (eventType) {
      recordContentEvent(db, { eventType, content: updated, actor, tenantId: updated.tenant_id, payload: { from_status: from, to_status: toStatus, reason } });
    }
    auditContent(db, { actor, tenantId: updated.tenant_id, action: "content.lifecycle.transition", content: updated, details: { from_status: from, to_status: toStatus, reason }, ip });
    return updated;
  });
}

export function archiveContent(db, reference, { actor = null, tenantId = null, reason = "", ip = null } = {}) {
  const content = findContentRow(db, reference, tenantId);
  return transitionContent(db, content, "archived", { actor, reason, ip });
}

export function markContentRetained(db, reference, { actor = null, tenantId = null, reason = "", ip = null } = {}) {
  const content = findContentRow(db, reference, tenantId);
  return transitionContent(db, content, "retained", { actor, reason, ip });
}

export function markContentSuperseded(db, content, { actor = null, reason = "" } = {}) {
  if (content.status === "superseded") return content;
  if (!allowedTransitions(content.status).includes("superseded")) return content;
  return transitionContent(db, content, "superseded", { actor, reason });
}

export function contentLifecycle(content) {
  return {
    content_id: content.content_id,
    status: content.status,
    security_status: content.security_status,
    processing_status: content.processing_status,
    available_transitions: availableContentTransitions(content),
    object_type: content.object_type || "",
    object_id: content.object_id || "",
    versioning_revision_id: content.versioning_revision_id ?? null,
  };
}
