"use strict";

const { keccak_256 } = require("@noble/hashes/sha3.js");

function keccak(bytes) {
  return keccak_256(bytes);
}

function keccakHex(bytes) {
  return "0x" + Buffer.from(keccak(bytes)).toString("hex");
}

module.exports = { keccak, keccakHex };
