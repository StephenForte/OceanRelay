"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { createChain } = require("../../lib/chain");
const { openKey } = require("../../lib/chain/keys");
const { keccakHex } = require("../../lib/chain/keccak");
const { hexToBytes } = require("../../lib/chain/hex");

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

  it("confirms bind, publish, request, accept, status and cancel", async () => {
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
  });
});
