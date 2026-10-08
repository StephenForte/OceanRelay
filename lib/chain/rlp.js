"use strict";

const { bigToBytes, concat } = require("./hex");

function encode(item) {
  if (item instanceof Uint8Array) return encodeBytes(item);
  if (typeof item === "bigint") return encodeBytes(minimalBig(item));
  if (Array.isArray(item)) return encodeList(item);
  throw new Error("bad_rlp");
}

function minimalBig(value) {
  if (value < 0n) throw new Error("bad_rlp");
  if (value === 0n) return new Uint8Array(0);
  return bigToBytes(value);
}

function encodeBytes(bytes) {
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return prefix(bytes, 0x80);
}

function encodeList(items) {
  return prefix(concat(items.map(encode)), 0xc0);
}

function prefix(payload, offset) {
  if (payload.length < 56) {
    const out = new Uint8Array(1 + payload.length);
    out[0] = offset + payload.length;
    out.set(payload, 1);
    return out;
  }
  const length = minimalBig(BigInt(payload.length));
  const out = new Uint8Array(1 + length.length + payload.length);
  out[0] = offset + 55 + length.length;
  out.set(length, 1);
  out.set(payload, 1 + length.length);
  return out;
}

module.exports = { encode };
