// Best-effort bridge into the shared platform frameworks.
//
// The PDM domain owns its engineering-data persistence, but it integrates with
// the platform's Object & Relationship Framework, Lifecycle kernel and File/
// Content Storage wherever an endpoint exposes a generic object id or content id.
// Every call is wrapped so a platform seam that is unavailable (for example a
// tenant without a registered object type) degrades gracefully instead of
// failing the business write. The bridge is the single place that knows the
// platform interfaces, keeping the domain services decoupled from their layout.
import { createObject } from "../objects/objects.js";
import { createRelationshipType } from "../objects/relationship-types.js";
import { createRelationship as createObjectRelationship } from "../objects/relationships.js";
import { transitionObject } from "../lifecycle.js";
import { getEventTypeRow } from "../events/registry.js";

const RELATIONSHIP_TYPES_REGISTERED = new Set();

// Mirrors a PDM entity into the generic object model. Returns the generic object
// id, or null when the platform object model cannot accept the entity.
export function bridgeCreateObject(db, { type, code, name, description, data, status, organizationId }, actor, tenantId, ip) {
  try {
    const created = createObject(
      db,
      {
        type,
        code,
        name,
        description,
        data: data || {},
        status: mapObjectStatus(status),
        organization_id: organizationId ?? undefined,
      },
      actor,
      Number(tenantId),
      ip
    );
    return created?.id ?? null;
  } catch {
    return null;
  }
}

// Registers a typed PDM relationship in the generic Object & Relationship
// Framework. Idempotent per process; returns the generic relationship id or null.
export function bridgeCreateRelationship(db, { type, sourceId, targetId, attributes }, actor, tenantId, ip) {
  try {
    ensureRelationshipType(db, type, actor);
    const created = createObjectRelationship(
      db,
      {
        relationship_type: type,
        source_object_id: Number(sourceId) || sourceId,
        target_object_id: Number(targetId) || targetId,
        attributes: attributes || {},
      },
      actor,
      Number(tenantId),
      ip
    );
    return created?.id ?? null;
  } catch {
    return null;
  }
}

function ensureRelationshipType(db, code, actor) {
  if (RELATIONSHIP_TYPES_REGISTERED.has(code)) return;
  try {
    createRelationshipType(db, { code, name: code, source_type: "object", target_type: "object" }, actor, null, null);
  } catch {
    // Already present or unavailable; the generic relationship call will decide.
  }
  RELATIONSHIP_TYPES_REGISTERED.add(code);
}

// Bridges a lifecycle transition onto the generic object when the PDM entity is
// backed by a generic object. Best-effort: the PDM status machine is
// authoritative and this only mirrors the state change.
export function bridgeTransitionObject(db, reference, body, actor, tenantId, ip) {
  if (!reference) return null;
  try {
    return transitionObject(db, reference, body, actor, Number(tenantId), ip) || null;
  } catch {
    return null;
  }
}

export function eventTypeExists(db, code) {
  try {
    return Boolean(getEventTypeRow(db, code));
  } catch {
    return false;
  }
}

// The generic object model uses lower-case statuses; PDM uses upper-case. When
// the two vocabularies overlap we map; otherwise the platform validates.
function mapObjectStatus(status) {
  const normalized = String(status || "").toLowerCase();
  const known = ["draft", "in_review", "released", "obsolete", "archived"];
  if (known.includes(normalized)) return normalized;
  return "draft";
}
