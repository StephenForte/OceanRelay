"use strict";

const { keccak_256 } = require("@noble/hashes/sha3.js");

// A generic EIP-712 encoder. It hashes whatever `types` array it is given.
// It does not know the Binding type string, and it does not use lib/chain/eip712.js.

function keccak(bytes) {
  return Buffer.from(keccak_256(bytes));
}

function concat(parts) {
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

function hexToBuf(value, size) {
  const hex = String(value).replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]*$/.test(hex) || hex.length !== size * 2) {
    throw new Error("bad hex");
  }
  return Buffer.from(hex, "hex");
}

function encodeUint(value) {
  const n = BigInt(value);
  if (n < 0n) throw new Error("bad uint");
  return Buffer.from(n.toString(16).padStart(64, "0"), "hex");
}

function encodeAtomic(type, value) {
  if (type === "string") return keccak(Buffer.from(String(value), "utf8"));
  if (type === "address") return concat([Buffer.alloc(12), hexToBuf(value, 20)]);
  if (type === "bytes32") return hexToBuf(value, 32);
  if (/^uint\d+$/.test(type)) return encodeUint(value);
  throw new Error(`unsupported ${type}`);
}

function encodeType(primaryType, types) {
  const deps = [];
  const seen = new Set();
  function collect(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const fields = types[name];
    if (!Array.isArray(fields)) throw new Error(`missing ${name}`);
    for (const field of fields) {
      const inner = String(field.type).replace(/\[(\d+)?\]/g, "");
      if (types[inner]) collect(inner);
    }
    if (name !== primaryType) deps.push(name);
  }
  collect(primaryType);
  deps.sort();
  return [primaryType, ...deps].map((name) => {
    const body = types[name].map((field) => `${field.type} ${field.name}`).join(",");
    return `${name}(${body})`;
  }).join("");
}

function hashStruct(primaryType, data, types) {
  const parts = [keccak(Buffer.from(encodeType(primaryType, types), "utf8"))];
  for (const field of types[primaryType]) {
    const value = data == null ? undefined : data[field.name];
    if (value == null) throw new Error(`missing ${field.name}`);
    if (types[field.type]) parts.push(hashStruct(field.type, value, types));
    else parts.push(encodeAtomic(field.type, value));
  }
  return keccak(concat(parts));
}

function digestHex(typedData) {
  const types = typedData.types;
  const domainSeparator = hashStruct("EIP712Domain", typedData.domain, types);
  const struct = hashStruct(typedData.primaryType, typedData.message, types);
  return `0x${keccak(concat([Buffer.from([0x19, 0x01]), domainSeparator, struct])).toString("hex")}`;
}

module.exports = { encodeType, digestHex };
