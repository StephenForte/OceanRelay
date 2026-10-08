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
        "data-chain": JSON.stringify(FORTE_CHAIN),
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
        if (method === "wallet_switchEthereumChain") return Promise.resolve(null);
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

const FORTE_CHAIN = {
  chainId: "0x354",
  chainName: "ForteL2 Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://fortel2-sequencer-rpc.onrender.com/"],
  blockExplorerUrls: ["https://settlementos-explorer-ihgo.onrender.com/fortel2-sepolia/"],
};

function runClick(scriptText, ethereum, attributes) {
  const form = {
    attributes,
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
  vm.runInNewContext(scriptText, { window: { ethereum }, document }, { filename: "wallet.js" });
  return Promise.resolve(button.listeners.click({ preventDefault() {} })).then(() => ({ form, note }));
}

function domainAttributes() {
  return {
    "data-domain": JSON.stringify({
      name: vectors.domain.name,
      version: vectors.domain.version,
      chainId: vectors.domain.chainId,
      verifyingContract: vectors.domain.verifyingContract,
    }),
    "data-company-key": vectors.samples.Binding.message.companyKey,
    "data-deadline": String(vectors.samples.Binding.message.deadline),
    "data-chain": JSON.stringify(FORTE_CHAIN),
  };
}

// A MetaMask-like provider: typed data must use the active chain, and an unknown chain is 4902.
function metamask({ active, known, address, rejectSwitch, rejectAdd, onSign }) {
  const calls = [];
  const added = [];
  let chain = active;
  const knownIds = new Set(known);
  return {
    calls,
    added,
    request({ method, params }) {
      calls.push(method);
      if (method === "eth_requestAccounts") return Promise.resolve([address]);
      if (method === "wallet_switchEthereumChain") {
        if (rejectSwitch) return Promise.reject(Object.assign(new Error("User rejected the request."), { code: 4001 }));
        const next = Number.parseInt(params[0].chainId, 16);
        if (!knownIds.has(next)) {
          return Promise.reject(Object.assign(new Error("Unrecognized chain ID"), { code: 4902 }));
        }
        chain = next;
        return Promise.resolve(null);
      }
      if (method === "wallet_addEthereumChain") {
        if (rejectAdd) return Promise.reject(Object.assign(new Error("User rejected the request."), { code: 4001 }));
        added.push(params[0]);
        const next = Number.parseInt(params[0].chainId, 16);
        knownIds.add(next);
        chain = next;
        return Promise.resolve(null);
      }
      if (method === "eth_signTypedData_v4") {
        const typed = JSON.parse(params[1]);
        if (typed.domain.chainId !== chain) {
          return Promise.reject(new Error(`Provided chainId "${typed.domain.chainId}" must match the active chainId "${chain}"`));
        }
        return Promise.resolve(onSign(typed));
      }
      return Promise.reject(new Error(`unexpected ${method}`));
    },
  };
}

describe("wallet.js chain switch", () => {
  const address = openKey(TEST_KEY).address;

  it("holds no chain constants", () => {
    assert.equal(script.includes("0x354"), false);
    assert.equal(script.includes("ForteL2"), false);
    assert.equal(script.includes("fortel2"), false);
    assert.equal(script.includes("innerHTML"), false);
  });

  it("switches, adds an unknown chain, then signs and submits", async () => {
    const provider = metamask({
      active: 1,
      known: [1],
      address,
      onSign: (typed) => openKey(TEST_KEY).signDigest(digestHex(typed)),
    });
    const { form } = await runClick(script, provider, domainAttributes());
    assert.deepEqual(provider.calls, [
      "eth_requestAccounts",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "eth_signTypedData_v4",
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(provider.added)), [FORTE_CHAIN]);
    assert.equal(form.submitted, true);
    assert.equal(form.children[0].value, address);
  });

  it("switches without adding when the chain is already known", async () => {
    const provider = metamask({
      active: 1,
      known: [1, 852],
      address,
      onSign: () => `0x${"22".repeat(65)}`,
    });
    const { form } = await runClick(script, provider, domainAttributes());
    assert.deepEqual(provider.calls, [
      "eth_requestAccounts",
      "wallet_switchEthereumChain",
      "eth_signTypedData_v4",
    ]);
    assert.deepEqual(provider.added, []);
    assert.equal(form.submitted, true);
  });

  it("submits when the wallet is already on the domain chain", async () => {
    const provider = metamask({
      active: 852,
      known: [852],
      address,
      onSign: () => `0x${"33".repeat(65)}`,
    });
    const { form } = await runClick(script, provider, domainAttributes());
    assert.equal(form.submitted, true);
    assert.equal(provider.calls.includes("wallet_addEthereumChain"), false);
    assert.equal(provider.calls.at(-1), "eth_signTypedData_v4");
  });

  it("does not submit when the switch or the add is rejected", async () => {
    const refusedSwitch = metamask({
      active: 1,
      known: [1, 852],
      address,
      rejectSwitch: true,
      onSign: () => "0x",
    });
    const switched = await runClick(script, refusedSwitch, domainAttributes());
    assert.equal(switched.form.submitted, false);
    assert.equal(switched.note.textContent, "The wallet did not switch to this chain.");
    assert.equal(refusedSwitch.calls.includes("eth_signTypedData_v4"), false);
    assert.equal(refusedSwitch.calls.includes("wallet_addEthereumChain"), false);

    const refusedAdd = metamask({
      active: 1,
      known: [1],
      address,
      rejectAdd: true,
      onSign: () => "0x",
    });
    const added = await runClick(script, refusedAdd, domainAttributes());
    assert.equal(added.form.submitted, false);
    assert.equal(added.note.textContent, "The wallet did not switch to this chain.");
    assert.deepEqual(refusedAdd.calls, [
      "eth_requestAccounts",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
    ]);
  });
});

function encodeBinding(types) {
  return `Binding(${types.Binding.map((field) => `${field.type} ${field.name}`).join(",")})`;
}
