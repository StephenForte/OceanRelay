"use strict";

const { secp256k1 } = require("@noble/curves/secp256k1.js");
const { bytesToBig, bytesToHex, checksumAddress, concat, hexToBytes } = require("./hex");
const { keccak } = require("./keccak");
const { tryRecover } = require("./recover");
const { encode: rlpEncode } = require("./rlp");

const SIGN_OPTS = Object.freeze({
  prehash: false,
  lowS: true,
  extraEntropy: false,
  format: "recovered",
});

function parsePrivateKey(value) {
  if (typeof value !== "string") throw new Error("invalid_key");
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) throw new Error("invalid_key");
  const bytes = hexToBytes(trimmed);
  try {
    secp256k1.getPublicKey(bytes, false);
  } catch {
    throw new Error("invalid_key");
  }
  return bytes;
}

function addressOf(secret) {
  const pub = secp256k1.getPublicKey(secret, false);
  const hash = keccak(pub.subarray(1));
  return checksumAddress(bytesToHex(hash.subarray(12)));
}

function signDigestBytes(secret, digest) {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error("bad_digest");
  const recovered = secp256k1.sign(digest, secret, SIGN_OPTS);
  if (recovered.length !== 65) throw new Error("signature_not_recoverable");
  const recid = recovered[0];
  if (recid !== 0 && recid !== 1) throw new Error("signature_not_recoverable");
  const out = new Uint8Array(65);
  out.set(recovered.subarray(1, 65), 0);
  out[64] = 27 + recid;
  return out;
}

function signTransactionBytes(secret, tx) {
  const to = hexToBytes(tx.to);
  if (to.length !== 20) throw new Error("bad_address");
  const data = hexToBytes(tx.data || "0x");
  const unsigned = [
    BigInt(tx.chainId),
    BigInt(tx.nonce),
    BigInt(tx.maxPriorityFeePerGas),
    BigInt(tx.maxFeePerGas),
    BigInt(tx.gasLimit),
    to,
    BigInt(tx.value || 0),
    data,
    Array.isArray(tx.accessList) ? tx.accessList : [],
  ];
  const signingHash = keccak(concat([Uint8Array.of(0x02), rlpEncode(unsigned)]));
  const signature = signDigestBytes(secret, signingHash);
  const yParity = BigInt(signature[64] - 27);
  const r = bytesToBig(signature.subarray(0, 32));
  const s = bytesToBig(signature.subarray(32, 64));
  const signed = rlpEncode([...unsigned, yParity, r, s]);
  return bytesToHex(concat([Uint8Array.of(0x02), signed]));
}

function openKey(value) {
  const secret = parsePrivateKey(value);
  const address = addressOf(secret);
  return Object.freeze({
    address,
    signDigest(digestHex) {
      const digest = hexToBytes(digestHex);
      return bytesToHex(signDigestBytes(secret, digest));
    },
    signTransaction(tx) {
      return signTransactionBytes(secret, tx);
    },
  });
}

function recoverDigest(digestHex, signatureHex) {
  return tryRecover(digestHex, signatureHex);
}

module.exports = {
  openKey,
  recoverDigest,
};
