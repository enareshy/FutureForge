// File Storage & Processing Services module (public facade).
//
// Owns everything physical: object storage providers, opaque storage keys,
// signed temporary download URLs, checksum computation, virus scanning and
// preview/rendition generation. The Document & File Management module depends
// only on this facade and never sees paths, buckets or credentials. Business
// modules must not call storage providers directly.

export {
  DEFAULT_CHUNK_SIZE,
  MAX_SCAN_BYTES,
  storageConfig,
  signingSecret,
} from "./file-storage/config.js";

export {
  assertStorageKey,
  buildObjectKey,
  buildStagingKey,
  buildPreviewKey,
  LocalStorageProvider,
  MemoryStorageProvider,
  createStorageProvider,
  getStorageProvider,
  resetStorageProviders,
} from "./file-storage/provider.js";

export {
  signDownload,
  verifyDownloadToken,
  signedDownloadPath,
} from "./file-storage/signing.js";

export {
  SCAN_STATUSES,
  HeuristicScanProvider,
  NoopScanProvider,
  registerScanProvider,
  resolveScanProvider,
  scanProviderNames,
} from "./file-storage/scanning.js";

export {
  MetadataPreviewProvider,
  NoopPreviewProvider,
  registerPreviewProvider,
  resolvePreviewProvider,
  previewProviderNames,
} from "./file-storage/previews.js";

export {
  runVirusScan,
  runPreview,
  checksumObject,
  putObject,
  deleteObject,
} from "./file-storage/processing.js";
