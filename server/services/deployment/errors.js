// Domain errors for the Deployment & Edition framework. Keeping them in one
// place means the router/service layer can throw typed errors that the shared
// error middleware renders consistently (mirrors server/services/change/errors.js).
import { HttpError } from "../../validation.js";

export function invalidProfile(details) {
  return new HttpError(400, "Invalid deployment profile", details);
}

export function invalidFeature(details) {
  return new HttpError(400, "Invalid feature entitlement", details);
}

export function featureNotFound(code) {
  return new HttpError(404, `Unknown feature '${code}'`, { feature: code });
}

export function featureDisabled(code) {
  return new HttpError(403, `Feature '${code}' is not enabled for this deployment`, {
    feature: code,
    reason: "feature_not_entitled",
  });
}
