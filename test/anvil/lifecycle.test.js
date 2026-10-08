"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const vm = require("node:vm");
const { createChain } = require("../../lib/chain");
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
