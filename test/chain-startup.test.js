"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createChain, LOW_BALANCE_WEI } = require("../lib/chain");
const { openKey } = require("../lib/chain/keys");
const { loadConfig, publicConfig } = require("../lib/config");
const { createServer } = require("../server");
const { openStore } = require("../lib/store");
const { openRecords } = require("../lib/records");
const { createMockChain } = require("./mock-chain");

const RELAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const REGISTRAR_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const ACCESS_ID = "cf-access-id-test-only-9f3a";
const ACCESS_SECRET = "cf-access-secret-test-only-b7c2";
const ADDRESS = "0x481175bC15eE6e22EAB97176540a98aB6a2925eF";

function fakeTimers() {
  const queue = [];
  return {
    queue,
    setTimeout(fn, ms) {
      const item = { fn, ms };
      queue.push(item);
      return item;
    },
    clearTimeout(item) {
      const index = queue.indexOf(item);
      if (index >= 0) queue.splice(index, 1);
    },
    fire() {
      const item = queue.shift();
      if (item) item.fn();
    },
  };
}

function chainConfig(mock, overrides = {}) {
  return {
    chain: {
      relayerKey: RELAYER_KEY,
      registrarKey: REGISTRAR_KEY,
      accessClientId: ACCESS_ID,
      accessClientSecret: ACCESS_SECRET,
      readRpc: mock.readUrl,
      writeRpc: mock.writeUrl,
      maxFeeGwei: 1,
      ...overrides,
    },
  };
}

function deploymentFor(mock, overrides = {}) {
  return {
    chainId: mock.chainId,
    genesisHash: mock.genesisHash,
    address: ADDRESS,
    runtimeCodeHash: mock.runtimeCodeHash,
    ...overrides,
  };
}

function blankChain(overrides = {}) {
  return {
    relayerKey: "",
    registrarKey: "",
    accessClientId: "",
    accessClientSecret: "",
    readRpc: "http://127.0.0.1:9/read",
    writeRpc: "http://127.0.0.1:10/write",
    maxFeeGwei: 1,
    ...overrides,
  };
}

describe("chain startup", () => {
  const relayer = openKey(RELAYER_KEY);
  const consoleMethods = ["log", "info", "warn", "error", "debug"];
  const originals = {};
  before(() => {
    for (const method of consoleMethods) {
      originals[method] = console[method];
      console[method] = () => {};
    }
  });
  after(() => {
    for (const method of consoleMethods) console[method] = originals[method];
  });
  const registrar = openKey(REGISTRAR_KEY);

  function mockFor(extra = {}) {
    return createMockChain({
      relayer: relayer.address,
      registrar: registrar.address,
      ...extra,
    });
  }

  it("stays disabled with no secrets and misconfigured when the set is incomplete", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error("unexpected");
    };
    const disabled = createChain({ config: { chain: blankChain() }, fetchImpl });
    await disabled.start();
    assert.equal(disabled.status().state, "disabled");
    assert.equal(disabled.status().reason, null);
    assert.equal(calls, 0);

    for (const partial of [
      { relayerKey: RELAYER_KEY },
      { relayerKey: RELAYER_KEY, registrarKey: REGISTRAR_KEY, accessClientId: ACCESS_ID },
    ]) {
      const chain = createChain({ config: { chain: blankChain(partial) }, fetchImpl });
      await chain.start();
      assert.equal(chain.status().state, "misconfigured");
      assert.equal(chain.status().reason, "incomplete");
      const refused = await chain.submit("markExpired", ["0x" + "11".repeat(32)]);
      assert.equal(refused.state, "refused");
      assert.equal(refused.error.name, "ChainNotReady");
    }
    assert.equal(calls, 0);
  });

  it("becomes ready, warns on a low balance, and refuses a paused or mismatched chain", async () => {
    const mock = mockFor();
    const chain = createChain({
      config: chainConfig(mock),
      deployment: deploymentFor(mock),
      fetchImpl: mock.fetchImpl,
    });
    await chain.start();
    assert.equal(chain.status().state, "ready");
    assert.equal(chain.status().lowBalance, false);
    assert.equal(mock.writes().length, 0);

    mock.setBalance(LOW_BALANCE_WEI - 1n);
    const low = createChain({
      config: chainConfig(mock),
      deployment: deploymentFor(mock),
      fetchImpl: mock.fetchImpl,
    });
    await low.start();
    assert.equal(low.status().state, "ready");
    assert.equal(low.status().lowBalance, true);
    assert.equal(low.status().relayerBalanceWei, (LOW_BALANCE_WEI - 1n).toString());

    const mismatches = [
      { reason: "chain_id", chainId: 1 },
      { reason: "genesis", genesisHash: "0x" + "22".repeat(32) },
      { reason: "code_hash", runtimeCodeHash: "0x" + "33".repeat(32) },
      { reason: "relayer", relayerAddress: registrar.address },
      { reason: "registrar", registrarAddress: relayer.address },
      { reason: "paused", paused: true },
    ];
    for (const mismatch of mismatches) {
      const started = createMockChain({
        relayer: mismatch.relayerAddress || relayer.address,
        registrar: mismatch.registrarAddress || registrar.address,
      });
      if (mismatch.chainId) started.setReportedChainId(mismatch.chainId);
      if (mismatch.paused) started.setPaused(true);
      const overrides = {};
      if (mismatch.genesisHash) overrides.genesisHash = mismatch.genesisHash;
      if (mismatch.runtimeCodeHash) overrides.runtimeCodeHash = mismatch.runtimeCodeHash;
      const checked = createChain({
        config: chainConfig(started),
        deployment: deploymentFor(started, overrides),
        fetchImpl: started.fetchImpl,
      });
      await checked.start();
      assert.equal(checked.status().state, "misconfigured", mismatch.reason);
      assert.equal(checked.status().reason, mismatch.reason);
      const refused = await checked.submit("markExpired", ["0x" + "11".repeat(32)]);
      assert.equal(refused.state, "refused");
      assert.equal(started.writes().length, 0, mismatch.reason);
    }
  });

  it("stays degraded while the read RPC is down and becomes ready on the next check", async () => {
    const mock = mockFor();
    const timers = fakeTimers();
    mock.setFailReads(true);
    const chain = createChain({
      config: chainConfig(mock),
      deployment: deploymentFor(mock),
      fetchImpl: mock.fetchImpl,
      timers,
    });
    await chain.start();
    assert.equal(chain.status().state, "degraded");
    assert.equal(timers.queue.length, 1);
    assert.equal(timers.queue[0].ms, 60_000);
    const refused = await chain.submit("markExpired", ["0x" + "11".repeat(32)]);
    assert.equal(refused.state, "refused");
    assert.equal(mock.writes().length, 0);
    mock.setFailReads(false);
    timers.fire();
    await chain.settled();
    assert.equal(chain.status().state, "ready");
    assert.equal(chain.status().reason, null);
  });
});

