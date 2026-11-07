// Standardized Predictive Intelligence error codes.
//
// Codes are stable identifiers clients branch on; the HTTP layer serializes them
// next to `error` and `details` (mirrors manufacturing-quality/errors.js).
import { HttpError } from "../../validation.js";

export const PREDICTIVE_ERROR_CODES = Object.freeze({
  NOT_FOUND: "PREDICTIVE_NOT_FOUND",
  CONFLICT: "PREDICTIVE_CONFLICT",
  INVALID: "PREDICTIVE_INVALID",
  USE_CASE_NOT_FOUND: "PREDICTIVE_USE_CASE_NOT_FOUND",
  USE_CASE_CONFLICT: "PREDICTIVE_USE_CASE_CONFLICT",
  PREDICTION_NOT_FOUND: "PREDICTIVE_PREDICTION_NOT_FOUND",
  PREDICTION_CONFLICT: "PREDICTIVE_PREDICTION_CONFLICT",
  RECOMMENDATION_NOT_FOUND: "PREDICTIVE_RECOMMENDATION_NOT_FOUND",
  RECOMMENDATION_CONFLICT: "PREDICTIVE_RECOMMENDATION_CONFLICT",
  INVALID_TRANSITION: "PREDICTIVE_INVALID_TRANSITION",
  SUBJECT_NOT_FOUND: "PREDICTIVE_SUBJECT_NOT_FOUND",
  INVALID_SUBJECT: "PREDICTIVE_INVALID_SUBJECT",
  INSUFFICIENT_DATA: "PREDICTIVE_INSUFFICIENT_DATA",
  UNSUPPORTED_METHOD: "PREDICTIVE_UNSUPPORTED_METHOD",
  INVALID_CONFIGURATION: "PREDICTIVE_INVALID_CONFIGURATION",
  FORBIDDEN: "PREDICTIVE_FORBIDDEN",
});

export class PredictiveError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export const predictiveNotFound = (ref) =>
  new PredictiveError(404, `Predictive resource not found: ${ref}`, PREDICTIVE_ERROR_CODES.NOT_FOUND, { ref });
export const predictiveConflict = (message, details = null) =>
  new PredictiveError(409, message, PREDICTIVE_ERROR_CODES.CONFLICT, details);
export const invalidPredictive = (message, details = null) =>
  new PredictiveError(400, message, PREDICTIVE_ERROR_CODES.INVALID, details);

export const useCaseNotFound = (ref) =>
  new PredictiveError(404, `Prediction use case not found: ${ref}`, PREDICTIVE_ERROR_CODES.USE_CASE_NOT_FOUND, { ref });
export const useCaseConflict = (details) =>
  new PredictiveError(409, "That prediction use case already exists", PREDICTIVE_ERROR_CODES.USE_CASE_CONFLICT, details);

export const predictionNotFound = (ref) =>
  new PredictiveError(404, `Prediction not found: ${ref}`, PREDICTIVE_ERROR_CODES.PREDICTION_NOT_FOUND, { ref });
export const predictionConflict = (details) =>
  new PredictiveError(409, "That prediction already exists", PREDICTIVE_ERROR_CODES.PREDICTION_CONFLICT, details);

export const recommendationNotFound = (ref) =>
  new PredictiveError(404, `Recommendation not found: ${ref}`, PREDICTIVE_ERROR_CODES.RECOMMENDATION_NOT_FOUND, { ref });
export const recommendationConflict = (details) =>
  new PredictiveError(409, "That recommendation already exists", PREDICTIVE_ERROR_CODES.RECOMMENDATION_CONFLICT, details);

export const invalidTransition = (message, details = null) =>
  new PredictiveError(409, message, PREDICTIVE_ERROR_CODES.INVALID_TRANSITION, details);
export const subjectNotFound = (subjectType, ref) =>
  new PredictiveError(404, `${subjectType} subject not found: ${ref}`, PREDICTIVE_ERROR_CODES.SUBJECT_NOT_FOUND, { subject_type: subjectType, ref });
export const invalidSubject = (message, details = null) =>
  new PredictiveError(400, message, PREDICTIVE_ERROR_CODES.INVALID_SUBJECT, details);
export const insufficientData = (message, details = null) =>
  new PredictiveError(422, message, PREDICTIVE_ERROR_CODES.INSUFFICIENT_DATA, details);
export const unsupportedMethod = (message, details = null) =>
  new PredictiveError(400, message, PREDICTIVE_ERROR_CODES.UNSUPPORTED_METHOD, details);
export const invalidConfiguration = (message, details = null) =>
  new PredictiveError(400, message, PREDICTIVE_ERROR_CODES.INVALID_CONFIGURATION, details);
export const forbidden = (message, details = null) =>
  new PredictiveError(403, message, PREDICTIVE_ERROR_CODES.FORBIDDEN, details);
