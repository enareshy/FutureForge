// File & Content Management Service (public facade).
//
// A shared platform capability that separates Document Object business metadata
// (owned by business modules such as Document/Part/CAD/BOM/Change/Requirement/
// Workflow Task) from the physical binary content and its processing. Content is
// stored through a provider-independent abstraction, versioned independently of
// business revisions, security-scanned, rendition-processed, retention-managed
// and fully audited. Business modules depend on the flat SDK below rather than
// reading content tables directly.
import * as validation from "./content/validation.js";
import * as errors from "./content/errors.js";
import * as refs from "./content/refs.js";
import * as constants from "./content/constants.js";
import * as storage from "./content/storage.js";
import * as repository from "./content/repository.js";
import * as events from "./content/events.js";
import * as security from "./content/security.js";
import * as versions from "./content/versions.js";
import * as renditions from "./content/renditions.js";
import * as processing from "./content/processing.js";
import * as content from "./content/content.js";
import * as sessions from "./content/sessions.js";
import * as locks from "./content/locks.js";
import * as associations from "./content/associations.js";
import * as retention from "./content/retention.js";
import * as lifecycle from "./content/lifecycle.js";
import * as search from "./content/search.js";
import * as metrics from "./content/metrics.js";
import * as jobs from "./content/jobs.js";
import * as seed from "./content/seed.js";
import * as foundation from "./content/foundation.js";

export * as Validation from "./content/validation.js";
export * as Errors from "./content/errors.js";
export * as Refs from "./content/refs.js";
export * as Constants from "./content/constants.js";
export * as Storage from "./content/storage.js";
export * as Repository from "./content/repository.js";
export * as Events from "./content/events.js";
export * as Security from "./content/security.js";
export * as Versions from "./content/versions.js";
export * as Renditions from "./content/renditions.js";
export * as Processing from "./content/processing.js";
export * as Content from "./content/content.js";
export * as Sessions from "./content/sessions.js";
export * as Locks from "./content/locks.js";
export * as Associations from "./content/associations.js";
export * as Retention from "./content/retention.js";
export * as Lifecycle from "./content/lifecycle.js";
export * as Search from "./content/search.js";
export * as Metrics from "./content/metrics.js";
export * as Jobs from "./content/jobs.js";
export * as Seed from "./content/seed.js";
export * as Foundation from "./content/foundation.js";

export {
  validation,
  errors,
  refs,
  constants,
  storage,
  repository,
  events,
  security,
  versions,
  renditions,
  processing,
  content,
  sessions,
  locks,
  associations,
  retention,
  lifecycle,
  search,
  metrics,
  jobs,
  seed,
  foundation,
};

export { ContentError } from "./content/errors.js";

// Flat, stable SDK for business modules. All operations take the database first
// so they can participate in the caller's transaction when needed.
export const ContentService = {
  create: content.createContent,
  createFromStaging: content.createContentFromStaging,
  get: content.getContent,
  detail: content.contentDetail,
  list: content.listContent,
  updateMetadata: content.updateContentMetadata,
  remove: content.softDeleteContent,
  restore: content.restoreContent,
  downloadInfo: content.downloadInfo,
  resolveDownload: content.resolveDownload,
  facets: content.contentFacets,
  findByReference: versions.contentByReference,
  findDuplicate: content.findDuplicate,

  initiateUpload: sessions.initiateUploadSession,
  appendUploadPart: sessions.appendUploadPart,
  completeUpload: sessions.completeUploadSession,
  abortUpload: sessions.abortUploadSession,

  checkOut: locks.checkOutContent,
  checkIn: locks.checkInContent,
  releaseLock: locks.releaseLock,
  forceReleaseLock: locks.forceReleaseLock,

  createAssociation: associations.createAssociation,
  listAssociations: associations.listAssociations,
  listObjectContent: associations.listObjectContent,
  setPrimaryAssociation: associations.setPrimaryAssociation,
  removeAssociation: associations.removeAssociation,

  listVersions: versions.listVersions,
  getVersion: versions.getVersion,
  restoreVersion: versions.restoreVersion,

  listRenditions: renditions.listRenditions,
  requestRendition: renditions.requestRendition,
  renditionAccessUrl: renditions.renditionAccessUrl,

  process: processing.processContentVersion,
  processingStatus: processing.getProcessingStatus,
  listProcessingJobs: processing.listProcessingJobs,

  transition: lifecycle.transitionContent,
  archive: lifecycle.archiveContent,

  retentionFor: retention.retentionForContent,
  applyLegalHold: retention.applyLegalHold,
  releaseLegalHold: retention.releaseLegalHold,
  canDelete: retention.canDeleteContent,

  metrics: metrics.metricsSnapshot,
  health: foundation.contentHealth,
};

export const {
  CONTENT_ROLES,
  CONTENT_STATUSES,
  SECURITY_STATUSES,
  UPLOAD_STATUSES,
  RENDITION_TYPES,
  CONTENT_EVENT_TYPES,
  RESOURCE_PERMISSION_MAP,
} = constants;

export const createContent = content.createContent;
export const listContent = content.listContent;
export const getContent = content.getContent;
export const contentDetail = content.contentDetail;
export const updateContentMetadata = content.updateContentMetadata;
export const downloadInfo = content.downloadInfo;
export const resolveDownload = content.resolveDownload;
export const contentFacets = content.contentFacets;
export const softDeleteContent = content.softDeleteContent;
export const restoreContent = content.restoreContent;
export const findDuplicate = content.findDuplicate;
export const createContentFromStaging = content.createContentFromStaging;
export const transitionContent = lifecycle.transitionContent;
export const archiveContent = lifecycle.archiveContent;
export const retentionForContent = retention.retentionForContent;
export const applyLegalHold = retention.applyLegalHold;
export const releaseLegalHold = retention.releaseLegalHold;
export const canDeleteContent = retention.canDeleteContent;
export const initiateUploadSession = sessions.initiateUploadSession;
export const appendUploadPart = sessions.appendUploadPart;
export const completeUploadSession = sessions.completeUploadSession;
export const checkOutContent = locks.checkOutContent;
export const checkInContent = locks.checkInContent;
export const createAssociation = associations.createAssociation;
export const listObjectContent = associations.listObjectContent;
export const listVersions = versions.listVersions;
export const listRenditions = renditions.listRenditions;
export const processContentVersion = processing.processContentVersion;
export const healthCheck = foundation.contentHealth;

export const ensureContentFoundation = foundation.ensureContentFoundation;
export const seedContent = seed.seedContent;
export const ensureDefaultRetentionPolicies = seed.ensureDefaultRetentionPolicies;
export const registerContentHandlers = jobs.registerContentHandlers;
export const registerContentProcessingHandlers = processing.registerContentProcessingHandlers;
export const runContentMaintenance = jobs.runContentMaintenance;
export const ensureContentEventTypes = events.ensureContentEventTypes;
export const ensureContentSearchRegistration = search.ensureContentSearchRegistration;
export const registerContentSearchSource = search.registerContentSearchSource;
export const resolveContentStorage = storage.resolveContentStorage;
export const buildContentStorageKey = storage.buildContentStorageKey;
export const registerContentScanner = security.registerContentScanner;
export const registerRenditionProcessor = renditions.registerRenditionProcessor;
