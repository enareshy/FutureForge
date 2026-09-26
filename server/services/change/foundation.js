// Idempotent bootstrap for the Change Management domain.
//
// Called on every application boot: registers event types, numbering object
// types + schemes for ECR/ECO/ECN (nothing on the platform registered a live
// numbering scheme before this), and per-tenant configuration. It also
// attempts — best effort, in one guarded block — onboarding `change_order`
// onto the generic Lifecycle + Approval engines so its CCB gate is a real
// exercise of `lifecycle_type_assignments` as designed (PDM itself still
// runs its own fallback state machine). If that block fails for any reason,
// Change Order approval/release still work correctly through the domain's
// own status field, so this never blocks boot and never blocks the feature.
import { queryOne } from "../../db.js";
import { tenantIds } from "../search/registry.js";
import { createObjectType } from "../numbering/foundation.js";
import { createScheme, setSchemeStatus } from "../numbering/schemes.js";
import { getSchemeRow as getNumberingSchemeRow } from "../numbering/scopes.js";
import { createType as createMetadataType, findType as findMetadataType } from "../metadata/types.js";
import {
  createDefinition as createLifecycleDefinition,
  createState as createLifecycleState,
  createTransition as createLifecycleTransition,
  publishDefinition as publishLifecycleDefinition,
  createAssignment as createLifecycleAssignment,
} from "../lifecycle/definitions.js";
import { createRule as createApprovalRule } from "../lifecycle/approvals.js";
import { ensureChangeEventTypes } from "./events.js";
import { ensureChangeConfig } from "./configuration.js";
import { SOURCE_MODULE, NUMBERING_OBJECT_TYPES, CHANGE_ORDER_OBJECT_TYPE } from "./constants.js";

const NUMBERING_SCHEME_DEFAULTS = {
  [NUMBERING_OBJECT_TYPES.REQUEST]: { code: "ECR_DEFAULT", pattern: "ECR-{SEQ}", padding: 6 },
  [NUMBERING_OBJECT_TYPES.ORDER]: { code: "ECO_DEFAULT", pattern: "ECO-{SEQ}", padding: 6 },
  [NUMBERING_OBJECT_TYPES.NOTICE]: { code: "ECN_DEFAULT", pattern: "ECN-{SEQ}", padding: 6 },
};

function ensureNumberingObjectType(db, code) {
  const existing = queryOne(db, "SELECT id FROM numbering_object_types WHERE code = ? AND tenant_id IS NULL", [code]);
  if (existing) return false;
  try {
    createObjectType(db, { code, name: code, module: "change", status: "active" }, null, null, null);
    return true;
  } catch {
    return false;
  }
}

function ensureNumberingSchemes(db) {
  let created = 0;
  for (const [objectTypeCode, config] of Object.entries(NUMBERING_SCHEME_DEFAULTS)) {
    const existing = getNumberingSchemeRow(db, config.code);
    if (existing) continue;
    try {
      const scheme = createScheme(
        db,
        { code: config.code, name: `${objectTypeCode} default numbering`, object_type_code: objectTypeCode, pattern: config.pattern, padding: config.padding, scope_type: "global" },
        null,
        null,
        null
      );
      setSchemeStatus(db, scheme.code, "active", null, null);
      created += 1;
    } catch {
      // Idempotent by design; a concurrent boot may have already created it.
    }
  }
  return created;
}

function ensureNumberingFoundation(db) {
  let objectTypes = 0;
  for (const code of Object.values(NUMBERING_OBJECT_TYPES)) {
    if (ensureNumberingObjectType(db, code)) objectTypes += 1;
  }
  const schemes = ensureNumberingSchemes(db);
  return { object_types: objectTypes, schemes };
}

