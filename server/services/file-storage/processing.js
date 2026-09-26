import { MAX_SCAN_BYTES } from "./config.js";
import { resolveScanProvider } from "./scanning.js";
import { resolvePreviewProvider } from "./previews.js";

// Orchestration helpers used by the Document module integration hooks. These
// never persist application tables; they only operate on stored objects and
// return processing results for the caller to record.

export async function runVirusScan(provider, { key, size = 0, mimeType = "", extension = "", scanProvider } = {}) {
  const scanner = resolveScanProvider(scanProvider);
  const buffer = await provider.readBuffer(key, { maxBytes: MAX_SCAN_BYTES });
  const result = await scanner.scan({ buffer, size, mimeType, extension });
  return { ...result, engine: result.engine || scanner.name };
}

export async function runPreview(provider, { mimeType = "", extension = "", name = "", previewProvider } = {}) {
  const generator = resolvePreviewProvider(previewProvider);
  return generator.generate({ mimeType, extension, name, provider });
}

export async function checksumObject(provider, key) {
  return provider.checksum(key);
}

export async function putObject(provider, key, readable) {
  return provider.putStream(key, readable);
}

export async function deleteObject(provider, key) {
  return provider.delete(key);
}
