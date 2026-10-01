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
  canAccessAsync,
  assertAccess,
  assertAccessAsync,
  effectivePermissions,
  effectivePermissionsAsync,
  grantPermission,
  grantPermissionAsync,
  revokePermission,
  revokePermissionAsync,
  listPermissions,
  listPermissionsAsync,
} from "./files/permissions.js";

export {
  recordFileEvent,
  recordFileEventAsync,
  listFileEvents,
  fileEventSummary,
  fileEventSummaryAsync,
  auditFile,
  auditFileAsync,
} from "./files/events.js";

export {
  listFiles,
  listFilesAsync,
  getFile,
  getFileAsync,
  updateFileMetadata,
  updateFileMetadataAsync,
  deleteFile,
  deleteFileAsync,
  restoreFile,
  restoreFileAsync,
  moveFile,
  moveFileAsync,
  fileFacets,
  fileFacetsAsync,
  generateFileRef,
  generateFileRefAsync,
  SORTABLE_FILES,
} from "./files/files.js";

export {
  listFolders,
  listFoldersAsync,
  folderTree,
  folderTreeAsync,
  getFolder,
  getFolderAsync,
  createFolder,
  createFolderAsync,
  updateFolder,
  updateFolderAsync,
  deleteFolder,
  deleteFolderAsync,
  restoreFolder,
  restoreFolderAsync,
  listFolderFiles,
  listFolderFilesAsync,
  moveFilesToFolder,
  moveFilesToFolderAsync,
  removeFileFromFolder,
  removeFileFromFolderAsync,
  folderBreadcrumb,
  folderBreadcrumbAsync,
} from "./files/folders.js";

export {
  listVersions,
  listVersionsAsync,
  getVersion,
  getVersionAsync,
  createVersion,
  createVersionAsync,
  restoreVersion,
  restoreVersionAsync,
  versionDownload,
  versionDownloadAsync,
} from "./files/versions.js";

export {
  checkOutFile,
  checkOutFileAsync,
  checkInFile,
  checkInFileAsync,
  getLock,
  getLockAsync,
  listLocks,
  listLocksAsync,
  releaseLock,
  releaseLockAsync,
  forceReleaseLock,
  forceReleaseLockAsync,
  releaseExpiredLocks,
} from "./files/locks.js";

export {
  initiateUpload,
  initiateUploadAsync,
  uploadChunk,
  uploadChunkAsync,
  completeUpload,
  completeUploadAsync,
  abortUpload,
  abortUploadAsync,
  getUpload,
  getUploadAsync,
  listUploads,
  listUploadsAsync,
  expireUploads,
  uploadDownloadSession,
  uploadDownloadSessionAsync,
} from "./files/uploads.js";

export {
  listFileAssociations,
  listFileAssociationsAsync,
  listObjectAssociations,
  listObjectAssociationsAsync,
  listAssociations,
  listAssociationsAsync,
  createAssociation,
  createAssociationAsync,
  updateAssociation,
  updateAssociationAsync,
  removeAssociation,
  removeAssociationAsync,
} from "./files/associations.js";

export {
  listCollections,
  listCollectionsAsync,
  getCollection,
  getCollectionAsync,
  createCollection,
  createCollectionAsync,
  updateCollection,
  updateCollectionAsync,
  deleteCollection,
  deleteCollectionAsync,
  addCollectionMembers,
  addCollectionMembersAsync,
  removeCollectionMember,
  removeCollectionMemberAsync,
  listCollectionsForFile,
  listCollectionsForFileAsync,
} from "./files/collections.js";

export {
  getProcessingStatus,
  getProcessingStatusAsync,
  requeueProcessing,
  requeueProcessingAsync,
  processVersion,
  processVersionAsync,
  processFileJob,
  registerFileProcessingHandlers,
  runProcessingPipeline,
  persistProcessingResult,
  persistProcessingResultAsync,
} from "./files/processing.js";

export {
  fileMetrics,
  fileMetricsAsync,
  storageBreakdown,
  storageBreakdownAsync,
  processingSummary,
  processingSummaryAsync,
} from "./files/metrics.js";
