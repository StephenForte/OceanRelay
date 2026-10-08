"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createChain } = require("../lib/chain");
const { openKey } = require("../lib/chain/keys");
const { digestHex } = require("./eip712-generic");
const vectors = require("../contracts/vectors/eip712.json");
const script = fs.readFileSync(require.resolve("../lib/assets/wallet.js"), "utf8");

// Anvil account 0, the vector signer. Test only. Never use for real funds.
const TEST_KEY = vectors.signer.privateKey;

function typeLists(typed) {
  return {
    EIP712Domain: typed.types.EIP712Domain,
    Binding: typed.types.Binding,
  };
}

describe("wallet.js typed data", () => {
  it("matches the chain digest and the Binding vector without using the server encoder", () => {
    const chain = createChain({
      deployment: {
        chainId: vectors.domain.chainId,
        address: vectors.domain.verifyingContract,
        genesisHash: `0x${"11".repeat(32)}`,
        runtimeCodeHash: `0x${"22".repeat(32)}`,
      },
    });
    const sample = vectors.samples.Binding;
    let captured = null;
    const form = {
      attributes: {
        "data-domain": JSON.stringify({
          name: vectors.domain.name,
          version: vectors.domain.version,
          chainId: vectors.domain.chainId,
          verifyingContract: vectors.domain.verifyingContract,
        }),
        "data-company-key": sample.message.companyKey,
        "data-deadline": String(sample.message.deadline),
      },
      submitted: false,
      children: [
        { name: "wallet", value: "" },
        { name: "signature", value: "" },
      ],
      getAttribute(name) {
        return this.attributes[name];
      },
      querySelector(selector) {
        const found = /name=([A-Za-z]+)/.exec(selector);
        return this.children.find((child) => child.name === found[1]);
      },
      submit() {
        this.submitted = true;
      },
    };
    const note = { textContent: "" };
    Object.defineProperty(note, "innerHTML", {
      set() {
        throw new Error("script injected html");
      },
    });
    const button = { listeners: {} };
    button.addEventListener = (type, fn) => {
      button.listeners[type] = fn;
    };
    const document = {
      getElementById(id) {
        if (id === "wallet-bind") return form;
        if (id === "wallet-sign") return button;
        if (id === "wallet-note") return note;
        return null;
      },
    };
    const signer = openKey(TEST_KEY);
    const ethereum = {
      request({ method, params }) {
        if (method === "eth_requestAccounts") return Promise.resolve([signer.address]);
        if (method === "eth_signTypedData_v4") {
          captured = JSON.parse(params[1]);
          assert.equal(params[0], signer.address);
          const digest = digestHex(captured);
          return Promise.resolve(signer.signDigest(digest));
        }
        return Promise.reject(new Error("unexpected"));
      },
    };
    vm.runInNewContext(script, { window: { ethereum }, document }, { filename: "wallet.js" });
    return button.listeners.click({ preventDefault() {} }).then(() => {
      assert.equal(form.submitted, true);
      assert.equal(form.children[0].value, signer.address);
      assert.equal(captured.primaryType, "Binding");
      assert.equal(captured.message.deadline, String(sample.message.deadline));
      assert.equal(typeof captured.message.deadline, "string");
      const fromScript = digestHex(captured);
      const chainDigest = chain.typed.digest("Binding", {
        companyKey: captured.message.companyKey,
        wallet: captured.message.wallet,
        deadline: Number(captured.message.deadline),
      });
      assert.equal(fromScript, chainDigest);
      const vectorTyped = {
        types: typeLists(captured),
        primaryType: "Binding",
        domain: {
          name: vectors.domain.name,
          version: vectors.domain.version,
          chainId: vectors.domain.chainId,
          verifyingContract: vectors.domain.verifyingContract,
        },
        message: sample.message,
      };
      const vectorDigest = digestHex(vectorTyped);
      assert.equal(vectorDigest, sample.digest);
      assert.equal(vectorDigest, chain.typed.digest("Binding", sample.message));
      assert.equal(encodeBinding(captured.types), "Binding(bytes32 companyKey,address wallet,uint64 deadline)");
      const { encodeType } = require("./eip712-generic");
      assert.equal(encodeType("Binding", captured.types), "Binding(bytes32 companyKey,address wallet,uint64 deadline)");
      assert.equal(encodeType("EIP712Domain", captured.types), "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    });
  });

  it("shows a fixed message when there is no browser wallet and injects no html", () => {
    assert.equal(script.includes("innerHTML"), false);
    assert.equal(script.includes("document.write"), false);
    const note = { textContent: "unchanged" };
    let html = false;
    Object.defineProperty(note, "innerHTML", {
      set() {
        html = true;
      },
    });
    const form = {
      getAttribute() {
        return "";
      },
      submitted: false,
      submit() {
        this.submitted = true;
      },
    };
    const button = { listeners: {} };
    button.addEventListener = (type, fn) => {
      button.listeners[type] = fn;
    };
    const document = {
      getElementById(id) {
        if (id === "wallet-bind") return form;
        if (id === "wallet-sign") return button;
        if (id === "wallet-note") return note;
        return null;
      },
    };
    vm.runInNewContext(script, { window: {}, document }, { filename: "wallet.js" });
    button.listeners.click({ preventDefault() {} });
    assert.equal(note.textContent, "A browser wallet is required.");
    assert.equal(form.submitted, false);
    assert.equal(html, false);
  });
});

function encodeBinding(types) {
  return `Binding(${types.Binding.map((field) => `${field.type} ${field.name}`).join(",")})`;
}
