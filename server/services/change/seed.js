// Demonstration seed for Change Management. Idempotent: it walks a full
// ECR -> screen -> promote -> ECO -> affected item -> approve -> release ->
// ECN chain against the existing DEMO-PUMP-ASSY PDM product, so the release
// integration (a real effectivity assignment + frozen baseline) is visible
// immediately after boot. Numbers come from the numbering SDK, unlike PDM's
// own seed, which hard-codes literal item numbers.
import { queryOne } from "../../db.js";
import { queryOneAsync } from "../../db-async.js";
import { ensureChangeFoundation, ensureChangeFoundationAsync } from "./foundation.js";
import { createRequest, submitRequest, screenRequest, promoteRequest, createRequestAsync, submitRequestAsync, screenRequestAsync, promoteRequestAsync } from "./requests.js";
import { addAffectedItem, addAffectedItemAsync } from "./affected-items.js";
import { submitOrder as submitOrderTransition, decideOrder, releaseOrder, submitOrderAsync as submitOrderTransitionAsync, decideOrderAsync, releaseOrderAsync } from "./orders.js";
import { createNotice, issueNotice, createNoticeAsync, issueNoticeAsync } from "./notices.js";

function resolveTenantId(db, tenantId) {
  const explicit = Number(tenantId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  return helix?.id ?? null;
}

async function resolveTenantIdAsync(db, tenantId) {
  const explicit = Number(tenantId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const helix = await queryOneAsync(db, "SELECT id FROM organizations WHERE code = 'helix'");
  return helix?.id ?? null;
}

export function seedChange(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  const foundation = ensureChangeFoundation(db);
  if (!tenant) return { foundation, seeded: false, reason: "no_tenant" };

  const existing = queryOne(db, "SELECT id FROM change_requests WHERE tenant_id = ? AND title = 'Seal leakage on pump assembly'", [tenant]);
  if (existing) return { foundation, seeded: false, reason: "already_seeded" };

  const request = createRequest(
    db,
    tenant,
    {
      title: "Seal leakage on pump assembly",
      description: "Field reports of mechanical seal leakage on DEMO-PUMP-ASSY after 500 operating hours.",
      category: "QUALITY",
      priority: "HIGH",
      reason: "Warranty claims trending up for the seal component.",
    },
    null,
    null
  );
  submitRequest(db, tenant, request.id, null, null);
  screenRequest(db, tenant, request.id, "APPROVED", "CCB agrees this warrants a design change.", null, null);
  const { order } = promoteRequest(db, tenant, request.id, { title: "Upgrade mechanical seal material", description: "Switch DEMO-SEAL-004 to a higher-durometer seal compound." }, null, null);

  addAffectedItem(db, tenant, order.id, { object_type: "pdm_item", object_id: "DEMO-SEAL-004", object_label: "Mechanical seal", disposition: "NEW_REVISION", notes: "Material change only; form/fit unaffected." }, null, null);

  submitOrderTransition(db, tenant, order.id, null, null);
  decideOrder(db, tenant, order.id, "APPROVED", null, null);
  const release = releaseOrder(db, tenant, order.id, null, null);

  const draftNotice = createNotice(db, tenant, { change_order_id: order.id, title: `Notice: ${order.title}`, distribution: ["engineering", "manufacturing", "quality"] }, null, null);
  const notice = issueNotice(db, tenant, draftNotice.id, null, null);

  return { foundation, seeded: true, request, order: release.order, notice, baseline_id: release.baseline_id };
}

export async function seedChangeAsync(db, tenantId) {
  const tenant = await resolveTenantIdAsync(db, tenantId);
  const foundation = await ensureChangeFoundationAsync(db);
  if (!tenant) return { foundation, seeded: false, reason: "no_tenant" };

  const existing = await queryOneAsync(db, "SELECT id FROM change_requests WHERE tenant_id = ? AND title = 'Seal leakage on pump assembly'", [tenant]);
  if (existing) return { foundation, seeded: false, reason: "already_seeded" };

  const request = await createRequestAsync(
    db,
    tenant,
    {
      title: "Seal leakage on pump assembly",
      description: "Field reports of mechanical seal leakage on DEMO-PUMP-ASSY after 500 operating hours.",
      category: "QUALITY",
      priority: "HIGH",
      reason: "Warranty claims trending up for the seal component.",
    },
    null,
    null
  );
  await submitRequestAsync(db, tenant, request.id, null, null);
  await screenRequestAsync(db, tenant, request.id, "APPROVED", "CCB agrees this warrants a design change.", null, null);
  const { order } = await promoteRequestAsync(db, tenant, request.id, { title: "Upgrade mechanical seal material", description: "Switch DEMO-SEAL-004 to a higher-durometer seal compound." }, null, null);

  await addAffectedItemAsync(db, tenant, order.id, { object_type: "pdm_item", object_id: "DEMO-SEAL-004", object_label: "Mechanical seal", disposition: "NEW_REVISION", notes: "Material change only; form/fit unaffected." }, null, null);

  await submitOrderTransitionAsync(db, tenant, order.id, null, null);
  await decideOrderAsync(db, tenant, order.id, "APPROVED", null, null);
  const release = await releaseOrderAsync(db, tenant, order.id, null, null);

  const draftNotice = await createNoticeAsync(db, tenant, { change_order_id: order.id, title: `Notice: ${order.title}`, distribution: ["engineering", "manufacturing", "quality"] }, null, null);
  const notice = await issueNoticeAsync(db, tenant, draftNotice.id, null, null);

  return { foundation, seeded: true, request, order: release.order, notice, baseline_id: release.baseline_id };
}
