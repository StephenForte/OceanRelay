"use strict";

const { keccak } = require("./keccak");
const { addressToWord, bigToBytes, bytesToHex, concat, hexToBytes, utf8 } = require("./hex");

const DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

const TYPE_STRINGS = Object.freeze({
  Binding: "Binding(bytes32 companyKey,address wallet,uint64 deadline)",
  Publish: "Publish(bytes32 offerId,bytes32 commitment,uint64 expiresAt,uint64 deadline)",
  Version: "Version(bytes32 offerId,uint32 version,bytes32 commitment,uint64 expiresAt,uint64 deadline)",
  OfferState: "OfferState(bytes32 offerId,uint8 state,uint32 seq,uint64 deadline)",
  Request: "Request(bytes32 requestId,bytes32 offerId,uint32 version,uint64 deadline)",
  Acceptance: "Acceptance(bytes32 requestId,uint32 counter,bytes32 termsCommitment,uint64 deadline)",
  Status: "Status(bytes32 requestId,uint8 status,uint32 seq,uint64 deadline)",
  Cancellation: "Cancellation(bytes32 requestId,uint64 deadline)",
});

const FIELDS = Object.freeze(Object.fromEntries(
  Object.entries(TYPE_STRINGS).map(([name, typeString]) => [name, fieldsOf(typeString)])
));

function fieldsOf(typeString) {
  const open = typeString.indexOf("(");
  const body = typeString.slice(open + 1, -1);
  if (!body) return [];
  return body.split(",").map((part) => {
    const space = part.indexOf(" ");
    return [part.slice(0, space), part.slice(space + 1)];
  });
}

function typeHash(name) {
  const typeString = TYPE_STRINGS[name];
  if (!typeString) throw new Error("unknown_type");
  return keccak(utf8(typeString));
}

function encodeValue(type, value) {
  if (type === "address") return addressToWord(value);
  if (type === "bytes32") {
    const bytes = hexToBytes(value);
    if (bytes.length !== 32) throw new Error("bad_bytes32");
    return bytes;
  }
  if (type.startsWith("uint")) return bigToBytes(value, 32);
  throw new Error("bad_type");
}

function structHash(name, message) {
  const fields = FIELDS[name];
  if (!fields) throw new Error("unknown_type");
  const parts = [typeHash(name)];
  for (const [type, field] of fields) {
    if (message == null || message[field] == null) throw new Error("bad_message");
    parts.push(encodeValue(type, message[field]));
  }
  return keccak(concat(parts));
}

function domainSeparator(domain) {
  const hashed = keccak(utf8(DOMAIN_TYPE));
  return keccak(concat([
    hashed,
    keccak(utf8(domain.name)),
    keccak(utf8(domain.version)),
    bigToBytes(domain.chainId, 32),
    addressToWord(domain.verifyingContract),
  ]));
}

function digest(domain, name, message) {
  return keccak(concat([
    Uint8Array.of(0x19, 0x01),
    domainSeparator(domain),
    structHash(name, message),
  ]));
}

function typeHashHex(name) {
  return bytesToHex(typeHash(name));
}

function structHashHex(name, message) {
  return bytesToHex(structHash(name, message));
}

function domainSeparatorHex(domain) {
  return bytesToHex(domainSeparator(domain));
}

function digestHex(domain, name, message) {
  return bytesToHex(digest(domain, name, message));
}

module.exports = {
  DOMAIN_TYPE,
  TYPE_STRINGS,
  typeHashHex,
  structHashHex,
  domainSeparatorHex,
  digestHex,
};
