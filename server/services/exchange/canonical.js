// Canonical Exchange Model (§6).
//
// A lightweight, provider-neutral representation that sits between external
// standards and the FutureForge enterprise object model. It deliberately does
// NOT duplicate Object & Relationship, PDM, BOM or File semantics: it only
// carries enough structure to be mapped onto them by the processor.
import { CANONICAL_MODEL_VERSION } from "./constants.js";

export const CANONICAL_OBJECT_FIELDS = Object.freeze([
  "external_id",
  "object_type",
  "subtype",
  "name",
  "description",
  "revision",
  "lifecycle_state",
  "status",
  "unit_system",
  "quantity",
  "uom",
  "attributes",
  "identifiers",
  "classification",
  "metadata",
  "documents",
  "geometry_refs",
  "external_identifiers",
  "bom",
]);

export const CANONICAL_RELATIONSHIP_FIELDS = Object.freeze([
  "external_id",
  "relationship_type",
  "semantic",
  "source_ref",
  "target_ref",
  "quantity",
  "uom",
  "metadata",
]);

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function str(value) {
  return value === null || value === undefined ? "" : String(value);
}

export function emptyDocument(meta = {}) {
  return {
    model_version: CANONICAL_MODEL_VERSION,
    source: {
      format: meta.format || "",
      format_version: meta.format_version || "",
      adapter: meta.adapter || "",
      file_name: meta.file_name || "",
      mime_type: meta.mime_type || "",
      detected: meta.detected === true,
      imported_at: meta.imported_at || new Date().toISOString(),
    },
    metadata: meta.metadata || {},
    objects: [],
    relationships: [],
    references: [],
    warnings: [],
  };
}

export function createCanonicalObject(input = {}) {
  return {
    external_id: str(input.external_id || input.externalId || input.id),
    object_type: str(input.object_type || input.objectType || input.type),
    subtype: str(input.subtype),
    name: str(input.name),
    description: str(input.description),
    revision: str(input.revision),
    lifecycle_state: str(input.lifecycle_state || input.lifecycleState),
    status: str(input.status),
    unit_system: str(input.unit_system || input.unitSystem),
    quantity: input.quantity === undefined ? null : input.quantity,
    uom: str(input.uom),
    attributes: input.attributes && typeof input.attributes === "object" ? { ...input.attributes } : {},
    identifiers: asArray(input.identifiers).map((entry) =>
      typeof entry === "string" ? { scheme: "external", value: entry } : { scheme: str(entry.scheme), value: str(entry.value), scope: str(entry.scope) }
    ),
    classification: asArray(input.classification).map((entry) =>
      typeof entry === "string" ? { code: entry } : { scheme: str(entry.scheme), code: str(entry.code), label: str(entry.label) }
    ),
    metadata: input.metadata && typeof input.metadata === "object" ? { ...input.metadata } : {},
    documents: asArray(input.documents).map((entry) => ({
      file_id: entry.file_id ?? null,
      name: str(entry.name),
      mime_type: str(entry.mime_type || entry.mimeType),
      role: str(entry.role),
    })),
    geometry_refs: asArray(input.geometry_refs || input.geometryRefs).map((entry) => ({
      kind: str(entry.kind),
      ref: str(entry.ref),
      format: str(entry.format),
    })),
    external_identifiers: asArray(input.external_identifiers || input.externalIdentifiers).map((entry) =>
      typeof entry === "string" ? { system: "external", value: entry } : { system: str(entry.system), value: str(entry.value) }
    ),
    bom: input.bom && typeof input.bom === "object" ? input.bom : null,
  };
}

export function createCanonicalRelationship(input = {}) {
  return {
    external_id: str(input.external_id || input.externalId || input.id),
    relationship_type: str(input.relationship_type || input.relationshipType || input.type),
    semantic: str(input.semantic),
    source_ref: str(input.source_ref || input.sourceRef || input.source),
    target_ref: str(input.target_ref || input.targetRef || input.target),
    quantity: input.quantity === undefined ? null : input.quantity,
    uom: str(input.uom),
    metadata: input.metadata && typeof input.metadata === "object" ? { ...input.metadata } : {},
  };
}

