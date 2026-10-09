// Owner notification bridge for PLM -> Requirement synchronization.
//
// The integration does not implement its own messenger: it installs default
// rules in the existing Notification & Communication Framework and then raises
// ordinary notification events. Recipients are the owner/responsible users of
// the impacted requirements, carried in the event payload and resolved by the
// framework's `event_payload` recipient type (mirrors how business modules call
// `notifications.publish`).
import { publish, publishAsync } from "../notifications.js";
import { run, queryOne, nowIso } from "../../db.js";
import { runAsync, queryOneAsync } from "../../db-async.js";
import { SOURCE_MODULE, PLM_NOTIFICATION_RULES, NOTIFICATION_RECIPIENT_PAYLOAD_PATH } from "./constants.js";

// System rules are global (tenant_id = NULL) and declared by the module, so they
// are inserted directly as `is_system` rows instead of going through the
// tenant-scoped admin API (which requires a platform administrator actor that
// boot/seeding does not have). The notification framework still owns matching,
// recipient resolution and delivery through `publish`.
const RULE_COLUMNS = `(code, name, description, event_type, source_module, condition_json, recipient_json,
   template_code, channels_json, priority, delivery_mode, delay_minutes, reminder_json,
   escalation_json, mandatory, status, tenant_id, organization_id, is_system, created_by, created_at, updated_at)`;

const RULE_PLACEHOLDERS = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)";

function ruleValues(definition, ts) {
  return [
    definition.code,
    definition.name,
    "Default rule installed by the Requirement -> PLM integration.",
    definition.event_type,
    SOURCE_MODULE,
    JSON.stringify({}),
    JSON.stringify({ items: [{ type: "event_payload", ref: NOTIFICATION_RECIPIENT_PAYLOAD_PATH }] }),
    "",
    JSON.stringify(definition.channels || ["in_app"]),
    "normal",
    "immediate",
    0,
    "{}",
    "{}",
    0,
    "active",
    null,
    null,
    null,
    ts,
    ts,
  ];
}

// Installs the integration's default notification rules once. Best-effort: a
// notification framework hiccup must never block application boot.
export function ensurePlmNotificationRules(db) {
  let created = 0;
  const ts = nowIso();
  for (const definition of PLM_NOTIFICATION_RULES) {
    try {
      const existing = queryOne(db, "SELECT id FROM notification_rules WHERE code = ? AND tenant_id IS NULL", [definition.code]);
      if (existing) continue;
      run(db, `INSERT INTO notification_rules ${RULE_COLUMNS} VALUES ${RULE_PLACEHOLDERS}`, ruleValues(definition, ts));
      created += 1;
    } catch {
      /* notifications must never break the integration */
    }
  }
  return { created, total: PLM_NOTIFICATION_RULES.length };
}

export async function ensurePlmNotificationRulesAsync(db) {
  let created = 0;
  const ts = nowIso();
  for (const definition of PLM_NOTIFICATION_RULES) {
    try {
      const existing = await queryOneAsync(db, "SELECT id FROM notification_rules WHERE code = ? AND tenant_id IS NULL", [definition.code]);
      if (existing) continue;
      await runAsync(db, `INSERT INTO notification_rules ${RULE_COLUMNS} VALUES ${RULE_PLACEHOLDERS}`, ruleValues(definition, ts));
      created += 1;
    } catch {
      /* notifications must never break the integration */
    }
  }
  return { created, total: PLM_NOTIFICATION_RULES.length };
}

function recipientIds(requirement) {
  const ids = [requirement.owner_user_id, requirement.responsible_user_id]
    .map((value) => (value === null || value === undefined ? null : Number(value)))
    .filter((value) => Number.isInteger(value) && value > 0);
  return [...new Set(ids)];
}

function notificationEvent(tenantId, { requirement, eventType, payload, correlationId }) {
  const recipients = recipientIds(requirement);
  if (!recipients.length) return null;
  return {
    event_type: eventType,
    source_module: SOURCE_MODULE,
    tenant_id: Number(tenantId),
    object_type: "requirement",
    object_id: String(requirement.id),
    object_name: requirement.requirement_number || requirement.title || "",
    payload: {
      ...payload,
      recipient_user_ids: recipients,
      [NOTIFICATION_RECIPIENT_PAYLOAD_PATH]: recipients,
      owner_user_id: requirement.owner_user_id ?? null,
    },
    correlation_id: correlationId || "",
  };
}

// Raises one notification event for a single requirement. Returns the publish
// summary (or a skipped marker when the requirement has no owner).
export function notifyRequirementOwners(db, tenantId, options) {
  const event = notificationEvent(tenantId, options);
  if (!event) return { published: false, reason: "no_recipient", event_id: null };
  return publish(db, event, { actor: options.actor || null });
}

export async function notifyRequirementOwnersAsync(db, tenantId, options) {
  const event = notificationEvent(tenantId, options);
  if (!event) return { published: false, reason: "no_recipient", event_id: null };
  return publishAsync(db, event, { actor: options.actor || null });
}
