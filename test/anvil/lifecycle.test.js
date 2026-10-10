"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const vm = require("node:vm");
const { createChain } = require("../../lib/chain");
const { commitmentFromTermsHash } = require("../../lib/commitment");
const { openKey } = require("../../lib/chain/keys");
const { keccakHex } = require("../../lib/chain/keccak");
const { hexToBytes } = require("../../lib/chain/hex");
const { encodeCall, decodeResult } = require("../../lib/chain/abi");
const { createServer } = require("../../server");
const { loadConfig } = require("../../lib/config");
const { openStore } = require("../../lib/store");
const { openRecords } = require("../../lib/records");
const { COOKIE_NAME, signSession } = require("../../lib/session");
const { digestHex } = require("../eip712-generic");

// Anvil's published default accounts. Test only. Never use for real funds.
const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  relayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  registrar: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  seller: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  buyer: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  stranger: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  offer: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  // Anvil default accounts 7 and 8. Test only. The earlier calls already bind 0–6.
  requestSeller: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  requestBuyer: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
};

const DEADLINE = 1893456000;
const ROOT = path.join(__dirname, "../..");
const CONTRACTS = path.join(ROOT, "contracts");
const env = {
  ...process.env,
  PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH || ""}`,
};

function redact(text) {
  let out = String(text);
  for (const key of Object.values(KEYS)) {
    out = out.split(key).join("[test-key]").split(key.slice(2)).join("[test-key]");
  }
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) {
    const error = new Error("rpc_error");
    error.detail = redact(body.error.message || "");
    throw error;
  }
  return body.result;
}

async function waitForAnvil(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (await rpc(url, "eth_chainId", []) === "0x7a69") return;
    } catch {
      // Anvil is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("anvil_not_ready");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, env: options.env || env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(redact(`${command} exited ${code}\n${stderr}\n${stdout}`).slice(-2000)));
    });
  });
}

describe("anvil ledger", () => {
  const scratch = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  let anvil;

  after(() => {
    if (anvil && anvil.exitCode == null) anvil.kill("SIGTERM");
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(path.join(CONTRACTS, "broadcast/Deploy.s.sol/31337"), { recursive: true, force: true });
    for (const dir of ["broadcast/Deploy.s.sol", "broadcast"]) {
      const full = path.join(CONTRACTS, dir);
      try {
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      } catch {
        // Leave a broadcast directory that already held other deploys.
      }
    }
  });

  it("matches the committed ABI to forge build", () => {
    execFileSync("forge", ["build", "--silent"], { cwd: CONTRACTS, env, stdio: "inherit" });
    const built = JSON.parse(fs.readFileSync(path.join(CONTRACTS, "out/OceanRelayLedger.sol/OceanRelayLedger.json"), "utf8")).abi;
    const committed = JSON.parse(fs.readFileSync(path.join(CONTRACTS, "abi/OceanRelayLedger.json"), "utf8"));
    assert.deepEqual(committed, built);
  });

  it("confirms bind, publish, request, accept, status and cancel", async (t) => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const log = fs.openSync(path.join(scratch, "anvil.log"), "a");
    anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], {
      env,
      stdio: ["ignore", log, log],
    });
    await waitForAnvil(url);

    const relayer = openKey(KEYS.relayer);
    const registrar = openKey(KEYS.registrar);
    const seller = openKey(KEYS.seller);
    const buyer = openKey(KEYS.buyer);
    const stranger = openKey(KEYS.stranger);
    await run("forge", [
      "script",
      "script/Deploy.s.sol",
      "--rpc-url",
      url,
      "--broadcast",
      "--private-key",
      KEYS.owner,
      "--sender",
      openKey(KEYS.owner).address,
    ], {
      cwd: CONTRACTS,
      env: {
        ...env,
        RELAYER_ADDRESS: relayer.address,
        REGISTRAR_ADDRESS: registrar.address,
      },
    });

    const broadcast = JSON.parse(fs.readFileSync(
      path.join(CONTRACTS, "broadcast/Deploy.s.sol/31337/run-latest.json"),
      "utf8"
    ));
    const created = broadcast.transactions.find((tx) => tx.contractAddress);
    const address = created.contractAddress;
    const code = await rpc(url, "eth_getCode", [address, "latest"]);
    const genesis = await rpc(url, "eth_getBlockByNumber", ["0x0", false]);
    const chain = createChain({
      config: {
        chain: {
          relayerKey: KEYS.relayer,
          registrarKey: KEYS.registrar,
          accessClientId: "anvil-access-id",
          accessClientSecret: "anvil-access-secret",
          readRpc: url,
          writeRpc: url,
          maxFeeGwei: 100,
        },
      },
      deployment: {
        chainId: 31337,
        genesisHash: genesis.hash,
        address,
        runtimeCodeHash: keccakHex(hexToBytes(code)),
      },
      pollIntervalMs: 50,
    });
    await chain.start();
    assert.equal(chain.status().state, "ready", chain.status().reason);

    const offerId = "0x" + "33".repeat(32);
    const commitment = "0x" + "44".repeat(32);
    const requestId = "0x" + "55".repeat(32);
    const terms = "0x" + "66".repeat(32);

    async function sign(key, type, message) {
      return key.signDigest(chain.typed.digest(type, message));
    }
    async function confirm(label, fn, args) {
      const result = await chain.submit(fn, args);
      assert.equal(result.state, "confirmed", label + " " + JSON.stringify(result.error || result));
      return result;
    }

    const bindSeller = { companyKey: "0x" + "11".repeat(32), wallet: seller.address, deadline: DEADLINE };
    await confirm("bind seller", "bindWallet", [
      bindSeller.companyKey,
      seller.address,
      DEADLINE,
      await sign(seller, "Binding", bindSeller),
      chain.registrarSign(bindSeller),
    ]);
    const bindBuyer = { companyKey: "0x" + "22".repeat(32), wallet: buyer.address, deadline: DEADLINE };
    await confirm("bind buyer", "bindWallet", [
      bindBuyer.companyKey,
      buyer.address,
      DEADLINE,
      await sign(buyer, "Binding", bindBuyer),
      chain.registrarSign(bindBuyer),
    ]);

    const publish = { offerId, commitment, expiresAt: DEADLINE, deadline: DEADLINE };
    const publishSig = await sign(seller, "Publish", publish);
    await confirm("publish", "publishOffer", [offerId, commitment, DEADLINE, DEADLINE, publishSig]);

    const request = { requestId, offerId, version: 1, deadline: DEADLINE };
    await confirm("request", "recordRequest", [
      requestId,
      offerId,
      1,
      DEADLINE,
      await sign(buyer, "Request", request),
    ]);

    const acceptance = { requestId, counter: 0, termsCommitment: terms, deadline: DEADLINE };
    await confirm("accept", "recordAcceptance", [
      requestId,
      0,
      terms,
      DEADLINE,
      await sign(seller, "Acceptance", acceptance),
      await sign(buyer, "Acceptance", acceptance),
    ]);

    const status = { requestId, status: 3, seq: 0, deadline: DEADLINE };
    await confirm("status", "recordStatus", [
      requestId,
      3,
      0,
      DEADLINE,
      await sign(seller, "Status", status),
    ]);

    const cancellation = { requestId, deadline: DEADLINE };
    await confirm("cancel", "recordCancellation", [
      requestId,
      DEADLINE,
      await sign(seller, "Cancellation", cancellation),
      await sign(buyer, "Cancellation", cancellation),
    ]);

    const replay = await chain.submit("publishOffer", [offerId, commitment, DEADLINE, DEADLINE, publishSig]);
    assert.equal(replay.state, "refused");
    assert.equal(replay.error.name, "DigestUsed");

    const otherOffer = "0x" + "77".repeat(32);
    const unboundMessage = { offerId: otherOffer, commitment, expiresAt: DEADLINE, deadline: DEADLINE };
    const unbound = await chain.submit("publishOffer", [
      otherOffer,
      commitment,
      DEADLINE,
      DEADLINE,
      await sign(stranger, "Publish", unboundMessage),
    ]);
    assert.equal(unbound.state, "refused");
    assert.equal(unbound.error.name, "WalletNotBound");

    const nonce = BigInt(await rpc(url, "eth_getTransactionCount", [relayer.address, "pending"]));
    const raw = relayer.signTransaction({
      chainId: 31337,
      nonce,
      maxPriorityFeePerGas: 1_000_000_000n,
      maxFeePerGas: 2_000_000_000n,
      gasLimit: 21_000n,
      to: registrar.address,
      value: 0n,
      data: "0x",
    });
    const hash = await rpc(url, "eth_sendRawTransaction", [raw]);
    let receipt = null;
    for (let i = 0; i < 20 && !receipt; i += 1) {
      receipt = await rpc(url, "eth_getTransactionReceipt", [hash]);
      if (!receipt) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(receipt && receipt.status, "0x1");

    await t.test("binds a wallet through the HTTP routes", async () => {
      await bindWalletOverHttp({
        url,
        address,
        genesisHash: genesis.hash,
        runtimeCodeHash: keccakHex(hexToBytes(code)),
        scratch,
      });
    });

    await t.test("records an offer through the HTTP routes", async () => {
      await recordOfferOverHttp({
        url,
        address,
        genesisHash: genesis.hash,
        runtimeCodeHash: keccakHex(hexToBytes(code)),
        scratch,
      });
    });

    await t.test("records a request, both acceptances, statuses and cancellation through the HTTP routes", async () => {
      await recordRequestsOverHttp(scratch);
    });
  });

  it("reconciles four adoptable cases and an unknown key", async () => {
    await reconcileOnAnvil(scratch);
  });
});

const HTTP_SESSION = "anvil-wallet-session-secret";

function htmlAttr(html, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(html);
  if (!match) return "";
  return match[1].replaceAll("&quot;", "\"").replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

async function browserSignature(html, privateKey) {
  const signer = openKey(privateKey);
  const form = {
    attributes: {
      "data-domain": htmlAttr(html, "data-domain"),
      "data-company-key": htmlAttr(html, "data-company-key"),
      "data-deadline": htmlAttr(html, "data-deadline"),
    },
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
    submit() {},
  };
  const button = {
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
  };
  const document = {
    getElementById(id) {
      if (id === "wallet-bind") return form;
      if (id === "wallet-sign") return button;
      if (id === "wallet-note") return { textContent: "" };
      return null;
    },
  };
  const ethereum = {
    request({ method, params }) {
      if (method === "eth_requestAccounts") return Promise.resolve([signer.address]);
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
        return Promise.resolve(null);
      }
      return Promise.resolve(signer.signDigest(digestHex(JSON.parse(params[1]))));
    },
  };
  const script = fs.readFileSync(path.join(__dirname, "../../lib/assets/wallet.js"), "utf8");
  vm.runInNewContext(script, { window: { ethereum }, document }, { filename: "wallet.js" });
  await button.listeners.click({ preventDefault() {} });
  return {
    companyKey: form.attributes["data-company-key"],
    deadline: form.attributes["data-deadline"],
    wallet: form.children[0].value,
    signature: form.children[1].value,
  };
}

async function bindWalletOverHttp({ url, address, genesisHash, runtimeCodeHash, scratch }) {
  const recordsPath = path.join(scratch, "http-records.json");
  const config = loadConfig({
    RATE_NINJA_CLIENT_ID: "capacity-exchange",
    RATE_NINJA_CLIENT_SECRET: "anvil-client-secret",
    SESSION_SECRET: HTTP_SESSION,
    TOKEN_ENCRYPTION_KEY: "anvil-token-encryption-key",
    RATE_NINJA_BASE_URL: "http://127.0.0.1:9",
    OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    OCEANRELAY_RECORDS_PATH: recordsPath,
    OCEANRELAY_STORE_PATH: path.join(scratch, "http-store.json"),
    OCEANRELAY_RELAYER_KEY: KEYS.relayer,
    OCEANRELAY_REGISTRAR_KEY: KEYS.registrar,
    CF_ACCESS_CLIENT_ID: "anvil-access-id",
    CF_ACCESS_CLIENT_SECRET: "anvil-access-secret",
    FORTEL2_READ_RPC: url,
    FORTEL2_WRITE_RPC: url,
    OCEANRELAY_CHAIN_MAX_FEE_GWEI: "100",
  });
  const store = openStore(config.storePath, config.tokenEncryptionKey);
  const records = openRecords(recordsPath);
  function seed(sid, csrf, profile) {
    store.saveConnection(sid, {
      refreshToken: `refresh-${sid}`,
      scopes: ["profile:read", "rates:read", "sailings:read"],
      profile: {
        companyType: "Contract Owner",
        active: true,
        name: profile.companyName,
        ...profile,
      },
    });
    const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, HTTP_SESSION));
    return `${COOKIE_NAME}=${value}`;
  }
  const kings = seed("sid-kings", "csrf-kings", { sub: "user-kings", companyId: "anvil-kings", companyName: "Anvil Kings" });
  const other = seed("sid-other", "csrf-other", { sub: "user-other", companyId: "anvil-other", companyName: "Anvil Other" });
  const server = createServer({
    config,
    store,
    records,
    deployment: {
      chainId: 31337,
      genesisHash,
      address,
      runtimeCodeHash,
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const readyDeadline = Date.now() + 15_000;
    let chainState = "";
    while (Date.now() < readyDeadline) {
      const configBody = await (await fetch(`${base}/config`)).json();
      chainState = configBody.chain && configBody.chain.state;
      if (chainState === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(chainState, "ready");

    async function submit(cookie, csrf) {
      const prepared = await fetch(`${base}/wallet/prepare`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf_token: csrf }),
      });
      assert.equal(prepared.status, 303);
      const page = await (await fetch(`${base}/wallet`, { headers: { cookie } })).text();
      const signed = await browserSignature(page, KEYS.stranger);
      const response = await fetch(`${base}/wallet/bind`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          csrf_token: csrf,
          wallet: signed.wallet,
          deadline: signed.deadline,
          signature: signed.signature,
        }),
      });
      const shown = response.headers.get("location")
        ? await (await fetch(new URL(response.headers.get("location"), base), { headers: { cookie } })).text()
        : "";
      return { status: response.status, location: response.headers.get("location"), signed, shown };
    }

    const first = await submit(kings, "csrf-kings");
    assert.equal(first.location, "/wallet?result=bound", first.shown.slice(0, 200));
    const companyKey = records.companyKeyFor("anvil-kings");
    const bound = records.walletsFor("anvil-kings")[0];
    assert.equal(bound.state, "confirmed");
    assert.match(bound.txHash, /^0x[0-9a-fA-F]{64}$/);
    const encoded = encodeCall("walletCompany", [bound.wallet]);
    const onChain = decodeResult("walletCompany", await rpc(url, "eth_call", [{ to: address, data: encoded }, "latest"]));
    assert.equal(onChain.toLowerCase(), companyKey.toLowerCase());
    const firstHash = bound.txHash;

    records.transact((data) => {
      data.companies["anvil-kings"].wallets = [];
    });
    const again = await submit(kings, "csrf-kings");
    assert.equal(again.location, "/wallet?result=bound");
    const rebound = records.walletsFor("anvil-kings").at(-1);
    assert.equal(rebound.state, "confirmed");
    assert.equal(rebound.txHash, null);
    assert.equal(rebound.error, null);

    const second = await submit(other, "csrf-other");
    assert.equal(second.location, "/wallet?result=other_company");
    assert.match(second.shown, /This wallet belongs to another company/);
    assert.equal(second.shown.includes(companyKey), false);
    assert.equal(second.shown.includes("anvil-kings"), false);
    assert.equal(records.walletsFor("anvil-other").at(-1).state, "refused");

    records.transact((data) => {
      const entry = data.companies["anvil-kings"].wallets.at(-1);
      entry.state = "pending";
      entry.txHash = firstHash;
    });
    const checked = await fetch(`${base}/wallet/check`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: kings, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: "csrf-kings" }),
    });
    assert.equal(checked.headers.get("location"), "/wallet?result=bound");
    assert.equal(records.walletsFor("anvil-kings").at(-1).state, "confirmed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function offerTerms(extra = {}) {
  return {
    source: "manual",
    origin: "CNSHA",
    destination: "USLAX",
    equipment: "40HC",
    quantity: 10,
    unit: "container",
    sailingStart: "2026-12-20",
    sailingEnd: "2026-12-27",
    cutoffDate: "2026-12-18",
    validityDeadline: "2099-12-31",
    currency: "USD",
    baseMinor: 2000,
    markup: { type: "absolute", minor: 500 },
    buyerMinor: 2500,
    codeShareName: "XYZ",
    operatingCarrier: "ABC",
    serviceTerms: "CY/CY",
    ...extra,
  };
}

function inputValue(html, name) {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return match ? match[1] : "";
}

function chainNumber(value) {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

async function browserChainSignature(html, privateKey) {
  const signer = openKey(privateKey);
  const form = {
    attributes: {
      "data-domain": htmlAttr(html, "data-domain"),
      "data-chain": htmlAttr(html, "data-chain"),
      "data-typed": htmlAttr(html, "data-typed"),
    },
    children: [{ name: "signature", value: "" }],
    getAttribute(name) {
      return this.attributes[name];
    },
    querySelector(selector) {
      const found = /name=([A-Za-z]+)/.exec(selector);
      return this.children.find((child) => child.name === found[1]);
    },
    submit() {},
  };
  const button = {
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
  };
  const document = {
    getElementById(id) {
      if (id === "chain-sign") return form;
      if (id === "chain-sign-button") return button;
      if (id === "chain-note") return { textContent: "" };
      return null;
    },
  };
  const ethereum = {
    request({ method, params }) {
      if (method === "eth_requestAccounts") return Promise.resolve([signer.address]);
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
        return Promise.resolve(null);
      }
      return Promise.resolve(signer.signDigest(digestHex(JSON.parse(params[1]))));
    },
  };
  const script = fs.readFileSync(path.join(__dirname, "../../lib/assets/wallet.js"), "utf8");
  vm.runInNewContext(script, { window: { ethereum }, document }, { filename: "wallet.js" });
  await button.listeners.click({ preventDefault() {} });
  return {
    kind: inputValue(html, "kind"),
    deadline: inputValue(html, "deadline"),
    signature: form.children[0].value,
    message: JSON.parse(form.attributes["data-typed"]).message,
  };
}

async function recordOfferOverHttp({ url, address, genesisHash, runtimeCodeHash, scratch }) {
  const recordsPath = path.join(scratch, "offer-records.json");
  const config = loadConfig({
    RATE_NINJA_CLIENT_ID: "capacity-exchange",
    RATE_NINJA_CLIENT_SECRET: "anvil-client-secret",
    SESSION_SECRET: HTTP_SESSION,
    TOKEN_ENCRYPTION_KEY: "anvil-token-encryption-key",
    RATE_NINJA_BASE_URL: "http://127.0.0.1:9",
    OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    OCEANRELAY_RECORDS_PATH: recordsPath,
    OCEANRELAY_STORE_PATH: path.join(scratch, "offer-store.json"),
    OCEANRELAY_RELAYER_KEY: KEYS.relayer,
    OCEANRELAY_REGISTRAR_KEY: KEYS.registrar,
    CF_ACCESS_CLIENT_ID: "anvil-access-id",
    CF_ACCESS_CLIENT_SECRET: "anvil-access-secret",
    FORTEL2_READ_RPC: url,
    FORTEL2_WRITE_RPC: url,
    OCEANRELAY_CHAIN_MAX_FEE_GWEI: "100",
  });
  const store = openStore(config.storePath, config.tokenEncryptionKey);
  const records = openRecords(recordsPath);
  const clock = { now: Date.now() };
  function seed(sid, csrf, profile) {
    store.saveConnection(sid, {
      refreshToken: `refresh-${sid}`,
      scopes: ["profile:read", "rates:read", "sailings:read"],
      profile: {
        companyType: "Contract Owner",
        active: true,
        name: profile.companyName,
        ...profile,
      },
    });
    const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, HTTP_SESSION));
    return `${COOKIE_NAME}=${value}`;
  }
  const cookie = seed("sid-offer", "csrf-offer", {
    sub: "user-offer",
    companyId: "anvil-offer",
    companyName: "Anvil Offer",
  });
  const server = createServer({
    config,
    store,
    records,
    now: () => clock.now,
    deployment: {
      chainId: 31337,
      genesisHash,
      address,
      runtimeCodeHash,
    },
  });
  const reader = createChain({
    config: config,
    deployment: { chainId: 31337, genesisHash, address, runtimeCodeHash },
    pollIntervalMs: 50,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const readyDeadline = Date.now() + 15_000;
    let chainState = "";
    while (Date.now() < readyDeadline) {
      const configBody = await (await fetch(`${base}/config`)).json();
      chainState = configBody.chain && configBody.chain.state;
      if (chainState === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(chainState, "ready");
    await reader.start();

    const preparedWallet = await fetch(`${base}/wallet/prepare`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: "csrf-offer" }),
    });
    assert.equal(preparedWallet.status, 303);
    const walletPage = await (await fetch(`${base}/wallet`, { headers: { cookie } })).text();
    const bound = await browserSignature(walletPage, KEYS.offer);
    const bind = await fetch(`${base}/wallet/bind`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf_token: "csrf-offer",
        wallet: bound.wallet,
        deadline: bound.deadline,
        signature: bound.signature,
      }),
    });
    assert.equal(bind.headers.get("location"), "/wallet?result=bound");
    assert.equal(records.walletsFor("anvil-offer")[0].state, "confirmed");

    const today = new Date().toISOString().slice(0, 10);
    const offer = records.createOffer(
      { companyId: "anvil-offer", sub: "user-offer" },
      { source: "manual", terms: offerTerms() }
    );

    async function signOffer() {
      const prepared = await fetch(`${base}/chain/offers/${offer.id}/prepare`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf_token: "csrf-offer" }),
      });
      assert.equal(prepared.status, 303, "prepare");
      const page = await (await fetch(`${base}/chain/offers/${offer.id}`, { headers: { cookie } })).text();
      const signed = await browserChainSignature(page, KEYS.offer);
      const response = await fetch(`${base}/chain/offers/${offer.id}/sign`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          csrf_token: "csrf-offer",
          kind: signed.kind,
          deadline: signed.deadline,
          signature: signed.signature,
        }),
      });
      return { location: response.headers.get("location"), signed };
    }

    async function onChain() {
      return reader.call("getOffer", [records.chainOfferFor(offer.id).offerKey]);
    }

    const published = await signOffer();
    assert.equal(published.location, `/chain/offers/${offer.id}?result=recorded`, published.location);
    assert.equal(records.getCompanyOffer("anvil-offer", offer.id).state, "published");
    let stored = await onChain();
    assert.equal(chainNumber(stored[1]), 1);
    assert.equal(chainNumber(stored[3]), 1);
    assert.equal(String(stored[5]).toLowerCase(), records.commitmentFor(offer.id, 1).toLowerCase());

    const edited = records.editOffer("anvil-offer", offer.id, {
      terms: offerTerms({ quantity: 8 }),
    }, "user-offer", today);
    assert.equal(edited.ok, true);
    const versioned = await signOffer();
    assert.equal(versioned.location, `/chain/offers/${offer.id}?result=recorded`);
    stored = await onChain();
    assert.equal(chainNumber(stored[1]), 2);
    assert.equal(String(stored[5]).toLowerCase(), records.commitmentFor(offer.id, 2).toLowerCase());

    const paused = await fetch(`${base}/offers/${offer.id}/state`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: "csrf-offer", to: "paused" }),
    });
    assert.equal(paused.status, 302);
    assert.equal(records.getCompanyOffer("anvil-offer", offer.id).state, "paused");
    const pauseSigned = await signOffer();
    assert.equal(pauseSigned.location, `/chain/offers/${offer.id}?result=recorded`);
    stored = await onChain();
    assert.equal(chainNumber(stored[2]), 1);
    assert.equal(chainNumber(stored[3]), 2);

    const resumed = await fetch(`${base}/offers/${offer.id}/state`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: "csrf-offer", to: "published" }),
    });
    assert.equal(resumed.status, 302);
    assert.equal(records.getCompanyOffer("anvil-offer", offer.id).state, "published");
    const resumeSigned = await signOffer();
    assert.equal(resumeSigned.location, `/chain/offers/${offer.id}?result=recorded`);
    stored = await onChain();
    assert.equal(chainNumber(stored[2]), 2);
    assert.equal(chainNumber(stored[3]), 1);

    const message = published.signed.message;
    const replay = await reader.submit("publishOffer", [
      message.offerId,
      message.commitment,
      message.expiresAt,
      message.deadline,
      published.signed.signature,
    ]);
    assert.equal(replay.state, "refused");
    assert.equal(replay.error && replay.error.name, "DigestUsed");

    const expiresAt = message.expiresAt;
    clock.now = (expiresAt + 120) * 1000;
    await rpc(url, "evm_setNextBlockTimestamp", [`0x${(BigInt(expiresAt) + 120n).toString(16)}`]);
    await rpc(url, "evm_mine", []);
    const checked = await fetch(`${base}/chain/offers/${offer.id}/check`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: "csrf-offer" }),
    });
    assert.equal(checked.headers.get("location"), `/chain/offers/${offer.id}?result=recorded`);
    stored = await onChain();
    assert.equal(chainNumber(stored[3]), 4);
    assert.equal(records.chainOfferFor(offer.id).confirmed.state, "expired");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function recordRequestsOverHttp(scratch) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(scratch, "request-anvil.log"), "a");
  const chainNode = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], {
    env,
    stdio: ["ignore", log, log],
  });
  try {
    await waitForAnvil(url);
    const relayer = openKey(KEYS.relayer);
    const registrar = openKey(KEYS.registrar);
    await run("forge", [
      "script",
      "script/Deploy.s.sol",
      "--rpc-url",
      url,
      "--broadcast",
      "--private-key",
      KEYS.owner,
      "--sender",
      openKey(KEYS.owner).address,
    ], {
      cwd: CONTRACTS,
      env: {
        ...env,
        RELAYER_ADDRESS: relayer.address,
        REGISTRAR_ADDRESS: registrar.address,
      },
    });
    const broadcast = JSON.parse(fs.readFileSync(
      path.join(CONTRACTS, "broadcast/Deploy.s.sol/31337/run-latest.json"),
      "utf8"
    ));
    const created = broadcast.transactions.find((tx) => tx.contractAddress);
    const address = created.contractAddress;
    const code = await rpc(url, "eth_getCode", [address, "latest"]);
    const genesis = await rpc(url, "eth_getBlockByNumber", ["0x0", false]);
    await recordRequestsOnChain({
      url,
      address,
      genesisHash: genesis.hash,
      runtimeCodeHash: keccakHex(hexToBytes(code)),
      scratch,
    });
  } finally {
    if (chainNode.exitCode == null) chainNode.kill("SIGTERM");
  }
}

async function recordRequestsOnChain({ url, address, genesisHash, runtimeCodeHash, scratch }) {
  const recordsPath = path.join(scratch, "request-records.json");
  const config = loadConfig({
    RATE_NINJA_CLIENT_ID: "capacity-exchange",
    RATE_NINJA_CLIENT_SECRET: "anvil-client-secret",
    SESSION_SECRET: HTTP_SESSION,
    TOKEN_ENCRYPTION_KEY: "anvil-token-encryption-key",
    RATE_NINJA_BASE_URL: "http://127.0.0.1:9",
    OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
    OCEANRELAY_RECORDS_PATH: recordsPath,
    OCEANRELAY_STORE_PATH: path.join(scratch, "request-store.json"),
    OCEANRELAY_RELAYER_KEY: KEYS.relayer,
    OCEANRELAY_REGISTRAR_KEY: KEYS.registrar,
    CF_ACCESS_CLIENT_ID: "anvil-access-id",
    CF_ACCESS_CLIENT_SECRET: "anvil-access-secret",
    FORTEL2_READ_RPC: url,
    FORTEL2_WRITE_RPC: url,
    OCEANRELAY_CHAIN_MAX_FEE_GWEI: "100",
  });
  const store = openStore(config.storePath, config.tokenEncryptionKey);
  const records = openRecords(recordsPath);
  const sellerIdentity = {
    companyId: "anvil-req-seller",
    sub: "user-req-seller",
    companyName: "Anvil Request Seller",
  };
  const buyerIdentity = {
    companyId: "anvil-req-buyer",
    sub: "user-req-buyer",
    companyName: "Anvil Request Buyer",
  };
  function seed(sid, csrf, profile) {
    store.saveConnection(sid, {
      refreshToken: `refresh-${sid}`,
      scopes: ["profile:read", "rates:read", "sailings:read"],
      profile: {
        companyType: "Contract Owner",
        active: true,
        name: profile.companyName,
        ...profile,
      },
    });
    const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, HTTP_SESSION));
    return `${COOKIE_NAME}=${value}`;
  }
  const sellerCookie = seed("sid-req-seller", "csrf-req-seller", sellerIdentity);
  const buyerCookie = seed("sid-req-buyer", "csrf-req-buyer", buyerIdentity);
  const server = createServer({
    config,
    store,
    records,
    deployment: {
      chainId: 31337,
      genesisHash,
      address,
      runtimeCodeHash,
    },
  });
  const reader = createChain({
    config,
    deployment: { chainId: 31337, genesisHash, address, runtimeCodeHash },
    pollIntervalMs: 50,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const readyDeadline = Date.now() + 15_000;
    let chainState = "";
    while (Date.now() < readyDeadline) {
      const configBody = await (await fetch(`${base}/config`)).json();
      chainState = configBody.chain && configBody.chain.state;
      if (chainState === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(chainState, "ready");
    await reader.start();

    async function bind(cookie, csrf, privateKey) {
      const prepared = await fetch(`${base}/wallet/prepare`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf_token: csrf }),
      });
      assert.equal(prepared.status, 303);
      const page = await (await fetch(`${base}/wallet`, { headers: { cookie } })).text();
      const signed = await browserSignature(page, privateKey);
      const response = await fetch(`${base}/wallet/bind`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          csrf_token: csrf,
          wallet: signed.wallet,
          deadline: signed.deadline,
          signature: signed.signature,
        }),
      });
      assert.equal(response.headers.get("location"), "/wallet?result=bound");
    }

    await bind(sellerCookie, "csrf-req-seller", KEYS.requestSeller);
    await bind(buyerCookie, "csrf-req-buyer", KEYS.requestBuyer);
    assert.equal(records.walletsFor("anvil-req-seller")[0].state, "confirmed");
    assert.equal(records.walletsFor("anvil-req-buyer")[0].state, "confirmed");

    const today = new Date().toISOString().slice(0, 10);
    const offer = records.createOffer(sellerIdentity, { source: "manual", terms: offerTerms() });
    const preparedOffer = await fetch(`${base}/chain/offers/${offer.id}/prepare`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: sellerCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: "csrf-req-seller" }),
    });
    assert.equal(preparedOffer.status, 303);
    const offerPage = await (await fetch(`${base}/chain/offers/${offer.id}`, { headers: { cookie: sellerCookie } })).text();
    const offerSigned = await browserChainSignature(offerPage, KEYS.requestSeller);
    const published = await fetch(`${base}/chain/offers/${offer.id}/sign`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: sellerCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf_token: "csrf-req-seller",
        kind: offerSigned.kind,
        deadline: offerSigned.deadline,
        signature: offerSigned.signature,
      }),
    });
    assert.equal(published.headers.get("location"), `/chain/offers/${offer.id}?result=recorded`);
    assert.equal(records.getCompanyOffer("anvil-req-seller", offer.id).state, "published");

    async function pageOf(cookie, requestId) {
      return (await fetch(`${base}/chain/requests/${requestId}`, { headers: { cookie } })).text();
    }

    async function signRequest(cookie, csrf, privateKey, requestId) {
      let html = await pageOf(cookie, requestId);
      if (html.includes('id="chain-prepare"')) {
        const prepared = await fetch(`${base}/chain/requests/${requestId}/prepare`, {
          method: "POST",
          redirect: "manual",
          headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ csrf_token: csrf }),
        });
        assert.equal(prepared.status, 303, "prepare");
        html = await pageOf(cookie, requestId);
      }
      assert.match(html, /id="chain-sign"/, html.slice(0, 800));
      const signed = await browserChainSignature(html, privateKey);
      const response = await fetch(`${base}/chain/requests/${requestId}/sign`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          csrf_token: csrf,
          kind: signed.kind,
          deadline: signed.deadline,
          signature: signed.signature,
        }),
      });
      return { location: response.headers.get("location"), signed };
    }

    function storedCommitment(requestId, saltKey) {
      const request = records.getRequestFor("anvil-req-seller", requestId);
      const chain = records.chainRequestFor(requestId);
      return commitmentFromTermsHash(request.acceptance.termsHash, chain.salts[saltKey]);
    }

    const listed = records.createRequest(buyerIdentity, offer.id, 1, 2, today);
    assert.equal(listed.ok, true, listed.error);
    const linked = await signRequest(buyerCookie, "csrf-req-buyer", KEYS.requestBuyer, listed.request.id);
    assert.equal(linked.location, `/chain/requests/${listed.request.id}?result=recorded`, linked.location);
    assert.equal(records.chainRequestFor(listed.request.id).confirmed.recorded, true);

    const proposed = await signRequest(buyerCookie, "csrf-req-buyer", KEYS.requestBuyer, listed.request.id);
    assert.equal(proposed.location, `/chain/requests/${listed.request.id}?result=proposed`);
    const accepted = await signRequest(sellerCookie, "csrf-req-seller", KEYS.requestSeller, listed.request.id);
    assert.equal(accepted.location, `/chain/requests/${listed.request.id}?result=recorded`, accepted.location);
    assert.equal(accepted.signed.message.counter, 0);
    assert.equal(records.getRequestFor("anvil-req-seller", listed.request.id).state, "accepted");
    let onChain = await reader.call("getRequest", [records.chainRequestFor(listed.request.id).requestKey]);
    assert.equal(chainNumber(onChain[4]), 2);
    assert.equal(String(onChain[5]).toLowerCase(), storedCommitment(listed.request.id, "0").toLowerCase());

    const countered = records.createRequest(buyerIdentity, offer.id, 1, 1, today);
    assert.equal(countered.ok, true, countered.error);
    const secondLink = await signRequest(buyerCookie, "csrf-req-buyer", KEYS.requestBuyer, countered.request.id);
    assert.equal(secondLink.location, `/chain/requests/${countered.request.id}?result=recorded`);
    const counter = records.counterRequest(sellerIdentity, countered.request.id, {
      quantity: 1,
      unitBuyerMinor: 2400,
      serviceTerms: "CY/CY",
    }, today);
    assert.equal(counter.ok, true, counter.error);
    const counterProposal = await signRequest(sellerCookie, "csrf-req-seller", KEYS.requestSeller, countered.request.id);
    assert.equal(counterProposal.location, `/chain/requests/${countered.request.id}?result=proposed`, counterProposal.location);
    const counterAccept = await signRequest(buyerCookie, "csrf-req-buyer", KEYS.requestBuyer, countered.request.id);
    assert.equal(counterAccept.location, `/chain/requests/${countered.request.id}?result=recorded`, counterAccept.location);
    assert.equal(counterAccept.signed.message.counter, 1);
    assert.equal(records.chainRequestFor(countered.request.id).confirmed.acceptedCounter, 1);
    onChain = await reader.call("getRequest", [records.chainRequestFor(countered.request.id).requestKey]);
    assert.equal(chainNumber(onChain[4]), 2);
    assert.equal(String(onChain[5]).toLowerCase(), storedCommitment(countered.request.id, "1").toLowerCase());

    const pending = records.recordCarrierStatus(sellerIdentity, listed.request.id, "carrier_pending", "booked");
    assert.equal(pending.ok, true, pending.error);
    const pendingSigned = await signRequest(sellerCookie, "csrf-req-seller", KEYS.requestSeller, listed.request.id);
    assert.equal(pendingSigned.location, `/chain/requests/${listed.request.id}?result=recorded`, pendingSigned.location);
    assert.equal(pendingSigned.signed.message.seq, 0);
    assert.equal(pendingSigned.signed.message.status, 3);
    onChain = await reader.call("getRequest", [records.chainRequestFor(listed.request.id).requestKey]);
    assert.equal(chainNumber(onChain[3]), 1);
    assert.equal(chainNumber(onChain[4]), 3);

    const confirmed = records.recordCarrierStatus(buyerIdentity, listed.request.id, "carrier_confirmed", "confirmed");
    assert.equal(confirmed.ok, true, confirmed.error);
    const confirmedSigned = await signRequest(buyerCookie, "csrf-req-buyer", KEYS.requestBuyer, listed.request.id);
    assert.equal(confirmedSigned.location, `/chain/requests/${listed.request.id}?result=recorded`, confirmedSigned.location);
    assert.equal(confirmedSigned.signed.message.seq, 1);
    assert.equal(confirmedSigned.signed.message.status, 4);
    onChain = await reader.call("getRequest", [records.chainRequestFor(listed.request.id).requestKey]);
    assert.equal(chainNumber(onChain[3]), 2);
    assert.equal(chainNumber(onChain[4]), 4);

    const proposal = records.proposeCancellation(sellerIdentity, listed.request.id, "schedule change");
    assert.equal(proposal.ok, true, proposal.error);
    const agreed = records.agreeCancellation(buyerIdentity, listed.request.id);
    assert.equal(agreed.ok, true, agreed.error);
    const firstCancel = await signRequest(buyerCookie, "csrf-req-buyer", KEYS.requestBuyer, listed.request.id);
    assert.equal(firstCancel.location, `/chain/requests/${listed.request.id}?result=proposed`);
    const secondCancel = await signRequest(sellerCookie, "csrf-req-seller", KEYS.requestSeller, listed.request.id);
    assert.equal(secondCancel.location, `/chain/requests/${listed.request.id}?result=recorded`, secondCancel.location);
    onChain = await reader.call("getRequest", [records.chainRequestFor(listed.request.id).requestKey]);
    assert.equal(chainNumber(onChain[4]), 8);
    assert.equal(records.chainRequestFor(listed.request.id).confirmed.cancelled, true);

    const replay = await reader.submit("recordRequest", [
      linked.signed.message.requestId,
      linked.signed.message.offerId,
      linked.signed.message.version,
      linked.signed.message.deadline,
      linked.signed.signature,
    ]);
    assert.equal(replay.state, "refused");
    assert.equal(replay.error && replay.error.name, "DigestUsed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function reconcileOnAnvil(scratch) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(scratch, "reconcile-anvil.log"), "a");
  const chainNode = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], {
    env,
    stdio: ["ignore", log, log],
  });
  let server;
  try {
    await waitForAnvil(url);
    const relayer = openKey(KEYS.relayer);
    const registrar = openKey(KEYS.registrar);
    const sellerKey = openKey(KEYS.seller);
    await run("forge", [
      "script",
      "script/Deploy.s.sol",
      "--rpc-url",
      url,
      "--broadcast",
      "--private-key",
      KEYS.owner,
      "--sender",
      openKey(KEYS.owner).address,
    ], {
      cwd: CONTRACTS,
      env: {
        ...env,
        RELAYER_ADDRESS: relayer.address,
        REGISTRAR_ADDRESS: registrar.address,
      },
    });
    const broadcast = JSON.parse(fs.readFileSync(
      path.join(CONTRACTS, "broadcast/Deploy.s.sol/31337/run-latest.json"),
      "utf8"
    ));
    const created = broadcast.transactions.find((tx) => tx.contractAddress);
    const address = created.contractAddress;
    const code = await rpc(url, "eth_getCode", [address, "latest"]);
    const genesis = await rpc(url, "eth_getBlockByNumber", ["0x0", false]);
    const runtimeCodeHash = keccakHex(hexToBytes(code));
    const recordsPath = path.join(scratch, "reconcile-records.json");
    const config = loadConfig({
      RATE_NINJA_CLIENT_ID: "capacity-exchange",
      RATE_NINJA_CLIENT_SECRET: "anvil-client-secret",
      SESSION_SECRET: HTTP_SESSION,
      TOKEN_ENCRYPTION_KEY: "anvil-token-encryption-key",
      RATE_NINJA_BASE_URL: "http://127.0.0.1:9",
      OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
      OCEANRELAY_RECORDS_PATH: recordsPath,
      OCEANRELAY_STORE_PATH: path.join(scratch, "reconcile-store.json"),
      OCEANRELAY_RELAYER_KEY: KEYS.relayer,
      OCEANRELAY_REGISTRAR_KEY: KEYS.registrar,
      CF_ACCESS_CLIENT_ID: "anvil-access-id",
      CF_ACCESS_CLIENT_SECRET: "anvil-access-secret",
      FORTEL2_READ_RPC: url,
      FORTEL2_WRITE_RPC: url,
      OCEANRELAY_CHAIN_MAX_FEE_GWEI: "100",
      OCEANRELAY_OPERATOR_SUBS: "user-operator",
    });
    const store = openStore(config.storePath, config.tokenEncryptionKey);
    const records = openRecords(recordsPath);
    function seed(sid, csrf, profile) {
      store.saveConnection(sid, {
        refreshToken: `refresh-${sid}`,
        scopes: ["profile:read", "rates:read", "sailings:read"],
        profile: {
          companyType: "Contract Owner",
          active: true,
          name: profile.companyName,
          ...profile,
        },
      });
      const value = encodeURIComponent(signSession({ sid, csrf, iat: Date.now() }, HTTP_SESSION));
      return `${COOKIE_NAME}=${value}`;
    }
    const seller = { companyId: "anvil-recon-seller", sub: "user-recon-seller", companyName: "Recon Seller" };
    const buyer = { companyId: "anvil-recon-buyer", sub: "user-recon-buyer", companyName: "Recon Buyer" };
    const sellerCookie = seed("sid-recon-seller", "csrf-recon-seller", seller);
    const buyerCookie = seed("sid-recon-buyer", "csrf-recon-buyer", buyer);
    const operatorCookie = seed("sid-recon-operator", "csrf-recon-operator", {
      companyId: "anvil-ops",
      sub: "user-operator",
      companyName: "Recon Ops",
    });
    server = createServer({
      config,
      store,
      records,
      deployment: {
        chainId: 31337,
        genesisHash: genesis.hash,
        address,
        runtimeCodeHash,
        block: 0,
      },
    });
    const reader = createChain({
      config,
      deployment: { chainId: 31337, genesisHash: genesis.hash, address, runtimeCodeHash, block: 0 },
      pollIntervalMs: 50,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const readyDeadline = Date.now() + 15_000;
    let chainState = "";
    while (Date.now() < readyDeadline) {
      const configBody = await (await fetch(`${base}/config`)).json();
      chainState = configBody.chain && configBody.chain.state;
      if (chainState === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(chainState, "ready");
    await reader.start();

    async function bind(cookie, csrf, privateKey) {
      const prepared = await fetch(`${base}/wallet/prepare`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf_token: csrf }),
      });
      assert.equal(prepared.status, 303);
      const page = await (await fetch(`${base}/wallet`, { headers: { cookie } })).text();
      const signed = await browserSignature(page, privateKey);
      const response = await fetch(`${base}/wallet/bind`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          csrf_token: csrf,
          wallet: signed.wallet,
          deadline: signed.deadline,
          signature: signed.signature,
        }),
      });
      assert.equal(response.headers.get("location"), "/wallet?result=bound");
    }

    await bind(sellerCookie, "csrf-recon-seller", KEYS.seller);
    await bind(buyerCookie, "csrf-recon-buyer", KEYS.buyer);
    const sellerWallet = records.walletsFor(seller.companyId)[0];
    const buyerWallet = records.walletsFor(buyer.companyId)[0];
    assert.equal(sellerWallet.state, "confirmed");
    assert.equal(buyerWallet.state, "confirmed");

    const today = new Date().toISOString().slice(0, 10);
    const offer = records.createOffer(seller, { source: "manual", terms: offerTerms() });
    const preparedOffer = await fetch(`${base}/chain/offers/${offer.id}/prepare`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: sellerCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: "csrf-recon-seller" }),
    });
    assert.equal(preparedOffer.status, 303);
    const offerPage = await (await fetch(`${base}/chain/offers/${offer.id}`, { headers: { cookie: sellerCookie } })).text();
    const offerSigned = await browserChainSignature(offerPage, KEYS.seller);
    const published = await fetch(`${base}/chain/offers/${offer.id}/sign`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: sellerCookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf_token: "csrf-recon-seller",
        kind: offerSigned.kind,
        deadline: offerSigned.deadline,
        signature: offerSigned.signature,
      }),
    });
    assert.equal(published.headers.get("location"), `/chain/offers/${offer.id}?result=recorded`);

    async function pageOf(cookie, requestId) {
      return (await fetch(`${base}/chain/requests/${requestId}`, { headers: { cookie } })).text();
    }
    async function signRequest(cookie, csrf, privateKey, requestId) {
      let html = await pageOf(cookie, requestId);
      if (html.includes('id="chain-prepare"')) {
        const prepared = await fetch(`${base}/chain/requests/${requestId}/prepare`, {
          method: "POST",
          redirect: "manual",
          headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ csrf_token: csrf }),
        });
        assert.equal(prepared.status, 303);
        html = await pageOf(cookie, requestId);
      }
      const signed = await browserChainSignature(html, privateKey);
      const response = await fetch(`${base}/chain/requests/${requestId}/sign`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          csrf_token: csrf,
          kind: signed.kind,
          deadline: signed.deadline,
          signature: signed.signature,
        }),
      });
      return response.headers.get("location");
    }

    const listed = records.createRequest(buyer, offer.id, 1, 1, today);
    assert.equal(listed.ok, true, listed.error);
    assert.equal(
      await signRequest(buyerCookie, "csrf-recon-buyer", KEYS.buyer, listed.request.id),
      `/chain/requests/${listed.request.id}?result=recorded`
    );
    assert.equal(
      await signRequest(buyerCookie, "csrf-recon-buyer", KEYS.buyer, listed.request.id),
      `/chain/requests/${listed.request.id}?result=proposed`
    );
    assert.equal(
      await signRequest(sellerCookie, "csrf-recon-seller", KEYS.seller, listed.request.id),
      `/chain/requests/${listed.request.id}?result=recorded`
    );
    assert.equal(records.getRequestFor(seller.companyId, listed.request.id).state, "accepted");

    const offerState = records.getCompanyOffer(seller.companyId, offer.id).state;
    const requestState = records.getRequestFor(seller.companyId, listed.request.id).state;
    records.transact((data) => {
      data.companies[seller.companyId].wallets[0].state = "expired";
      const offerRow = data.offers[offer.id];
      offerRow.chain.confirmed = null;
      offerRow.chain.actions[0].status = "expired";
      const requestRow = data.requests[listed.request.id];
      requestRow.chain.confirmed = {
        recorded: true,
        acceptedCounter: null,
        status: null,
        statusSeq: 0,
        cancelled: false,
      };
      requestRow.chain.actions.find((action) => action.kind === "acceptance").status = "expired";
    });

    const owner = openKey(KEYS.owner);
    const revokeData = encodeCall("revokeWallet", [buyerWallet.wallet]);
    const nonce = BigInt(await rpc(url, "eth_getTransactionCount", [owner.address, "pending"]));
    const raw = owner.signTransaction({
      chainId: 31337,
      nonce,
      maxPriorityFeePerGas: 1_000_000_000n,
      maxFeePerGas: 2_000_000_000n,
      gasLimit: 300_000n,
      to: address,
      value: 0n,
      data: revokeData,
    });
    const revokeHash = await rpc(url, "eth_sendRawTransaction", [raw]);
    let revokeReceipt = null;
    for (let i = 0; i < 20 && !revokeReceipt; i += 1) {
      revokeReceipt = await rpc(url, "eth_getTransactionReceipt", [revokeHash]);
      if (!revokeReceipt) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(revokeReceipt && revokeReceipt.status, "0x1");

    const unknownId = "0x" + "99".repeat(32);
    const unknownCommitment = "0x" + "88".repeat(32);
    const unknownMessage = {
      offerId: unknownId,
      commitment: unknownCommitment,
      expiresAt: DEADLINE,
      deadline: DEADLINE,
    };
    const unknown = await reader.submit("publishOffer", [
      unknownId,
      unknownCommitment,
      DEADLINE,
      DEADLINE,
      sellerKey.signDigest(reader.typed.digest("Publish", unknownMessage)),
    ]);
    assert.equal(unknown.state, "confirmed", JSON.stringify(unknown.error || unknown));

    const decoded = await reader.events({ fromBlock: 0, toBlock: "latest" });
    const boundLog = decoded.find((event) => {
      return event.name === "WalletBound" && event.args.wallet.toLowerCase() === sellerWallet.wallet.toLowerCase();
    });
    assert.equal(boundLog.args.companyKey.toLowerCase(), records.companyKeyFor(seller.companyId).toLowerCase());
    assert.equal(Number.isInteger(boundLog.blockNumber), true);
    assert.match(boundLog.transactionHash, /^0x[0-9a-fA-F]{64}$/);
    assert.equal(decoded.some((event) => event.name === "OfferPublished" && event.args.offerId.toLowerCase() === unknownId), true);

    async function report() {
      const response = await fetch(`${base}/operator/chain/reconcile`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: operatorCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf_token: "csrf-recon-operator" }),
      });
      assert.equal(response.status, 200);
      const html = await response.text();
      const found = [];
      const pattern = /id="finding-([0-9a-f]+)" data-reason="([^"]+)" data-adoptable="(yes|no)"/g;
      let match;
      while ((match = pattern.exec(html))) {
        found.push({ id: match[1], reason: match[2], adoptable: match[3] === "yes" });
      }
      return found;
    }

    const first = await report();
    assert.deepEqual(
      first.filter((item) => item.adoptable).map((item) => item.reason).sort(),
      ["offer_landed", "request_landed", "wallet_bound", "wallet_revoked"]
    );
    assert.deepEqual(
      first.filter((item) => !item.adoptable).map((item) => item.reason).sort(),
      ["unknown_offer"]
    );

    for (const item of first.filter((entry) => entry.adoptable)) {
      const adopted = await fetch(`${base}/operator/chain/adopt`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: operatorCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf_token: "csrf-recon-operator", finding: item.id }),
      });
      assert.equal(adopted.status, 303, item.reason);
      assert.equal(adopted.headers.get("location"), "/operator/chain?result=corrected", item.reason);
    }

    assert.equal(records.walletsFor(seller.companyId)[0].state, "confirmed");
    assert.equal(records.walletsFor(buyer.companyId)[0].state, "revoked");
    assert.equal(records.walletsFor(buyer.companyId).some((entry) => entry.state === "confirmed"), false);
    assert.equal(records.chainOfferFor(offer.id).actions[0].status, "confirmed");
    assert.equal(records.chainOfferFor(offer.id).confirmed.state, "published");
    assert.equal(records.chainRequestFor(listed.request.id).actions.find((action) => action.kind === "acceptance").status, "confirmed");
    assert.equal(records.chainRequestFor(listed.request.id).confirmed.status, "accepted");
    assert.equal(records.getCompanyOffer(seller.companyId, offer.id).state, offerState);
    assert.equal(records.getRequestFor(seller.companyId, listed.request.id).state, requestState);
    const corrected = records.view((data) => data.audit.filter((entry) => entry.event === "chain.corrected"));
    assert.equal(corrected.length, 4);
    assert.deepEqual(
      corrected.map((entry) => entry.detail.reason).sort(),
      ["offer_landed", "request_landed", "wallet_bound", "wallet_revoked"]
    );

    const second = await report();
    assert.deepEqual(second.filter((item) => item.adoptable), []);
    assert.deepEqual(second.map((item) => item.reason), ["unknown_offer"]);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (chainNode.exitCode == null) chainNode.kill("SIGTERM");
  }
}
