// Data Catalog integration (spec §55). A definition's `catalog_refs` block names
// the data domain, catalog object, business terms, source and consumer involved
// in the movement. The framework stores only the references; this module resolves
// them against the shared Data Catalog so the UI can explain what moves and why.
import { DataCatalog } from "../data-catalog/index.js";
import { DataGovernance } from "../data-governance/index.js";
import * as CatalogObjects from "../data-catalog/objects.js";
import * as CatalogSources from "../data-catalog/sources.js";
import * as CatalogConsumers from "../data-catalog/consumers.js";
import * as CatalogGlossary from "../data-catalog/glossary.js";
import * as CatalogEntries from "../data-catalog/entries.js";

function safely(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

async function safelyAsync(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function resolveCatalogRefs(db, tenantId, refs = {}) {
  const source = refs || {};
  const objectRef = source.object || source.catalog_object || source.data_object || null;
  const domainId = source.domain_id ?? source.data_domain_id ?? null;
  const terms = [...asArray(source.business_terms), ...asArray(source.terms)];
  const attributes = asArray(source.attributes);

  const object = objectRef
    ? safely(() => DataCatalog.getObject(db, objectRef, { tenantId }))
    : null;
  const domain = domainId
    ? safely(() => DataGovernance.getDomain(db, tenantId, domainId))
    : null;
  const sourceSystem = source.source
    ? safely(() => DataCatalog.getSource(db, source.source, { tenantId }))
    : null;
  const consumer = source.consumer
    ? safely(() => DataCatalog.getConsumer(db, source.consumer, { tenantId }))
    : null;

  return {
    domain_id: domainId,
    domain,
    object_ref: objectRef,
    object,
    attributes,
    business_terms: terms.map((term) => safely(() => DataCatalog.getTerm(db, term, { tenantId })) || { ref: term, unresolved: true }),
    source: sourceSystem,
    consumer,
    classification: source.classification || object?.classification || null,
    consumers: asArray(source.consumers),
  };
}

// Register the catalog object that mirrors a movement's target so the catalog
// can describe the destination of an import. Idempotent by ref.
export function ensureCatalogObjectForDefinition(db, tenantId, { ref, code, name, objectType, attributes = [], actor = null, ip = null } = {}) {
  if (!code || !objectType) return null;
  const existing = safely(() => DataCatalog.getObject(db, ref || code, { tenantId }));
  if (existing) return existing;
  return safely(() =>
    DataCatalog.registerEntry
      ? DataCatalog.registerEntry(db, tenantId, { ref: ref || code, code, name: name || code, object_type: objectType, attributes }, actor, ip)
      : null
  );
}

export async function resolveCatalogRefsAsync(db, tenantId, refs = {}) {
  const source = refs || {};
  const objectRef = source.object || source.catalog_object || source.data_object || null;
  const domainId = source.domain_id ?? source.data_domain_id ?? null;
  const terms = [...asArray(source.business_terms), ...asArray(source.terms)];
  const attributes = asArray(source.attributes);

  const object = objectRef ? await safelyAsync(() => CatalogObjects.getObjectAsync(db, objectRef, { tenantId })) : null;
  const domain = domainId ? await safelyAsync(() => DataGovernance.getDomain(db, tenantId, domainId)) : null;
  const sourceSystem = source.source ? await safelyAsync(() => CatalogSources.getSourceAsync(db, source.source, { tenantId })) : null;
  const consumer = source.consumer ? await safelyAsync(() => CatalogConsumers.getConsumerAsync(db, source.consumer, { tenantId })) : null;

  const resolvedTerms = [];
  for (const term of terms) {
    resolvedTerms.push((await safelyAsync(() => CatalogGlossary.getTermAsync(db, term, { tenantId }))) || { ref: term, unresolved: true });
  }

  return {
    domain_id: domainId,
    domain,
    object_ref: objectRef,
    object,
    attributes,
    business_terms: resolvedTerms,
    source: sourceSystem,
    consumer,
    classification: source.classification || object?.classification || null,
    consumers: asArray(source.consumers),
  };
}

export async function ensureCatalogObjectForDefinitionAsync(db, tenantId, { ref, code, name, objectType, attributes = [], actor = null, ip = null } = {}) {
  if (!code || !objectType) return null;
  const existing = await safelyAsync(() => CatalogObjects.getObjectAsync(db, ref || code, { tenantId }));
  if (existing) return existing;
  return await safelyAsync(() =>
    CatalogEntries.registerEntryAsync
      ? CatalogEntries.registerEntryAsync(db, tenantId, { ref: ref || code, code, name: name || code, object_type: objectType, attributes }, actor, ip)
      : null
  );
}
