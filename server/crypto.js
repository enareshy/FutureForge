import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

const SCRYPT_KEYLEN = 32;
const ALPH32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  const stored = Buffer.from(hash, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function hmacSha256(key, value) {
  return createHmac("sha256", key).update(String(value)).digest("hex");
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

let warnedInsecureFallback = false;

// HELIX_AUTH_SECRET keys every encrypted secret (integration credentials,
// MFA data). Production must set it (enforced at boot in server/index.js);
// this fallback exists only so local dev/test runs, which never set it,
// keep working without every contributor exporting a throwaway secret.
function dataKey() {
  const material = process.env.HELIX_AUTH_SECRET;
  if (!material) {
    if (!warnedInsecureFallback) {
      warnedInsecureFallback = true;
      console.warn(
        "[helix] HELIX_AUTH_SECRET is not set — using an insecure, publicly-known " +
          "dev fallback key. This is only acceptable for local development/tests. " +
          "Production deployments must set HELIX_AUTH_SECRET (see docs/INTEGRATION_OPERATIONS.md)."
      );
    }
    return scryptSync("helix-local-auth-key", "helix-iam-auth-v1", 32);
  }
  return scryptSync(material, "helix-iam-auth-v1", 32);
}

export function encryptSecret(plain) {
  if (plain === undefined || plain === null || plain === "") return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(payload) {
  if (!payload) return "";
  const buf = Buffer.from(payload, "base64");
  if (buf.length < 29) return "";
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", dataKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function encryptJson(obj) {
  if (!obj || !Object.keys(obj).length) return "";
  return encryptSecret(JSON.stringify(obj));
}

export function decryptJson(payload) {
  if (!payload) return {};
  try {
    const text = decryptSecret(payload);
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPH32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPH32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(str) {
  const clean = String(str || "")
    .toUpperCase()
    .replace(/=+$/g, "")
    .replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    const idx = ALPH32.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret, step = Math.floor(Date.now() / 30000), digits = 6) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  buf.writeUInt32BE(step >>> 0, 4);
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = String(bin % 10 ** digits);
  return otp.padStart(digits, "0");
}

export function verifyTotp(secret, code, window = 1) {
  const expected = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(expected)) return false;
  const now = Math.floor(Date.now() / 30000);
  for (let i = -window; i <= window; i++) {
    if (safeEqual(totpCode(secret, now + i), expected)) return true;
  }
  return false;
}

export function otpauthUri(secret, account, issuer = "Helix IAM") {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${q}`;
}
