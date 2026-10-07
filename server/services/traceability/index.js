// Public facade for the Generic Traceability Engine.
//
// Consumers depend on this file rather than the internal layout. The engine is
// a composition layer over the Object & Relationship Framework and the Digital
// Thread: it owns no tables, no event bus, no audit store and no authorization
// system of its own.
import * as Constants from "./constants.js";
import * as Errors from "./errors.js";
import * as Links from "./links.js";
import * as Service from "./service.js";

export { Constants, Errors, Links, Service };

// Flat, stable SDK surface. Async twins are the primary API (the route layer is
// fully asynchronous); sync twins remain for the CLI, seeders and tests.
export const Traceability = {
  // Trace links (delegated to Object & Relationship)
  createLink: Links.createLinkAsync,
  getLink: Links.getLinkAsync,
  updateLink: Links.updateLinkAsync,
  deleteLink: Links.deleteLinkAsync,
  listLinks: Links.listLinksAsync,
  linksForObject: Links.linksForObjectAsync,
  // Traversal
  forward: Service.forwardAsync,
  backward: Service.backwardAsync,
  children: Service.childrenAsync,
  parents: Service.parentsAsync,
  graph: Service.graphAsync,
  findPaths: Service.findPathsAsync,
  impactAnalysis: Service.impactAsync,
  matrix: Service.matrixAsync,
  // Analysis read models
  coverage: Service.coverageAsync,
  orphans: Service.orphansAsync,
  brokenLinks: Service.brokenLinksAsync,
  health: Service.healthAsync,
  // Configuration (reused from Digital Thread)
  listConfig: Service.listConfigAsync,
  setConfig: Service.setConfigAsync,
};

export const SOURCE_MODULE = Constants.SOURCE_MODULE;
export const TRACEABILITY_RESOURCES = Constants.TRACEABILITY_RESOURCES;
export const BROKEN_LINK_REASONS = Constants.BROKEN_LINK_REASONS;