describe("marketplace while the chain is down", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-chain-"));
  const originals = {};
  before(() => {
    for (const method of ["log", "info", "warn", "error", "debug"]) {
      originals[method] = console[method];
      console[method] = () => {};
    }
  });
  let server;
  let base;

  after(async () => {
    for (const method of Object.keys(originals)) console[method] = originals[method];
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves health, home, and a degraded chain status", async () => {
    const env = {
      RATE_NINJA_CLIENT_ID: "capacity-exchange",
      RATE_NINJA_CLIENT_SECRET: "test-client-secret-value",
      SESSION_SECRET: "test-session-secret-value",
      TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
      OCEANRELAY_REDIRECT_URI: "http://127.0.0.1:9/oauth/callback",
      RATE_NINJA_BASE_URL: "http://127.0.0.1:9",
      OCEANRELAY_STORE_PATH: path.join(dir, "store.json"),
      OCEANRELAY_RECORDS_PATH: path.join(dir, "records.json"),
      OCEANRELAY_RELAYER_KEY: RELAYER_KEY,
      OCEANRELAY_REGISTRAR_KEY: REGISTRAR_KEY,
      CF_ACCESS_CLIENT_ID: ACCESS_ID,
      CF_ACCESS_CLIENT_SECRET: ACCESS_SECRET,
    };
    const config = loadConfig(env);
    assert.equal(config.ok, true);
    const view = publicConfig(config);
    assert.equal(view.chain.relayerKey, "set");
    assert.equal(JSON.stringify(view).includes(RELAYER_KEY), false);
    assert.equal(JSON.stringify(view).includes(ACCESS_SECRET), false);
    const store = openStore(config.storePath, config.tokenEncryptionKey);
    const records = openRecords(config.recordsPath);
    server = createServer({
      config,
      store,
      records,
      fetchImpl: async () => {
        throw new Error("read rpc down");
      },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), { status: "ok" });
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /OceanRelay/);
    let body;
    for (let i = 0; i < 20; i += 1) {
      body = await (await fetch(`${base}/config`)).json();
      if (body.chain.state !== "checking") break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(body.chain.state, "degraded");
    assert.equal(JSON.stringify(body).includes(RELAYER_KEY.slice(2)), false);
    assert.equal(JSON.stringify(body).includes(ACCESS_SECRET), false);
    assert.equal(fs.readFileSync(config.recordsPath, "utf8").includes(ACCESS_SECRET), false);
  });
});
