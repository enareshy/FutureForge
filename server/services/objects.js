// Public facade for the Object & Relationship Framework. Business modules
// depend on this file (or the platform.js re-exports) rather than the internal
// service layout, so implementation details can evolve safely.

export {
  OBJECT_STATUSES,
  RELATIONSHIP_STATUSES,
  EDGE_STATUSES,
  CARDINALITIES,
  SEMANTICS,
  REFERENCE_TYPES,
  EDGE_DATA_TYPES,
  normalizeEdgeDefinitions,
  validateEdgeValues,
  assertValidEdgeValues,
  normalizeTags,
} from "./objects/validation.js";

export { publicObject, briefObject } from "./objects/repository.js";

export {
  createObject,
  getObject,
  listObjects,
  updateObject,
  setObjectStatus,
  softDeleteObject,
  restoreObject,
  objectTypes,
  objectSummary,
  listObjectVersions,
  getObjectVersion,
  recordObjectVersion,
  checkoutObject,
  checkinObject,
  objectLocks,
  bulkCreateObjects,
  bulkMutateObjects,
} from "./objects/objects.js";

export {
  RELATIONSHIP_TYPE_STATUSES,
  listRelationshipTypes,
  getRelationshipType,
  findRelationshipType,
  createRelationshipType,
  updateRelationshipType,
  setRelationshipTypeStatus,
  deleteRelationshipType,
} from "./objects/relationship-types.js";

export {
  MAX_TRAVERSAL_DEPTH,
  listRelationships,
  getRelationship,
  createRelationship,
  validateRelationship,
  updateRelationship,
  deleteRelationship,
  relationshipsForObject,
  traverse,
  graph,
} from "./objects/relationships.js";

export {
  listReferences,
  getReference,
  createReference,
  updateReference,
  deleteReference,
  orphanReferences,
  directDependencies,
  impactOf,
  detectCycles,
  safeDeleteReport,
} from "./objects/references.js";
