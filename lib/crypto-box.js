const crypto = require("node:crypto");

function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret), "utf8").digest();
}

function encryptString(secret, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
}

function decryptString(secret, payload, aad) {
  if (typeof payload !== "string" || !payload.startsWith("v1.")) return null;
  const raw = Buffer.from(payload.slice(3), "base64url");
  if (raw.length < 12 + 16) return null;
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

module.exports = { encryptString, decryptString };
