import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as I from "../services/integration.js";

// Async parity for the Integration & API Framework. The synchronous service is
// the reference; every async twin must return the same data (reads) and mirror
// the same semantics (writes). Distinct codes/refs are used per layer so the
// two paths never observe each other's writes.

const VOLATILE = /(_at$|_ms$|generated_at|latency_ms|now$)/;

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (VOLATILE.test(key)) continue;
      out[key] = normalize(entry);
    }
    return out;
  }
  return value;
}

function adminActor(db) {
  const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  return row ? { id: row.id, username: row.username } : null;
}

describe("async integration twins mirror the synchronous service", () => {
  let db;
  let actor;
  let tenantId;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor.tenant_id = tenantId;

    const system = I.Systems.createExternalSystem(db, { code: "par-erp", system_type: "erp", environment: "test" }, actor, tenantId);
    I.Systems.createCredential(db, { code: "par-cred", kind: "api_key", secret: "par-secret-value" }, actor, tenantId);
    I.Endpoints.createEndpoint(db, { code: "par-ep", method: "GET", path: "/widgets", system_id: system.id }, actor, tenantId);
    I.Transform.createTransformation(db, { code: "par-map", source_format: "json", target_format: "json", mappings: [{ source: "name", target: "Name" }] }, actor, tenantId);
    I.Mappings.upsertMapping(db, { external_system_id: system.id, external_object_type: "material", external_object_id: "PAR-M1", internal_object_type: "part", internal_object_id: "PAR-P1" }, actor, tenantId);
    I.Schedules.createSchedule(db, { code: "par-sched", schedule_type: "interval", interval_seconds: 3600 }, actor, tenantId);
    I.Definitions.createDefinition(db, { code: "par-def", integration_type: "api", direction: "inbound", adapter_type: "internal", config: {}, status: "active" }, actor, tenantId);
    I.Events.createEventType(db, { code: "ParEvent", category: "test" }, actor, tenantId);
    I.Events.createSubscription(db, { code: "par-sub", event_type_code: "ParEvent", subscriber_type: "internal", target_ref: "sink" }, actor, tenantId);
    I.Events.publishEvent(db, { event_type_code: "ParEvent", payload: { n: 1 } }, actor);
    I.Messages.enqueueMessage(db, { message_type: "par.msg", payload: { a: 1 }, max_attempts: 1 }, actor);
    const inbound = I.Webhooks.createInboundWebhook(db, { code: "par-in-hook", auth_type: "none" }, actor, tenantId);
    I.Webhooks.receiveInboundWebhook(db, inbound.code, { headers: {}, body: { event_type: "ParEvent", payload: {} } });
    I.Webhooks.createOutboundWebhook(db, { code: "par-out-hook", url: "https://example.com/par" }, actor, tenantId);
    I.ApiCatalog.createCatalogEntry(db, { code: "par-api", method: "GET", path: "/par", name: "Par API" }, actor, tenantId);
    const client = I.ApiCatalog.createApiClient(db, { code: "par-client", scopes: ["read"] }, actor, tenantId);
    I.ApiCatalog.recordApiUsage(db, { clientId: client.id, endpointCode: "par-api", statusCode: 200, durationMs: 3, tenantId });
  });

  after(() => db?.close());

  test("read twins match: systems, endpoints, transforms, mappings, schedules, definitions", async () => {
    const cases = [
      [I.Systems.listExternalSystemsAsync, I.Systems.listExternalSystems, [{ tenantId }]],
      [I.Systems.listCredentialsAsync, I.Systems.listCredentials, [{ tenantId }]],
      [I.Endpoints.listEndpointsAsync, I.Endpoints.listEndpoints, [{ tenantId }]],
      [I.Transform.listTransformationsAsync, I.Transform.listTransformations, [{ tenantId }]],
      [I.Mappings.listMappingsAsync, I.Mappings.listMappings, [{ tenantId }]],
      [I.Mappings.mappingStatsAsync, I.Mappings.mappingStats, [{ tenantId }]],
      [I.Schedules.listSchedulesAsync, I.Schedules.listSchedules, [{ tenantId }]],
      [I.Definitions.listDefinitionsAsync, I.Definitions.listDefinitions, [{ tenantId }]],
    ];
    for (const [asyncFn, syncFn, args] of cases) {
      assert.deepEqual(normalize(await asyncFn(db, ...args)), normalize(syncFn(db, ...args)), asyncFn.name);
    }
    const sys = I.Systems.getExternalSystem(db, "par-erp", { tenantId });
    assert.deepEqual(normalize(await I.Systems.getExternalSystemAsync(db, "par-erp", { tenantId })), normalize(sys));
    assert.deepEqual(normalize(await I.Systems.testConnectionAsync(db, "par-erp", actor, "127.0.0.1")), normalize(I.Systems.testConnection(db, "par-erp", actor, "127.0.0.1")));
  });

  test("read twins match: events, subscriptions, deliveries, messages, dead letters", async () => {
    const cases = [
      [I.Events.listEventTypesAsync, I.Events.listEventTypes, [{ pageSize: 100 }]],
      [I.Events.listSubscriptionsAsync, I.Events.listSubscriptions, [{ tenantId }]],
      [I.Events.listEventsAsync, I.Events.listEvents, [{ tenantId }]],
      [I.Events.listDeliveriesAsync, I.Events.listDeliveries, [{}]],
      [I.Messages.listMessagesAsync, I.Messages.listMessages, [{ tenantId }]],
      [I.Messages.listQueuesAsync, I.Messages.listQueues, [{ tenantId }]],
      [I.DeadLetter.listDeadLettersAsync, I.DeadLetter.listDeadLetters, [{ tenantId }]],
      [I.DeadLetter.deadLetterStatsAsync, I.DeadLetter.deadLetterStats, [{ tenantId }]],
    ];
    for (const [asyncFn, syncFn, args] of cases) {
      assert.deepEqual(normalize(await asyncFn(db, ...args)), normalize(syncFn(db, ...args)), asyncFn.name);
    }
  });

  test("read twins match: webhooks, transfers, api catalog, monitoring", async () => {
    const cases = [
      [I.Webhooks.listInboundWebhooksAsync, I.Webhooks.listInboundWebhooks, [{ tenantId }]],
      [I.Webhooks.listOutboundWebhooksAsync, I.Webhooks.listOutboundWebhooks, [{ tenantId }]],
      [I.Webhooks.listOutboundDeliveriesAsync, I.Webhooks.listOutboundDeliveries, [{}]],
      [I.ApiCatalog.listApiCatalogAsync, I.ApiCatalog.listApiCatalog, [{ tenantId }]],
      [I.ApiCatalog.listApiClientsAsync, I.ApiCatalog.listApiClients, [{ tenantId }]],
      [I.ApiCatalog.listApiUsageAsync, I.ApiCatalog.listApiUsage, [{ tenantId }]],
      [I.ApiCatalog.apiUsageStatsAsync, I.ApiCatalog.apiUsageStats, [{ tenantId }]],
    ];
    for (const [asyncFn, syncFn, args] of cases) {
      assert.deepEqual(normalize(await asyncFn(db, ...args)), normalize(syncFn(db, ...args)), asyncFn.name);
    }
    const inbound = I.Webhooks.getInboundWebhook(db, "par-in-hook");
    assert.deepEqual(normalize(await I.Webhooks.listInboundReceiptsAsync(db, { endpointId: inbound.id })), normalize(I.Webhooks.listInboundReceipts(db, { endpointId: inbound.id })));

    const syncOverview = I.Monitoring.monitoringOverview(db, { tenantId, hours: 24 });
    const asyncOverview = await I.Monitoring.monitoringOverviewAsync(db, { tenantId, hours: 24 });
    assert.equal(asyncOverview.definitions.total, syncOverview.definitions.total);
    assert.equal(asyncOverview.executions.totals.total, syncOverview.executions.totals.total);
    assert.equal(normalize(await I.Monitoring.listSystemsHealthAsync(db, { tenantId })).length, normalize(I.Monitoring.listSystemsHealth(db, { tenantId })).length);
  });

  test("write twins: systems, credentials, transforms, mappings, schedules", async () => {
    const asyncSystem = await I.Systems.createExternalSystemAsync(db, { code: "par-async-sys", system_type: "crm", environment: "test" }, actor, tenantId);
    const syncSystem = I.Systems.createExternalSystem(db, { code: "par-sync-sys", system_type: "crm", environment: "test" }, actor, tenantId);
    assert.deepEqual(normalize({ ...asyncSystem, id: undefined, code: undefined, name: undefined }), normalize({ ...syncSystem, id: undefined, code: undefined, name: undefined }));
    assert.equal((await I.Systems.getExternalSystemAsync(db, "par-async-sys", { tenantId })).code, "par-async-sys");

    const cred = await I.Systems.createCredentialAsync(db, { code: "par-async-cred", kind: "api_key", secret: "async-secret" }, actor, tenantId);
    assert.equal(cred.has_secret, true);
    assert.equal(cred.secret, undefined);
    assert.equal((await I.Systems.resolveCredentialSecretAsync(db, cred.id)).secret, "async-secret");

    const transformation = await I.Transform.createTransformationAsync(db, { code: "par-async-map", source_format: "json", target_format: "json", mappings: [{ source: "name", target: "Name" }] }, actor, tenantId);
    const applied = I.Transform.applyTransformation({ ...transformation }, { name: "bolt" });
    assert.equal(applied.output.Name, "bolt");

    const system = I.Systems.getExternalSystem(db, "par-erp", { tenantId });
    const mapping = await I.Mappings.upsertMappingAsync(db, { external_system_id: system.id, external_object_type: "material", external_object_id: "PAR-AM2", internal_object_type: "part", internal_object_id: "PAR-AP2" }, actor, tenantId);
    assert.equal(mapping.status, "active");
    const conflict = await I.Mappings.upsertMappingAsync(db, { external_system_id: system.id, external_object_type: "material", external_object_id: "PAR-AM3", internal_object_type: "part", internal_object_id: "PAR-AP2" }, actor, tenantId);
    assert.equal(conflict.status, "conflict");

    const schedule = await I.Schedules.createScheduleAsync(db, { code: "par-async-sched", schedule_type: "daily", daily_time: "03:00" }, actor, tenantId);
    assert.equal(schedule.code, "par-async-sched");
    assert.equal(schedule.status, "active");
    I.Schedules.createSchedule(db, { code: "par-sync-sched", schedule_type: "daily", daily_time: "03:00" }, actor, tenantId);
    const asyncRun = await I.Schedules.runScheduleNowAsync(db, "par-async-sched", actor);
    const syncRun = I.Schedules.runScheduleNow(db, "par-sync-sched", actor);
    assert.deepEqual({ ran: asyncRun.ran, reason: asyncRun.reason }, { ran: syncRun.ran, reason: syncRun.reason });
  });

  test("write twins: events, messages, webhooks, api clients", async () => {
    await I.Events.createEventTypeAsync(db, { code: "ParAsyncEvent", category: "test" }, actor, tenantId);
    await I.Events.createSubscriptionAsync(db, { code: "par-async-sub", event_type_code: "ParAsyncEvent", subscriber_type: "internal", target_ref: "sink" }, actor, tenantId);
    const published = await I.Events.publishEventAsync(db, { event_type_code: "ParAsyncEvent", payload: { n: 2 } }, actor);
    assert.equal(published.deliveries.length, 1);
    assert.equal((await I.Events.listDeliveriesAsync(db, { eventId: published.id })).total, 1);

    const message = await I.Messages.enqueueMessageAsync(db, { message_type: "par.async.msg", payload: { a: 2 }, max_attempts: 1 }, actor);
    assert.equal(message.status, "pending");
    const summary = await I.Messages.processDueMessagesAsync(db, async () => {
      throw Object.assign(new Error("boom"), { category: "external_system" });
    });
    assert.ok(summary.failed >= 1);
    assert.equal((await I.Messages.getMessageAsync(db, message.id)).status, "dead_letter");

    const hookCred = await I.Systems.createCredentialAsync(db, { code: "par-async-sign", kind: "signature", secret: "par-hook-secret" }, actor, tenantId);
    const inbound = await I.Webhooks.createInboundWebhookAsync(db, { code: "par-async-in", auth_type: "signature", credential_id: hookCred.id, event_type_code: "ParEvent" }, actor, tenantId);
    const hookBody = { event_type: "ParEvent", payload: { id: "PA1" } };
    const hookRaw = JSON.stringify(hookBody);
    const hookSignature = I.Validation.signPayload(hookRaw, "par-hook-secret");
    const first = await I.Webhooks.receiveInboundWebhookAsync(db, inbound.code, { headers: { "x-integration-signature": hookSignature }, body: hookBody, rawBody: hookRaw });
    assert.equal(first.accepted, true);
    const replay = await I.Webhooks.receiveInboundWebhookAsync(db, inbound.code, { headers: { "x-integration-signature": hookSignature }, body: hookBody, rawBody: hookRaw });
    assert.equal(replay.duplicate, true);
    await assert.rejects(() => I.Webhooks.receiveInboundWebhookAsync(db, "par-missing-hook", { headers: {}, body: {} }), /not found/i);

    await I.Webhooks.createOutboundWebhookAsync(db, { code: "par-async-out", url: "https://example.com/par-async" }, actor, tenantId);
    const client = await I.ApiCatalog.createApiClientAsync(db, { code: "par-async-client", scopes: ["read"] }, actor, tenantId);
    assert.ok(client.api_key);
    assert.equal(client.api_key_hash, undefined);
  });

  test("write twins: definitions execution and transfers", async () => {
    I.Definitions.registerIntegrationHandler("par.async.echo", async (request) => ({ echoed: request.body }));
    const definition = await I.Definitions.createDefinitionAsync(db, { code: "par-async-def", integration_type: "api", direction: "outbound", adapter_type: "internal", config: { handler_code: "par.async.echo" }, status: "active" }, actor, tenantId);
    assert.equal(definition.code, "par-async-def");
    const result = await I.Definitions.executeIntegrationAsync(db, "par-async-def", { triggerType: "manual", actor, input: { payload: { hello: "async" } } });
    assert.equal(result.execution.status, "succeeded");
    assert.equal((await I.Definitions.listExecutionsAsync(db, { definitionId: definition.id })).total, 1);

    I.Transfers.registerImporter("par.async.widgets", async (_db, rows) => ({ created: rows.length, updated: 0, skipped: 0, duplicates: 0, errors: [] }));
    const preview = await I.Transfers.previewImportAsync(db, { format: "json", content: JSON.stringify([{ code: "PA1" }]) }, actor, tenantId);
    assert.deepEqual(preview.fields, ["code"]);
    const transfer = await I.Transfers.runImportTransferAsync(db, { direction: "import", format: "csv", resource_type: "par.async.widgets", content: "code,qty\nPA1,1\nPA2,2\n" }, actor, tenantId);
    assert.equal(transfer.status, "completed");
    assert.equal(transfer.total_rows, 2);
    assert.equal((await I.Transfers.getTransferAsync(db, transfer.transfer_ref)).transfer_ref, transfer.transfer_ref);
  });
});
