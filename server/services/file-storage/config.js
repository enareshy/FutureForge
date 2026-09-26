import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// Configuration for the File Storage & Processing Services module. Physical
// storage, signed URLs, virus scanning and preview/rendition generation live
// here; the Document & File Management module only ever sees opaque keys.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");

export const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;

// A per-process signing secret keeps signed download URLs unforgeable without
// embedding any secret in source. Deployments should set FILE_SIGNING_SECRET so
// links survive process restarts and worker/serving instances agree.
let ephemeralSecret = null;

export function signingSecret() {
  if (process.env.FILE_SIGNING_SECRET) return process.env.FILE_SIGNING_SECRET;
  if (!ephemeralSecret) ephemeralSecret = randomBytes(32).toString("hex");
  return ephemeralSecret;
}

export function storageConfig(overrides = {}) {
  return {
    provider: overrides.provider || process.env.FILE_STORAGE_PROVIDER || "local",
    root: overrides.root || process.env.FILE_STORAGE_DIR || join(repoRoot, "data", "files"),
    bucket: overrides.bucket || process.env.FILE_STORAGE_BUCKET || "helix-files",
    chunkSize: Number(overrides.chunkSize || process.env.FILE_CHUNK_SIZE || DEFAULT_CHUNK_SIZE),
    maxFileSize: Number(overrides.maxFileSize || process.env.FILE_MAX_SIZE_BYTES || 5 * 1024 * 1024 * 1024),
    signedUrlTtlSeconds: Number(overrides.signedUrlTtlSeconds || process.env.FILE_SIGNED_URL_TTL || 900),
  };
}
