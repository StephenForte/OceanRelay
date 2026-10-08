"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { keccak_256 } = require("@noble/hashes/sha3.js");
const { encodeCall, decodeResult, decodeRevert, selectorOf, RECORD_FUNCTIONS } = require("../lib/chain/abi");
const { bytesToHex, hexToBytes } = require("../lib/chain/hex");

function selector(signature) {
  return bytesToHex(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4));
}

describe("ledger ABI", () => {
  it("names the nine record functions and their selectors", () => {
    assert.deepEqual(RECORD_FUNCTIONS, [
      "bindWallet",
      "publishOffer",
      "publishVersion",
      "setOfferState",
      "markExpired",
      "recordRequest",
      "recordAcceptance",
      "recordStatus",
      "recordCancellation",
    ]);
    assert.equal(selectorOf("bindWallet"), selector("bindWallet(bytes32,address,uint64,bytes,bytes)"));
    assert.equal(selectorOf("recordAcceptance"), selector("recordAcceptance(bytes32,uint32,bytes32,uint64,bytes,bytes)"));
    assert.equal(selectorOf("markExpired"), selector("markExpired(bytes32)"));
    assert.equal(selectorOf("relayer"), selector("relayer()"));
    assert.equal(selectorOf("paused"), selector("paused()"));
  });

  it("encodes static words and dynamic signatures", () => {
    const company = "0x" + "11".repeat(32);
    const wallet = "0x00000000000000000000000000000000000000ab";
    const sig = "0x" + "ab".repeat(65);
    const data = encodeCall("bindWallet", [company, wallet, 42, sig, "0x"]);
    assert.equal(data.slice(0, 10), selectorOf("bindWallet"));
    const body = hexToBytes(data).subarray(4);
    assert.equal(bytesToHex(body.subarray(0, 32)), company);
    assert.equal(bytesToHex(body.subarray(44, 64)), wallet);
    assert.equal(body[95], 42);
    const firstOffset = Number(BigInt(bytesToHex(body.subarray(96, 128))));
    const length = Number(BigInt(bytesToHex(body.subarray(firstOffset, firstOffset + 32))));
    assert.equal(length, 65);
    assert.equal(bytesToHex(body.subarray(firstOffset + 32, firstOffset + 32 + 65)), sig);
  });

  it("decodes view returns and custom errors from independent words", () => {
    const relayer = "0x" + "00".repeat(12) + "f39fd6e51aad88f6f4ce6ab8827279cfffb92266";
    assert.equal(
      decodeResult("relayer", relayer).toLowerCase(),
      "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
    );
    assert.equal(decodeResult("paused", "0x" + "00".repeat(31) + "01"), true);
    const digest = "0x" + "44".repeat(32);
    const used = selector("DigestUsed(bytes32)") + digest.slice(2);
    assert.deepEqual(decodeRevert(used), { name: "DigestUsed", args: [digest] });
    const wallet = "0x" + "00".repeat(12) + "32b2231464f99b81f5fcffbba66b99fda97bb116";
    const unbound = selector("WalletNotBound(address)") + wallet.slice(2);
    const decoded = decodeRevert(unbound);
    assert.equal(decoded.name, "WalletNotBound");
    assert.equal(decoded.args[0].toLowerCase(), "0x32b2231464f99b81f5fcffbba66b99fda97bb116");
    const reason = "too long";
    const encoded = encodeCall("publishOffer", [
      "0x" + "22".repeat(32),
      "0x" + "33".repeat(32),
      9,
      9,
      "0xabcd",
    ]);
    assert.equal(encoded.slice(0, 10), selector("publishOffer(bytes32,bytes32,uint64,uint64,bytes)"));
    const strSel = selector("StringTooLong(string)");
    const payload = strSel
      + "0000000000000000000000000000000000000000000000000000000000000020"
      + "0000000000000000000000000000000000000000000000000000000000000008"
      + Buffer.from(reason).toString("hex").padEnd(64, "0");
    assert.deepEqual(decodeRevert(payload), { name: "StringTooLong", args: [reason] });
  });
});
