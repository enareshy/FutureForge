import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as integration from "../services/integration.js";

// Service-level coverage for the Integration & API Framework: event publish/
// subscribe, definitions + execution, adapters, transformation, webhooks,
// message queues, dead letters, transfers, monitoring and API clients.

describe("integration framework services", () => {
  let db;
  let actor;
  let tenantId;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    actor.tenant_id = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    tenantId = actor.tenant_id;
  });

  test("seeds the default domain event catalogue", () => {
    const types = integration.Events.listEventTypes(db, { pageSize: 100 });
    assert.ok(types.total >= 13);
    assert.ok(types.items.some((t) => t.code === "ProductCreated"));
    const seeded = integration.Events.ensureDefaultEventTypes(db);
    assert.equal(seeded.created, 0, "idempotent");
  });

  test("publishes events, matches subscription filters and replays", () => {
    const eventType = integration.Events.createEventType(db, { code: "TestWidgetCreated", category: "test" });
    assert.equal(eventType.code, "TestWidgetCreated");
    const sub = integration.Events.createSubscription(
      db,
      { code: "test-widget-sub", event_type_code: "TestWidgetCreated", subscriber_type: "internal", target_ref: "handler.widget", filter: { action: "create" } },
      actor,
      tenantId
    );
    assert.equal(sub.event_type_code, "TestWidgetCreated");

    const matched = integration.Events.publishEvent(db, { event_type_code: "TestWidgetCreated", payload: { action: "create", id: "W1" } }, actor);
    assert.equal(matched.deliveries.length, 1);
    assert.equal(matched.deliveries[0].subscriber_type, "internal");

    const unmatched = integration.Events.publishEvent(db, { event_type_code: "TestWidgetCreated", payload: { action: "delete" } }, actor);
    assert.equal(unmatched.deliveries.length, 0);

    const duplicate = integration.Events.publishEvent(db, { event_type_code: "TestWidgetCreated", payload: { action: "create" }, idempotency_key: "idem-1" }, actor);
    const again = integration.Events.publishEvent(db, { event_type_code: "TestWidgetCreated", payload: { action: "create" }, idempotency_key: "idem-1" }, actor);
    assert.equal(again.duplicate, true);

    const replay = integration.Events.replayEvent(db, duplicate.event_ref, actor);
    assert.notEqual(replay.event_ref, duplicate.event_ref);
    assert.equal(integration.Events.listDeliveries(db, { eventId: duplicate.id }).total, 1);
  });

  test("processes internal event deliveries and retries failures", async () => {
    integration.Events.createEventType(db, { code: "TestDispatch", category: "test" });
    integration.Events.createSubscription(db, { code: "dispatch-sub", event_type_code: "TestDispatch", subscriber_type: "internal", target_ref: "ok" }, actor, tenantId);
    integration.Events.publishEvent(db, { event_type_code: "TestDispatch", payload: { n: 1 } }, actor);
    const ok = await integration.Events.processDueDeliveries(db, async () => {});
    assert.ok(ok.delivered >= 1);

    integration.Events.createSubscription(db, { code: "dispatch-bad", event_type_code: "TestDispatch", subscriber_type: "internal", target_ref: "bad" }, actor, tenantId);
    integration.Events.publishEvent(db, { event_type_code: "TestDispatch", payload: { n: 2 } }, actor);
    const bad = await integration.Events.processDueDeliveries(db, async () => {
      throw Object.assign(new Error("boom"), { category: "technical" });
    });
    assert.ok(bad.retried >= 1);
  });

  test("definitions snapshot versions and execute through an internal handler", async () => {
    integration.Definitions.registerIntegrationHandler("test.echo", async (request) => ({ echoed: request.body }));
    const created = integration.Definitions.createDefinition(
      db,
      { code: "test-echo", integration_type: "api", direction: "outbound", adapter_type: "internal", config: { handler_code: "test.echo" }, status: "active" },
      actor,
      tenantId
    );
    assert.equal(created.code, "test-echo");
    assert.ok(created.version >= 1);

    const updated = integration.Definitions.updateDefinition(db, "test-echo", { description: "updated" }, actor);
    assert.ok(updated.version >= created.version);
    assert.ok(integration.Definitions.listDefinitionVersions(db, "test-echo").total >= 2);

    const result = await integration.Definitions.executeIntegration(db, "test-echo", { triggerType: "manual", actor, input: { payload: { hello: "world" } } });
    assert.equal(result.execution.status, "succeeded");
    assert.ok(result.execution.steps.length >= 2);
    assert.equal(integration.Definitions.listExecutions(db, { definitionId: created.id }).total, 1);
  });

  test("adapter registry and transformation engine are pluggable", () => {
    assert.ok(integration.Adapters.listAdapters().some((a) => a.type === "rest"));
    const adapter = integration.Adapters.createAdapter("rest", { url: "https://example.com", timeout_ms: 1000 });
    assert.equal(adapter.type, "rest");

    integration.Transform.registerTransformExtension("upper", (value) => String(value).toUpperCase());
    const transformation = integration.Transform.createTransformation(
      db,
      {
        code: "test-map",
        source_format: "json",
        target_format: "json",
        mappings: [{ source: "name", target: "Name" }, { source: "qty", target: "Qty", type: "number" }],
      },
      actor,
      tenantId
    );
    const applied = integration.Transform.applyTransformation({ ...transformation }, { name: "bolt", qty: "5" });
    assert.equal(applied.output.Name, "bolt");
    assert.equal(applied.output.Qty, 5);
    assert.deepEqual(integration.Transform.parseCsv("a,b\n1,2"), [{ a: "1", b: "2" }]);
    assert.match(integration.Transform.toCsvRows([{ a: 1, b: 2 }]), /a,b/);
  });

  test("credentials are encrypted at rest and resolvable", () => {
    const credential = integration.Systems.createCredential(db, { code: "test-cred", kind: "api_key", secret: "super-secret-value" }, actor, tenantId);
    assert.equal(credential.has_secret, true);
    assert.equal(credential.secret, undefined);
    const resolved = integration.Systems.resolveCredentialSecret(db, credential.id);
    assert.equal(resolved.secret, "super-secret-value");
    const raw = queryOne(db, "SELECT secret_enc FROM integration_credentials WHERE id = ?", [credential.id]);
    assert.ok(!String(raw.secret_enc).includes("super-secret-value"));
  });

  test("external object mappings detect conflicts", () => {
    const system = integration.Systems.createExternalSystem(db, { code: "test-erp", system_type: "erp", environment: "test" }, actor, tenantId);
    const mapping = integration.Mappings.upsertMapping(
      db,
      { external_system_id: system.id, external_object_type: "material", external_object_id: "M1", internal_object_type: "part", internal_object_id: "P1" },
      actor,
      tenantId
    );
    assert.equal(mapping.status, "active");
    const conflict = integration.Mappings.upsertMapping(
      db,
      { external_system_id: system.id, external_object_type: "material", external_object_id: "M2", internal_object_type: "part", internal_object_id: "P1" },
      actor,
      tenantId
    );
    assert.equal(conflict.status, "conflict");
    assert.equal(integration.Mappings.findMapping(db, { externalSystemId: system.id, externalObjectType: "material", externalObjectId: "M1" }).internal_object_id, "P1");
  });

  test("message queue retries then dead-letters", async () => {
    const message = integration.Messages.enqueueMessage(db, { message_type: "test.msg", payload: { a: 1 }, max_attempts: 1 }, actor);
    assert.equal(message.status, "pending");
    const summary = await integration.Messages.processDueMessages(db, async () => {
      throw Object.assign(new Error("nope"), { category: "external_system" });
    });
    assert.ok(summary.failed >= 1);
    const after = integration.Messages.getMessage(db, message.id);
    assert.equal(after.status, "dead_letter");
    assert.ok(integration.Messages.queueDepth(db).total >= 1);
  });

  test("transfers import rows through a registered importer", async () => {
    let captured = 0;
    integration.Transfers.registerImporter("test.widgets", async (_db, rows) => {
      captured = rows.length;
      return { created: rows.length, updated: 0, skipped: 0, duplicates: 0, errors: [] };
    });
    const transfer = await integration.Transfers.runImportTransfer(
      db,
      { direction: "import", format: "csv", resource_type: "test.widgets", content: "code,qty\nW1,3\nW2,4\n" },
      actor,
      tenantId
    );
    assert.equal(transfer.status, "completed");
    assert.equal(transfer.total_rows, 2);
    assert.equal(captured, 2);

    const payload = integration.Transfers.previewImport(db, { format: "json", content: JSON.stringify([{ code: "W3" }]) }, actor, tenantId);
    assert.deepEqual(payload.fields, ["code"]);
  });

  test("inbound webhooks verify signatures and reject replays", () => {
    const credential = integration.Systems.createCredential(db, { code: "wh-secret", kind: "signature", secret: "hook-secret" }, actor, tenantId);
    const endpoint = integration.Webhooks.createInboundWebhook(
      db,
      { code: "test-hook", auth_type: "signature", credential_id: credential.id, event_type_code: "ProductCreated" },
      actor,
      tenantId
    );
    const body = { event_type: "ProductCreated", payload: { id: "P1" } };
    const raw = JSON.stringify(body);
    const signature = integration.Validation.signPayload(raw, "hook-secret");
    const accepted = integration.Webhooks.receiveInboundWebhook(db, endpoint.code, { headers: { "x-integration-signature": signature }, body, rawBody: raw });
    assert.equal(accepted.accepted, true);
    assert.ok(accepted.event);

    const replay = integration.Webhooks.receiveInboundWebhook(db, endpoint.code, { headers: { "x-integration-signature": signature }, body, rawBody: raw });
    assert.equal(replay.duplicate, true);

    const disabled = integration.Webhooks.createInboundWebhook(db, { code: "disabled-hook", auth_type: "none" }, actor, tenantId);
    integration.Webhooks.setInboundWebhookStatus(db, disabled.code, "inactive", actor);
    assert.throws(() => integration.Webhooks.receiveInboundWebhook(db, disabled.code, { headers: {}, body: {} }), /not active/i);
    assert.throws(() => integration.Webhooks.receiveInboundWebhook(db, "missing-hook", { headers: {}, body: {} }), /not found/i);
  });

  test("outbound webhooks dispatch and record deliveries", async () => {
    integration.Webhooks.createOutboundWebhook(db, { code: "out-hook", url: "https://example.com/hook" }, actor, tenantId);
    integration.Events.createSubscription(db, { code: "out-sub", event_type_code: "ProductCreated", subscriber_type: "webhook", target_ref: "out-hook" }, actor, tenantId);
    integration.Events.publishEvent(db, { event_type_code: "ProductCreated", payload: { id: "P2" } }, actor);
    const summary = await integration.Webhooks.processDueWebhookDeliveries(db, {
      fetchImpl: async () => ({ status: 200, body: JSON.stringify({ ok: true }), durationMs: 5 }),
    });
    assert.ok(summary.delivered >= 1);
    const deliveries = integration.Webhooks.listOutboundDeliveries(db, {});
    assert.ok(deliveries.items.some((d) => d.status === "delivered" && d.response_code === 200));
  });

  test("API clients authenticate hashed keys and enforce rate limits", () => {
    const client = integration.ApiCatalog.createApiClient(db, { code: "test-client", scopes: ["read"] }, actor, tenantId);
    assert.ok(client.api_key);
    assert.equal(client.api_key_hash, undefined);
    assert.equal(integration.ApiCatalog.authenticateApiClient(db, client.api_key).code, "test-client");
    assert.equal(integration.ApiCatalog.authenticateApiClient(db, "wrong-key"), null);

    integration.ApiCatalog.recordApiUsage(db, { clientId: client.id, endpointCode: "test", statusCode: 200, durationMs: 12, tenantId });
    const limit = integration.ApiCatalog.checkRateLimit(db, { clientId: client.id, limitPerMinute: 1 });
    assert.equal(limit.allowed, false);
  });

  test("monitoring overview aggregates definitions, executions and deliveries", () => {
    const overview = integration.Monitoring.monitoringOverview(db, { tenantId, hours: 24 });
    assert.ok(overview.definitions.total >= 1);
    assert.ok(overview.executions.totals.total >= 1);
    assert.ok(overview.generated_at);
    const metrics = integration.Monitoring.executionMetrics(db, { tenantId });
    assert.ok(metrics.totals.total >= 1);
  });
});