// Best-effort: onboard `change_order` onto the generic Lifecycle + Approval
// engines so its CCB gate is a real, first-class exercise of the shared
// kernel rather than a domain-local status field only. Guarded as one block:
// any failure leaves Change Order's own status-driven approve/release path
// fully functional and boot unaffected. (The further step of also
// registering a `workflow_bindings` row to auto-start a CCB workflow
// instance on approval is deliberately left as a fast-follow — Change
// Order's own `decideOrder()` already fires the
// `lifecycle.release.approved` event via `triggerEvent`, so once such a
// binding is registered — by an administrator, or in a later pass here —
// it starts working with no code change.)
function registerGenericLifecycle(db) {
  try {
    if (findMetadataType(db, CHANGE_ORDER_OBJECT_TYPE, null)) return { registered: false, reason: "already registered" };
  } catch {
    // Not found is expected on first boot; continue registering.
  }
  try {
    const type = createMetadataType(db, { code: CHANGE_ORDER_OBJECT_TYPE, name: "Change Order", status: "active" }, null, null, null);

    const { definition, version } = createLifecycleDefinition(db, { code: "change-order-lifecycle", name: "Change Order Lifecycle", module: "change" }, null, null, null);
    const draft = createLifecycleState(db, { lifecycle_version_id: version.id, code: "draft", name: "Draft", is_initial: true, category: "draft" }, null, null, null);
    const inReview = createLifecycleState(db, { lifecycle_version_id: version.id, code: "in_review", name: "In Review", category: "in_review" }, null, null, null);
    const approved = createLifecycleState(db, { lifecycle_version_id: version.id, code: "approved", name: "Approved", category: "approved" }, null, null, null);
    const released = createLifecycleState(db, { lifecycle_version_id: version.id, code: "released", name: "Released", is_terminal: true, category: "released" }, null, null, null);

    createLifecycleTransition(db, { lifecycle_version_id: version.id, code: "submit", name: "Submit for review", from_state: draft.code, to_state: inReview.code }, null, null, null);
    const approveTransition = createLifecycleTransition(db, { lifecycle_version_id: version.id, code: "approve", name: "CCB approve", from_state: inReview.code, to_state: approved.code, requires_approval: true }, null, null, null);
    createLifecycleTransition(db, { lifecycle_version_id: version.id, code: "release", name: "Release", from_state: approved.code, to_state: released.code }, null, null, null);

    publishLifecycleDefinition(db, definition.id, {}, null, null, null);
    createLifecycleAssignment(db, { type: CHANGE_ORDER_OBJECT_TYPE, lifecycle: "change-order-lifecycle" }, null, null, null);

    const approvalRule = createApprovalRule(
      db,
      {
        code: "change-order-ccb-approval",
        name: "Change Order CCB Approval",
        kind: "release",
        module: "change",
        transition_id: approveTransition.id,
        min_approvals: 1,
        steps: [{ code: "ccb", name: "CCB", sequence: 1, approver_type: "role", approval_mode: "min", min_approvals: 1 }],
      },
      null,
      null,
      null
    );

    return { registered: true, type_id: type.id, lifecycle_definition_id: definition.id, approval_rule_id: approvalRule.id };
  } catch (err) {
    console.warn(`[change] Generic lifecycle/approval onboarding skipped (Change Order still works via its own status field): ${err?.message || err}`);
    return { registered: false, error: err?.message || String(err) };
  }
}

export function ensureChangeFoundation(db) {
  const eventTypes = ensureChangeEventTypes(db);
  const numbering = ensureNumberingFoundation(db);

  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }

  let configuration = 0;
  for (const tenantId of tenants) {
    configuration += ensureChangeConfig(db, tenantId).created || 0;
  }

  const genericLifecycle = registerGenericLifecycle(db);

  return {
    source_module: SOURCE_MODULE,
    event_types: eventTypes,
    numbering,
    configuration,
    tenants: tenants.length,
    generic_lifecycle: genericLifecycle,
  };
}

export function changeHealth(db, tenantId = null) {
  const scoped = (table) =>
    tenantId
      ? Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`, [Number(tenantId)])?.c || 0)
      : Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table}`)?.c || 0);
  return {
    source_module: SOURCE_MODULE,
    counts: {
      requests: scoped("change_requests"),
      orders: scoped("change_orders"),
      notices: scoped("change_notices"),
      affected_items: scoped("change_affected_items"),
      relationships: scoped("change_relationships"),
      history: scoped("change_history"),
    },
  };
}
