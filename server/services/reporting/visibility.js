// Visibility & share enforcement (§16, §17).
//
// Saved reports and dashboards have a visibility scope; the platform decides
// who may see them from centralized identity and organization data. Reporting
// duplicates no role management: it reads group/role membership.
import { queryAll } from "../../db.js";

export function loadSubjectProfile(db, actor) {
  if (!actor?.id) return { userId: null, organizationId: null, organizationIds: new Set(), groupIds: new Set(), roleIds: new Set() };
  const groupIds = new Set(queryAll(db, "SELECT group_id FROM group_members WHERE user_id = ?", [Number(actor.id)]).map((row) => Number(row.group_id)));
  const roleIds = new Set(queryAll(db, "SELECT role_id FROM user_roles WHERE user_id = ?", [Number(actor.id)]).map((row) => Number(row.role_id)));
  const organizationIds = new Set();
  if (actor.organization_id) organizationIds.add(Number(actor.organization_id));
  return {
    userId: Number(actor.id),
    organizationId: actor.organization_id ? Number(actor.organization_id) : null,
    organizationIds,
    groupIds,
    roleIds,
  };
}

export function subjectMatches(profile, subjectType, subjectId) {
  const type = String(subjectType || "").toUpperCase();
  const id = subjectId === null || subjectId === undefined ? null : Number(subjectId);
  switch (type) {
    case "ALL":
    case "GLOBAL":
      return true;
    case "USER":
      return profile.userId !== null && profile.userId === id;
    case "GROUP":
      return profile.groupIds.has(id);
    case "ROLE":
      return profile.roleIds.has(id);
    case "ORGANIZATION":
    case "PLANT":
    case "SITE":
      return profile.organizationIds.has(id);
    default:
      return false;
  }
}

// Returns true when `actor` may discover a report/dashboard with the given
// visibility. Deny-by-default: unknown scopes are not visible.
export function canAccess(db, actor, { ownerUserId = null, visibility = "PRIVATE", subjectType = null, subjectId = null, shares = [] } = {}) {
  const scope = String(visibility || "PRIVATE").toUpperCase();
  if (scope === "GLOBAL") return true;
  const profile = loadSubjectProfile(db, actor);
  if (scope === "PRIVATE") return ownerUserId !== null && profile.userId === ownerUserId;
  if (scope === "ORGANIZATION") return ownerUserId === profile.userId || (subjectId !== null && profile.organizationIds.has(Number(subjectId)));
  if (scope === "PLANT" || scope === "SITE" || scope === "GROUP" || scope === "ROLE") {
    if (ownerUserId !== null && profile.userId === ownerUserId) return true;
    if (subjectMatches(profile, scope, subjectId)) return true;
    return (shares || []).some((share) => subjectMatches(profile, share.subject_type, share.subject_id));
  }
  return (shares || []).some((share) => subjectMatches(profile, share.subject_type, share.subject_id));
}

export function visibilityClause(visibility) {
  const allowed = ["PRIVATE", "GROUP", "ROLE", "ORGANIZATION", "PLANT", "SITE", "GLOBAL"];
  const next = String(visibility || "").toUpperCase();
  if (!allowed.includes(next)) return null;
  return next;
}
