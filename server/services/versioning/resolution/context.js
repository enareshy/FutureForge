// ContextValidator — normalizes and validates an EffectivityContext before any
// candidate work happens. All fields are optional; only fields the caller
// supplies are validated so irrelevant dimensions are never required.
import { queryOne } from "../../../db.js";
import { validateContextInput } from "../validation.js";

function looksNumericId(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && String(numeric) === String(value) ? numeric : null;
}

// Resolve a configuration reference (id or code) into a concrete context row.
export function resolveConfigurationContext(db, context) {
  const ref = context.configurationId ?? context.configurationRef;
  if (ref === undefined || ref === null || ref === "") return null;
  const numeric = looksNumericId(ref);
  if (numeric !== null) {
    return queryOne(db, "SELECT * FROM versioning_configuration_contexts WHERE id = ?", [numeric]);
  }
  return queryOne(db, "SELECT * FROM versioning_configuration_contexts WHERE context_ref = ? OR code = ?", [
    String(ref),
    String(ref),
  ]);
}

function resolveRevisionByRef(db, context) {
  if (context.revisionId !== undefined && context.revisionId !== null && context.revisionId !== "") {
    const numeric = looksNumericId(context.revisionId);
    if (numeric !== null) return queryOne(db, "SELECT * FROM versioning_revisions WHERE id = ?", [numeric]);
    return queryOne(db, "SELECT * FROM versioning_revisions WHERE revision_ref = ?", [String(context.revisionId)]);
  }
  if (context.revisionRef) {
    return queryOne(db, "SELECT * FROM versioning_revisions WHERE revision_ref = ?", [String(context.revisionRef)]);
  }
  return null;
}

function resolveVariantByRef(db, context) {
  const ref = context.variantId ?? context.variantCode;
  if (ref === undefined || ref === null || ref === "") return null;
  const numeric = looksNumericId(ref);
  if (numeric !== null) return queryOne(db, "SELECT * FROM versioning_variants WHERE id = ?", [numeric]);
  return queryOne(db, "SELECT * FROM versioning_variants WHERE variant_ref = ? OR code = ?", [String(ref), String(ref)]);
}

export const ContextValidator = {
  // Returns { valid, errors, context, configuration, revision, variant }.
  validate(db, rawContext = {}) {
    let context;
    try {
      context = validateContextInput(rawContext);
    } catch (error) {
      return { valid: false, errors: error.details?.errors ?? [error.message], context: null };
    }

    const configuration = resolveConfigurationContext(db, context);
    const revision = resolveRevisionByRef(db, context);
    const variant = resolveVariantByRef(db, context);

    // Enrich the context from the named configuration context when the caller
    // supplied only a configuration id. Explicit context values win.
    if (configuration) {
      context.configurationContextId = configuration.id;
      context.configurationId = context.configurationId ?? configuration.code;
      context.modelId = context.modelId ?? configuration.model_id ?? null;
      context.plantId = context.plantId ?? configuration.plant_id ?? null;
      context.siteId = context.siteId ?? configuration.site_id ?? null;
      context.organizationId = context.organizationId ?? configuration.organization_id ?? null;
      context.variantId = context.variantId ?? configuration.variant_id ?? null;
      context.asOfDate = context.asOfDate ?? configuration.as_of_date ?? null;
      context.serialNumber = context.serialNumber ?? configuration.serial_number ?? null;
      context.revisionId = context.revisionId ?? configuration.revision_id ?? null;
    }
    if (revision) {
      context.revisionRowId = revision.id;
      context.objectType = context.objectType ?? null;
    }
    if (variant) {
      context.variantRowId = variant.id;
      context.variantCode = context.variantCode ?? variant.code;
    }

    const errors = [];
    if (context.revisionId !== undefined && context.revisionId !== null && context.revisionId !== "" && !revision) {
      errors.push(`revisionId references an unknown revision: ${context.revisionId}`);
    }
    if (configuration && configuration.status !== "active") {
      errors.push(`configuration context ${configuration.code} is not active`);
    }
    if (variant && variant.status !== "active") {
      errors.push(`variant ${variant.code} is not active`);
    }

    return { valid: errors.length === 0, errors, context, configuration, revision, variant };
  },

  // Convenience: returns true when the context carries no discriminators.
  isEmpty(context) {
    return ![
      context.asOfDate,
      context.serialNumber,
      context.tenantId,
      context.organizationId,
      context.plantId,
      context.siteId,
      context.unitId,
      context.modelId,
      context.revisionId,
      context.revisionRef,
      context.variantId,
      context.variantCode,
      context.configurationId,
      context.configurationRef,
    ].some((value) => value !== undefined && value !== null && value !== "");
  },
};
