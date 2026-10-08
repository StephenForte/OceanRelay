"use strict";

const { keccak } = require("./keccak");

function strip0x(value) {
  if (typeof value !== "string") return null;
  return value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
}

function isHex(value) {
  const raw = strip0x(value);
  return raw != null && raw.length % 2 === 0 && /^[0-9a-f]*$/i.test(raw);
}

function hexToBytes(value) {
  const raw = strip0x(value);
  if (raw == null || raw.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(raw)) {
    throw new Error("bad_hex");
  }
  return Uint8Array.from(Buffer.from(raw, "hex"));
}

function bytesToHex(bytes) {
  return "0x" + Buffer.from(bytes).toString("hex");
}

function bytesToBig(bytes) {
  if (bytes.length === 0) return 0n;
  return BigInt(bytesToHex(bytes));
}

function bigToBytes(value, length) {
  const n = BigInt(value);
  if (n < 0n) throw new Error("bad_uint");
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  if (length != null) {
    if (hex.length > length * 2) throw new Error("bad_uint");
    hex = hex.padStart(length * 2, "0");
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function concat(parts) {
  let len = 0;
  for (const part of parts) len += part.length;
  const out = new Uint8Array(len);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function sameHex(left, right) {
  const a = strip0x(left);
  const b = strip0x(right);
  if (a == null || b == null) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function checksumAddress(address) {
  const raw = strip0x(address);
  if (raw == null || !/^[0-9a-f]{40}$/i.test(raw)) throw new Error("bad_address");
  const lower = raw.toLowerCase();
  const hash = Buffer.from(keccak(utf8(lower))).toString("hex");
  let out = "0x";
  for (let i = 0; i < 40; i += 1) {
    out += Number.parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

function sameAddress(left, right) {
  try {
    return checksumAddress(left).toLowerCase() === checksumAddress(right).toLowerCase();
  } catch {
    return false;
  }
}

function addressToWord(address) {
  const bytes = hexToBytes(address);
  if (bytes.length !== 20) throw new Error("bad_address");
  const word = new Uint8Array(32);
  word.set(bytes, 12);
  return word;
}

function wordToAddress(word) {
  if (word.length !== 32) throw new Error("bad_address");
  return checksumAddress(bytesToHex(word.subarray(12)));
}

module.exports = {
  strip0x,
  isHex,
  hexToBytes,
  bytesToHex,
  bytesToBig,
  bigToBytes,
  concat,
  utf8,
  sameHex,
  checksumAddress,
  sameAddress,
  addressToWord,
  wordToAddress,
};
