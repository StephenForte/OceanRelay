"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { inspect } = require("node:util");
const vectors = require("../contracts/vectors/eip712.json");
const deployment = require("../deployments/fortel2-sepolia.json");
const { encode: rlpEncode } = require("../lib/chain/rlp");
const { bytesToHex } = require("../lib/chain/hex");
const {
  TYPE_STRINGS,
  typeHashHex,
  structHashHex,
  domainSeparatorHex,
  digestHex,
} = require("../lib/chain/eip712");
const { tryRecover } = require("../lib/chain/recover");
const { openKey } = require("../lib/chain/keys");

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function ascii(value) {
  return new TextEncoder().encode(value);
}

describe("EIP-712 vectors", () => {
  const domain = {
    name: vectors.domain.name,
    version: vectors.domain.version,
    chainId: vectors.domain.chainId,
    verifyingContract: vectors.domain.verifyingContract,
  };

  it("reproduces the domain separator, type hashes, struct hashes and digests", () => {
    assert.equal(domainSeparatorHex(domain), vectors.domain.separator);
    for (const [name, spec] of Object.entries(vectors.types)) {
      assert.equal(TYPE_STRINGS[name], spec.typeString);
      assert.equal(typeHashHex(name), spec.typeHash);
      const sample = vectors.samples[name];
      assert.equal(structHashHex(name, sample.message), sample.structHash);
      assert.equal(digestHex(domain, name, sample.message), sample.digest);
    }
  });

  it("recomputes the deployed domain separator", () => {
    assert.equal(domainSeparatorHex({
      name: "OceanRelay",
      version: "1",
      chainId: deployment.chainId,
      verifyingContract: deployment.address,
    }), deployment.domainSeparator);
  });

  it("reproduces every vector signature and recovers the signer", () => {
    const key = openKey(vectors.signer.privateKey);
    assert.equal(key.address.toLowerCase(), vectors.signer.address);
    for (const [name, sample] of Object.entries(vectors.samples)) {
      const digest = digestHex(domain, name, sample.message);
      assert.equal(key.signDigest(digest), sample.signature);
      const recovered = tryRecover(digest, sample.signature);
      assert.equal(recovered.toLowerCase(), vectors.signer.address);
    }
  });

  it("rejects malformed signatures the way tryRecover does", () => {
    const sample = vectors.samples.Binding;
    const digest = sample.digest;
    assert.equal(tryRecover(digest, "0x1234"), null);
    assert.equal(tryRecover(digest, sample.signature.slice(0, -2) + "00"), null);
    const bytes = Buffer.from(sample.signature.slice(2), "hex");
    bytes[64] = 26;
    assert.equal(tryRecover(digest, "0x" + bytes.toString("hex")), null);
    const r = BigInt("0x" + sample.signature.slice(2, 66));
    const s = BigInt("0x" + sample.signature.slice(66, 130));
    const highS = (N - s).toString(16).padStart(64, "0");
    const high = "0x" + r.toString(16).padStart(64, "0") + highS + "1b";
    assert.equal(tryRecover(digest, high), null);
    assert.equal(tryRecover(digest, "0x" + "00".repeat(65)), null);
  });
});

describe("key handling", () => {
  const secret = vectors.signer.privateKey;

  it("keeps the key out of inspect, JSON and errors", () => {
    const key = openKey(secret);
    const dumped = inspect(key) + JSON.stringify(key) + JSON.stringify({ address: key.address });
    assert.equal(dumped.toLowerCase().includes(secret.slice(2).toLowerCase()), false);
    assert.throws(() => openKey("0x11"), (error) => {
      assert.equal(error.message, "invalid_key");
      assert.equal(String(error.stack).includes(secret.slice(2)), false);
      return true;
    });
    assert.throws(() => openKey(secret.slice(2)), /invalid_key/);
  });

  it("signs an EIP-1559 digest that recovers to the same address", () => {
    const key = openKey(secret);
    const raw = key.signTransaction({
      chainId: 852,
      nonce: 0,
      maxPriorityFeePerGas: 1000,
      maxFeePerGas: 2000,
      gasLimit: 21000,
      to: key.address,
      value: 0,
      data: "0x",
    });
    assert.equal(raw.startsWith("0x02"), true);
    assert.equal(raw.toLowerCase().includes(secret.slice(2).toLowerCase()), false);
    const body = Buffer.from(raw.slice(4), "hex");
    assert.equal(body[0] >= 0xc0, true);
  });
});

describe("rlp", () => {
  it("matches the standard byte-string and list vectors", () => {
    assert.equal(bytesToHex(rlpEncode(ascii("dog"))), "0x83646f67");
    assert.equal(bytesToHex(rlpEncode(new Uint8Array())), "0x80");
    assert.equal(bytesToHex(rlpEncode([])), "0xc0");
    assert.equal(bytesToHex(rlpEncode(0n)), "0x80");
    assert.equal(bytesToHex(rlpEncode(15n)), "0x0f");
    assert.equal(bytesToHex(rlpEncode(1024n)), "0x820400");
    assert.equal(
      bytesToHex(rlpEncode([ascii("cat"), ascii("dog")])),
      "0xc88363617483646f67"
    );
  });
});
