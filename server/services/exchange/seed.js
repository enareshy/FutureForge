// Demonstration and default seed for Standards & Exchange.
//
// Idempotent: installs the foundation (adapters, formats, event/job types,
// search sources and configuration) and then materialises a small, reusable set
// of exchange artifacts (validation profile, mappings and import/export
// definitions) so the capability is usable immediately after boot.
import { queryOne } from "../../db.js";
import { withEventSuppression } from "../events/emit.js";
import { ensureExchangeFoundation } from "./foundation.js";
import { createValidationProfile } from "./validation.js";
import { createMapping } from "./mappings.js";
import { createDefinition, publishDefinition } from "./definitions.js";

const VALIDATION_PROFILE = "JSON_PART_VALIDATION";
const MAPPING_CODE = "JSON_PART_MAPPING";
const IMPORT_DEFINITION = "JSON_PART_IMPORT";
const EXPORT_DEFINITION = "JSON_PART_EXPORT";

function resolveTenantId(db, tenantId) {
  const explicit = Number(tenantId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  return helix?.id ?? null;
}

function resolveSeedActor(db) {
  const admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin' LIMIT 1");
  if (admin) return { id: admin.id, username: admin.username };
  const any = queryOne(db, "SELECT id, username FROM users ORDER BY id LIMIT 1");
  return any ? { id: any.id, username: any.username } : null;
}

export function ensureDefaultExchangeArtifacts(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  if (!tenant) return { created: 0, reason: "no_tenant" };
  const actor = resolveSeedActor(db);
  let created = 0;

  if (!queryOne(db, "SELECT id FROM exchange_validation_profiles WHERE tenant_id = ? AND code = ?", [tenant, VALIDATION_PROFILE])) {
    createValidationProfile(
      db,
      tenant,
      {
        code: VALIDATION_PROFILE,
        name: "JSON part validation",
        description: "Baseline enterprise validation for JSON part imports.",
        format_code: "JSON",
        direction: "BOTH",
        target_object_type: "part",
        levels: ["FILE", "STANDARDS", "ENTERPRISE"],
        rules: [
          { sequence: 10, level: "ENTERPRISE", target_field: "external_id", rule_type: "REQUIRED", severity: "ERROR", message: "A part requires an external id" },
          { sequence: 20, level: "ENTERPRISE", target_field: "name", rule_type: "LENGTH", config: { max: 200 }, severity: "WARNING", message: "Part name should be 200 characters or fewer" },
        ],
      },
      actor
    );
    created += 1;
  }

  if (!queryOne(db, "SELECT id FROM exchange_mappings WHERE tenant_id = ? AND code = ?", [tenant, MAPPING_CODE])) {
    createMapping(
      db,
      tenant,
      {
        code: MAPPING_CODE,
        name: "JSON part mapping",
        description: "Maps canonical JSON part records onto the enterprise object shape.",
        format_code: "JSON",
        direction: "BOTH",
        source_kind: "CANONICAL",
        source_object_type: "part",
        target_object_type: "part",
        rules: [
          { sequence: 10, target_field: "code", source_field: "external_id", mapping_type: "DIRECT" },
          { sequence: 20, target_field: "name", source_field: "name", mapping_type: "DEFAULT", default_value: "" },
          { sequence: 30, target_field: "description", source_field: "description", mapping_type: "DEFAULT", default_value: "" },
          { sequence: 40, target_field: "status", source_field: "status", mapping_type: "DEFAULT", default_value: "draft" },
          { sequence: 50, target_field: "attributes", source_field: "attributes", mapping_type: "DIRECT" },
        ],
      },
      actor
    );
    created += 1;
  }

  if (!queryOne(db, "SELECT id FROM exchange_definitions WHERE tenant_id = ? AND code = ?", [tenant, IMPORT_DEFINITION])) {
    createDefinition(
      db,
      tenant,
      {
        code: IMPORT_DEFINITION,
        name: "JSON part import",
        description: "Import parts from a JSON payload, mapped and validated.",
        format_code: "JSON",
        direction: "IMPORT",
        source_object_type: "part",
        target_object_type: "part",
        mapping_code: MAPPING_CODE,
        validation_profile_code: VALIDATION_PROFILE,
        security_policy: { require_authorization: false },
      },
      actor
    );
    created += 1;
  }

  if (!queryOne(db, "SELECT id FROM exchange_definitions WHERE tenant_id = ? AND code = ?", [tenant, EXPORT_DEFINITION])) {
    const definition = createDefinition(
      db,
      tenant,
      {
        code: EXPORT_DEFINITION,
        name: "JSON part export",
        description: "Export enterprise parts to a JSON payload.",
        format_code: "JSON",
        direction: "EXPORT",
        source_object_type: "part",
        target_object_type: "part",
        validation_profile_code: VALIDATION_PROFILE,
        security_policy: { require_authorization: false },
      },
      actor
    );
    publishDefinition(db, tenant, definition.id, { change_summary: "Seeded default" }, actor);
    created += 1;
  }

  return { created };
}

export function seedExchange(db, tenantId) {
  return withEventSuppression(() => {
    const tenant = resolveTenantId(db, tenantId);
    const foundation = ensureExchangeFoundation(db);
    if (!tenant) return { foundation, seeded: false, reason: "no_tenant" };
    const artifacts = ensureDefaultExchangeArtifacts(db, tenant);
    return { foundation, artifacts, seeded: true };
  });
}

export function ensureExchangeSeed(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  if (!tenant) return { seeded: false, reason: "no_tenant" };
  const existing = queryOne(db, "SELECT id FROM exchange_definitions WHERE tenant_id = ? AND code = ?", [tenant, IMPORT_DEFINITION]);
  if (existing) return { seeded: false, reason: "already_present" };
  return seedExchange(db, tenant);
}
