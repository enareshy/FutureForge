import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../../validation.js";
import { signingSecret, storageConfig } from "./config.js";

// Signed, short-lived download tokens. Only the storage service issues or
// verifies them; clients receive a URL, never a physical path or credential.

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadB64) {
  return createHmac("sha256", signingSecret()).update(payloadB64).digest("base64url");
}

export function signDownload({
  key,
  bucket = "",
  filename = "",
  mimeType = "application/octet-stream",
  disposition = "attachment",
  tenantId = null,
  versionId = null,
  expiresIn,
} = {}) {
  if (!key) throw new HttpError(500, "Cannot sign a download without a storage key");
  const ttl = Number(expiresIn || storageConfig().signedUrlTtlSeconds);
  const expiresAt = Date.now() + Math.max(30, ttl) * 1000;
  const payload = {
    k: key,
    b: bucket,
    f: filename,
    m: mimeType,
    d: disposition === "inline" ? "inline" : "attachment",
    t: tenantId === null || tenantId === undefined ? null : Number(tenantId),
    v: versionId ? Number(versionId) : null,
    e: expiresAt,
  };
  const encoded = base64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

export function verifyDownloadToken(token) {
  const raw = String(token || "");
  const [encoded, signature] = raw.split(".");
  if (!encoded || !signature) throw new HttpError(403, "Invalid download token");
  const expected = sign(encoded);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new HttpError(403, "Invalid download token");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(403, "Invalid download token");
  }
  if (!payload?.k || !payload?.e) throw new HttpError(403, "Invalid download token");
  if (Date.now() > Number(payload.e)) throw new HttpError(410, "Download link has expired");
  return payload;
}

export function signedDownloadPath(token) {
  return `/api/files/download/${token}`;
}
