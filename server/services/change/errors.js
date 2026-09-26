// Standardized Change Management domain error codes.
//
// The HTTP layer serializes `code` alongside `error` and `details` so clients
// branch on stable identifiers rather than parsing prose.
import { HttpError } from "../../validation.js";

export const CHANGE_ERROR_CODES = Object.freeze({
  REQUEST_NOT_FOUND: "CHANGE_REQUEST_NOT_FOUND",
  REQUEST_CONFLICT: "CHANGE_REQUEST_CONFLICT",
  INVALID_REQUEST: "CHANGE_INVALID_REQUEST",
  REQUEST_STATUS_INVALID: "CHANGE_REQUEST_STATUS_INVALID",
  REQUEST_IMMUTABLE: "CHANGE_REQUEST_IMMUTABLE",
  ORDER_NOT_FOUND: "CHANGE_ORDER_NOT_FOUND",
  ORDER_CONFLICT: "CHANGE_ORDER_CONFLICT",
  INVALID_ORDER: "CHANGE_INVALID_ORDER",
  ORDER_STATUS_INVALID: "CHANGE_ORDER_STATUS_INVALID",
  ORDER_IMMUTABLE: "CHANGE_ORDER_IMMUTABLE",
  NO_AFFECTED_ITEMS: "CHANGE_NO_AFFECTED_ITEMS",
  NOTICE_NOT_FOUND: "CHANGE_NOTICE_NOT_FOUND",
  NOTICE_CONFLICT: "CHANGE_NOTICE_CONFLICT",
  INVALID_NOTICE: "CHANGE_INVALID_NOTICE",
  NOTICE_STATUS_INVALID: "CHANGE_NOTICE_STATUS_INVALID",
  AFFECTED_ITEM_NOT_FOUND: "CHANGE_AFFECTED_ITEM_NOT_FOUND",
  AFFECTED_ITEM_CONFLICT: "CHANGE_AFFECTED_ITEM_CONFLICT",
  INVALID_AFFECTED_ITEM: "CHANGE_INVALID_AFFECTED_ITEM",
  RELATIONSHIP_NOT_FOUND: "CHANGE_RELATIONSHIP_NOT_FOUND",
  INVALID_RELATIONSHIP: "CHANGE_INVALID_RELATIONSHIP",
  INVALID_CONFIGURATION: "CHANGE_INVALID_CONFIGURATION",
  CONFLICT: "CHANGE_CONFLICT",
});

export class ChangeError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

// Request (ECR)
export const requestNotFound = (ref) =>
  new ChangeError(404, `Change request not found: ${ref}`, CHANGE_ERROR_CODES.REQUEST_NOT_FOUND, { ref });
export const requestConflict = (number) =>
  new ChangeError(409, `Change request already exists: ${number}`, CHANGE_ERROR_CODES.REQUEST_CONFLICT, { request_number: number });
export const invalidRequest = (message, details = null) =>
  new ChangeError(400, message, CHANGE_ERROR_CODES.INVALID_REQUEST, details);
export const requestStatusInvalid = (status, from, allowed) =>
  new ChangeError(409, `Cannot change request status from ${from} to ${status}`, CHANGE_ERROR_CODES.REQUEST_STATUS_INVALID, { status, from, allowed });
export const requestImmutable = (ref, status) =>
  new ChangeError(409, `Change request ${ref} is ${status} and cannot be edited`, CHANGE_ERROR_CODES.REQUEST_IMMUTABLE, { ref, status });

// Order (ECO)
export const orderNotFound = (ref) =>
  new ChangeError(404, `Change order not found: ${ref}`, CHANGE_ERROR_CODES.ORDER_NOT_FOUND, { ref });
export const orderConflict = (number) =>
  new ChangeError(409, `Change order already exists: ${number}`, CHANGE_ERROR_CODES.ORDER_CONFLICT, { order_number: number });
export const invalidOrder = (message, details = null) =>
  new ChangeError(400, message, CHANGE_ERROR_CODES.INVALID_ORDER, details);
export const orderStatusInvalid = (status, from, allowed) =>
  new ChangeError(409, `Cannot change order status from ${from} to ${status}`, CHANGE_ERROR_CODES.ORDER_STATUS_INVALID, { status, from, allowed });
export const orderImmutable = (ref, status) =>
  new ChangeError(409, `Change order ${ref} is ${status} and cannot be edited`, CHANGE_ERROR_CODES.ORDER_IMMUTABLE, { ref, status });
export const noAffectedItems = (ref) =>
  new ChangeError(409, `Change order ${ref} has no affected items to release`, CHANGE_ERROR_CODES.NO_AFFECTED_ITEMS, { ref });

// Notice (ECN)
export const noticeNotFound = (ref) =>
  new ChangeError(404, `Change notice not found: ${ref}`, CHANGE_ERROR_CODES.NOTICE_NOT_FOUND, { ref });
export const noticeConflict = (number) =>
  new ChangeError(409, `Change notice already exists: ${number}`, CHANGE_ERROR_CODES.NOTICE_CONFLICT, { notice_number: number });
export const invalidNotice = (message, details = null) =>
  new ChangeError(400, message, CHANGE_ERROR_CODES.INVALID_NOTICE, details);
export const noticeStatusInvalid = (status, from, allowed) =>
  new ChangeError(409, `Cannot change notice status from ${from} to ${status}`, CHANGE_ERROR_CODES.NOTICE_STATUS_INVALID, { status, from, allowed });

// Affected items
export const affectedItemNotFound = (ref) =>
  new ChangeError(404, `Affected item not found: ${ref}`, CHANGE_ERROR_CODES.AFFECTED_ITEM_NOT_FOUND, { ref });
export const affectedItemConflict = (details) =>
  new ChangeError(409, "This object is already an affected item on this change order", CHANGE_ERROR_CODES.AFFECTED_ITEM_CONFLICT, details);
export const invalidAffectedItem = (message, details = null) =>
  new ChangeError(400, message, CHANGE_ERROR_CODES.INVALID_AFFECTED_ITEM, details);

// Relationships
export const relationshipNotFound = (ref) =>
  new ChangeError(404, `Change relationship not found: ${ref}`, CHANGE_ERROR_CODES.RELATIONSHIP_NOT_FOUND, { ref });
export const invalidRelationship = (message, details = null) =>
  new ChangeError(400, message, CHANGE_ERROR_CODES.INVALID_RELATIONSHIP, details);

// Cross-cutting
export const invalidConfiguration = (message, details = null) =>
  new ChangeError(400, message, CHANGE_ERROR_CODES.INVALID_CONFIGURATION, details);
export const changeConflict = (message, details = null) =>
  new ChangeError(409, message, CHANGE_ERROR_CODES.CONFLICT, details);
