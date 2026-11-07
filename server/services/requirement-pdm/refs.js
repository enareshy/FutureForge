// Reference helpers for the Requirement -> PDM integration.
//
// Allocation edges reuse the Requirements Manager relationship reference so an
// allocation can be addressed exactly like any other requirement relationship.
// Thread node references reuse the Digital Thread `nodeRef` encoder so forward
// edges resolve through the existing provider registry without translation.
import { nodeRef, parseNodeRef } from "../thread/providers.js";
import { shortId, slug } from "../requirements/refs.js";

export { nodeRef, parseNodeRef };

export function allocationRef(relationshipRef) {
  return relationshipRef || `RPDM-ALLOC-${shortId()}`;
}

export function requirementNodeRef(objectId) {
  return nodeRef("requirement", objectId);
}

export function targetNodeRef(targetType, targetId) {
  return nodeRef(targetType, targetId);
}

export function syncRef() {
  return `RPDM-SYNC-${shortId()}`;
}

export function comparisonRef(code) {
  return `RPDM-CMP-${slug(code) || shortId()}`;
}
