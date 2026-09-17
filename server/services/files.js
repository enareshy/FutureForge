// Document & File Management module (public facade).
//
// Business-facing file management: metadata, folders, immutable versions,
// check-in/check-out locking, associations, collections, search, access control,
// processing-status visibility and audit. Physical bytes, malware scanning and
// preview/rendition generation are owned by the File Storage & Processing
// Services module (`server/services/file-storage.js`); this module only ever
// stores opaque storage references.

export {
  FILE_STATUSES,
  FILE_STATUS_LABELS,
  DOWNLOADABLE_STATUSES,
  VERSION_STATUSES,
  UPLOAD_STATUSES,
  UPLOAD_MODES,
  VIRUS_SCAN_STATUSES,
  PREVIEW_STATUSES,
  RENDITION_STATUSES,
  SECURITY_CLASSIFICATIONS,
  FILE_CATEGORIES,
  PROCESSING_TYPES,
  PROCESSING_STATUSES,
  PRINCIPAL_TYPES,
  PERMISSION_EFFECTS,
  ASSOCIATION_RELATIONSHIP_TYPES,
  FILE_PERMISSIONS,
  FILE_EVENT_TYPES,
  validateUploadInput,
  sanitizeFilename,
  mimeFor,
  extensionOf,
  categoryForMime,
  isDangerousExtension,
  vocabulary,
} from "./files/validation.js";

export {
  publicFile,
  publicFolder,
  publicVersion,
  publicLock,
  publicUpload,
  publicAssociation,
  publicCollection,
  publicPermission,
  publicProcessing,
  publicEvent,
} from "./files/repository.js";

export {
  RESOURCE_PERMISSION_MAP,
  canAccess,
  assertAccess,
  effectivePermissions,
  grantPermission,
  revokePermission,
  listPermissions,
} from "./files/permissions.js";

export {
  recordFileEvent,
  listFileEvents,
  fileEventSummary,
  auditFile,
} from "./files/events.js";

export {
  listFiles,
  getFile,
  updateFileMetadata,
  deleteFile,
  restoreFile,
  moveFile,
  fileFacets,
  generateFileRef,
  SORTABLE_FILES,
} from "./files/files.js";

export {
  listFolders,
  folderTree,
  getFolder,
  createFolder,
  updateFolder,
  deleteFolder,
  restoreFolder,
  listFolderFiles,
  moveFilesToFolder,
  removeFileFromFolder,
  folderBreadcrumb,
} from "./files/folders.js";

export {
  listVersions,
  getVersion,
  createVersion,
  restoreVersion,
  versionDownload,
} from "./files/versions.js";

export {
  checkOutFile,
  checkInFile,
  getLock,
  listLocks,
  releaseLock,
  forceReleaseLock,
  releaseExpiredLocks,
} from "./files/locks.js";

export {
  initiateUpload,
  uploadChunk,
  completeUpload,
  abortUpload,
  getUpload,
  listUploads,
  expireUploads,
  uploadDownloadSession,
} from "./files/uploads.js";

export {
  listFileAssociations,
  listObjectAssociations,
  listAssociations,
  createAssociation,
  updateAssociation,
  removeAssociation,
} from "./files/associations.js";

export {
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  addCollectionMembers,
  removeCollectionMember,
  listCollectionsForFile,
} from "./files/collections.js";

export {
  getProcessingStatus,
  requeueProcessing,
  processVersion,
  processFileJob,
  registerFileProcessingHandlers,
  runProcessingPipeline,
  persistProcessingResult,
} from "./files/processing.js";

export {
  fileMetrics,
  storageBreakdown,
  processingSummary,
} from "./files/metrics.js";