export function createCanonicalReference(input = {}) {
  return { kind: str(input.kind), value: str(input.value), object_ref: str(input.object_ref || input.objectRef) };
}

// Adds an object while de-duplicating on external_id (first wins) and returning
// the stored object so callers can chain.
export function addObject(document, input) {
  const object = createCanonicalObject(input);
  if (object.external_id && document.objects.some((entry) => entry.external_id === object.external_id)) {
    document.warnings.push({ code: "duplicate_object", message: `Duplicate canonical object external_id: ${object.external_id}` });
    return document.objects.find((entry) => entry.external_id === object.external_id);
  }
  document.objects.push(object);
  return object;
}

export function addRelationship(document, input) {
  const relationship = createCanonicalRelationship(input);
  document.relationships.push(relationship);
  return relationship;
}

// Structural normalization/validation of an adapter-produced document. Returns
// warnings and errors; it never mutates source object types outside the model.
export function normalizeDocument(input, meta = {}) {
  const errors = [];
  const warnings = [];
  const source = input && typeof input === "object" ? input : {};
  const document = emptyDocument({ ...meta, ...(source.source || {}) });
  document.model_version = str(source.model_version || CANONICAL_MODEL_VERSION);
  document.metadata = source.metadata && typeof source.metadata === "object" ? source.metadata : {};
  const seen = new Set();
  for (const raw of asArray(source.objects)) {
    const object = createCanonicalObject(raw);
    if (!object.external_id) {
      errors.push({ code: "missing_external_id", message: "A canonical object is missing external_id", source_path: "objects[].external_id" });
    } else if (seen.has(object.external_id)) {
      warnings.push({ code: "duplicate_object", message: `Duplicate canonical object external_id: ${object.external_id}` });
    } else {
      seen.add(object.external_id);
    }
    document.objects.push(object);
  }
  for (const raw of asArray(source.relationships)) {
    const relationship = createCanonicalRelationship(raw);
    if (!relationship.source_ref || !relationship.target_ref) {
      errors.push({
        code: "incomplete_relationship",
        message: "A canonical relationship requires source_ref and target_ref",
        source_path: "relationships[]",
      });
    }
    document.relationships.push(relationship);
  }
  for (const raw of asArray(source.references)) document.references.push(createCanonicalReference(raw));
  document.warnings = [...document.warnings, ...asArray(source.warnings), ...warnings];
  return { document, errors, warnings };
}

export function documentStats(document) {
  const objects = asArray(document?.objects);
  const relationships = asArray(document?.relationships);
  const byType = {};
  for (const object of objects) byType[object.object_type || "unknown"] = (byType[object.object_type || "unknown"] || 0) + 1;
  return {
    objects: objects.length,
    relationships: relationships.length,
    references: asArray(document?.references).length,
    with_geometry: objects.filter((entry) => (entry.geometry_refs || []).length > 0).length,
    with_documents: objects.filter((entry) => (entry.documents || []).length > 0).length,
    with_bom: objects.filter((entry) => entry.bom).length,
    object_types: byType,
  };
}

// Converts flat parser records into a canonical document. Adapters use this so
// JSON/CSV/EDI share one shape.
export function documentFromRecords(records, { object_type = "part", meta = {} } = {}) {
  const document = emptyDocument(meta);
  for (const record of asArray(records)) {
    const externalId = record.external_id || record.externalId || record.id || record.number || record.code;
    addObject(document, { object_type, external_id: externalId, ...record });
  }
  return document;
}

export function canonicalRefOf(object) {
  return object.object_type ? `${object.object_type}:${object.external_id}` : object.external_id;
}

export { asArray, str };
