// Public facade for the Change Management domain (ECR/ECO/ECN).
//
// Every consumer (API layer, jobs, search, other domains) depends on this
// file rather than the internal layout so the implementation can evolve
// safely. Databases are always passed first so a call can participate in
// the caller's transaction (mirrors server/services/pdm/index.js).
import * as Constants from "./constants.js";
import * as Validation from "./validation.js";
import * as Errors from "./errors.js";
import * as Refs from "./refs.js";
import * as Repository from "./repository.js";
import * as Configuration from "./configuration.js";
import * as Events from "./events.js";
import * as History from "./history.js";
import * as Requests from "./requests.js";
import * as Orders from "./orders.js";
import * as Notices from "./notices.js";
import * as AffectedItems from "./affected-items.js";
import * as Relationships from "./relationships.js";
import * as Foundation from "./foundation.js";
import * as Seed from "./seed.js";

export { Constants, Validation, Errors, Refs, Repository, Configuration, Events, History, Requests, Orders, Notices, AffectedItems, Relationships, Foundation, Seed };

// Flat, stable SDK surface.
export const Change = {
  // Requests (ECR)
  createRequest: Requests.createRequest,
  getRequest: Requests.getRequest,
  listRequests: Requests.listRequests,
  updateRequest: Requests.updateRequest,
  submitRequest: Requests.submitRequest,
  withdrawRequest: Requests.withdrawRequest,
  screenRequest: Requests.screenRequest,
  promoteRequest: Requests.promoteRequest,
  listRequestHistory: Requests.listRequestHistory,
  // Orders (ECO)
  createOrder: Orders.createOrder,
  getOrder: Orders.getOrder,
  listOrders: Orders.listOrders,
  updateOrder: Orders.updateOrder,
  submitOrder: Orders.submitOrder,
  decideOrder: Orders.decideOrder,
  releaseOrder: Orders.releaseOrder,
  cancelOrder: Orders.cancelOrder,
  listOrderHistory: Orders.listOrderHistory,
  // Notices (ECN)
  createNotice: Notices.createNotice,
  getNotice: Notices.getNotice,
  listNotices: Notices.listNotices,
  issueNotice: Notices.issueNotice,
  acknowledgeNotice: Notices.acknowledgeNotice,
  listNoticeHistory: Notices.listNoticeHistory,
  // Affected items & impact
  listAffectedItems: AffectedItems.listAffectedItems,
  addAffectedItem: AffectedItems.addAffectedItem,
  removeAffectedItem: AffectedItems.removeAffectedItem,
  listImpact: AffectedItems.listImpact,
  // Relationships
  createRelationship: Relationships.createRelationship,
  getRelationship: Relationships.getRelationship,
  listRelationships: Relationships.listRelationships,
  deleteRelationship: Relationships.deleteRelationship,
  // Configuration
  getConfig: Configuration.getConfig,
  setConfig: Configuration.setConfig,
  listConfig: Configuration.listConfig,
  // Vocabulary
  vocabulary: Validation.vocabulary,
};

export const ensureChangeFoundation = Foundation.ensureChangeFoundation;
export const changeHealth = Foundation.changeHealth;
export const seedChange = Seed.seedChange;
