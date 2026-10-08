"use strict";

const { secp256k1 } = require("@noble/curves/secp256k1.js");
const { bytesToBig, bytesToHex, checksumAddress, hexToBytes } = require("./hex");
const { keccak } = require("./keccak");

const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const ZERO_ADDRESS = "0x" + "0".repeat(40);

function tryRecover(digestHex, signatureHex) {
  let digest;
  let signature;
  try {
    digest = hexToBytes(digestHex);
    signature = hexToBytes(signatureHex);
  } catch {
    return null;
  }
  if (digest.length !== 32 || signature.length !== 65) return null;
  const v = signature[64];
  if (v !== 27 && v !== 28) return null;
  const r = signature.subarray(0, 32);
  const s = signature.subarray(32, 64);
  const rValue = bytesToBig(r);
  const sValue = bytesToBig(s);
  if (rValue === 0n || sValue === 0n || sValue > HALF_ORDER) return null;
  try {
    const packed = new Uint8Array(65);
    packed[0] = v - 27;
    packed.set(r, 1);
    packed.set(s, 33);
    const point = secp256k1.Signature.fromBytes(packed, "recovered").recoverPublicKey(digest);
    const pub = point.toBytes(false);
    if (pub.length !== 65 || pub[0] !== 0x04) return null;
    const hash = keccak(pub.subarray(1));
    const address = checksumAddress(bytesToHex(hash.subarray(12)));
    if (address.toLowerCase() === ZERO_ADDRESS) return null;
    return address;
  } catch {
    return null;
  }
}

module.exports = { tryRecover, HALF_ORDER };
