"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inspect } = require("node:util");
const { createChain } = require("../lib/chain");
const { openKey } = require("../lib/chain/keys");
const { loadConfig, publicConfig } = require("../lib/config");
const { createServer } = require("../server");
const { openStore } = require("../lib/store");
const { openRecords } = require("../lib/records");
const { createMockChain } = require("./mock-chain");

const RELAYER_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const REGISTRAR_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const ACCESS_ID = "cf-access-id-test-only-9f3a";
const ACCESS_SECRET = "cf-access-secret-test-only-b7c2";
const SECRETS = [RELAYER_KEY, RELAYER_KEY.slice(2), REGISTRAR_KEY, REGISTRAR_KEY.slice(2), ACCESS_ID, ACCESS_SECRET];

function assertClean(label, text) {
  const haystack = String(text);
  for (const secret of SECRETS) {
    assert.equal(haystack.includes(secret), false, label);
  }
}

function captureConsole() {
  const lines = [];
  const originals = {};
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    originals[method] = console[method];
    console[method] = (...args) => {
      lines.push(args.map((arg) => {
        if (typeof arg === "string") return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }).join(" "));
    };
  }
  return {
    lines,
    restore() {
      for (const method of Object.keys(originals)) console[method] = originals[method];
    },
  };
}

describe("chain secrets stay inside the signer and the write headers", () => {
  it("keeps keys and Access values out of logs, errors, config, inspect, records, and read traffic", async () => {
    const logs = captureConsole();
    const errors = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-chain-secrets-"));
    try {
      const relayer = openKey(RELAYER_KEY);
      const registrar = openKey(REGISTRAR_KEY);
      const mock = createMockChain({ relayer: relayer.address, registrar: registrar.address });
      const config = {
        chain: {
          relayerKey: RELAYER_KEY,
          registrarKey: REGISTRAR_KEY,
          accessClientId: ACCESS_ID,
          accessClientSecret: ACCESS_SECRET,
          readRpc: mock.readUrl,
          writeRpc: mock.writeUrl,
          maxFeeGwei: 1,
        },
      };
      const deployment = {
        chainId: 852,
        genesisHash: mock.genesisHash,
        address: "0x481175bC15eE6e22EAB97176540a98aB6a2925eF",
        runtimeCodeHash: mock.runtimeCodeHash,
      };
      const chain = createChain({ config, deployment, fetchImpl: mock.fetchImpl });
      await chain.start();
      assert.equal(chain.status().state, "ready");
      const submitted = await chain.submit("markExpired", ["0x" + "22".repeat(32)]);
      assert.equal(submitted.state, "confirmed");
      mock.setReportedChainId(7);
      const mismatch = createChain({ config, deployment, fetchImpl: mock.fetchImpl });
      await mismatch.start();
      assert.equal(mismatch.status().state, "misconfigured");
      mock.setReportedChainId(852);
      mock.setFailReads(true, 500);
      const down = createChain({ config, deployment, fetchImpl: mock.fetchImpl });
      await down.start();
      assert.equal(down.status().state, "degraded");
      try {
        chain.registrarSign(null);
      } catch (error) {
        errors.push(error.message, error.stack);
      }
      try {
        openKey("0x" + "zz".repeat(32).slice(0, 64));
      } catch (error) {
        errors.push(error.message, error.stack);
      }
      const loaded = loadConfig({
        OCEANRELAY_RELAYER_KEY: RELAYER_KEY,
        OCEANRELAY_REGISTRAR_KEY: REGISTRAR_KEY,
        CF_ACCESS_CLIENT_ID: ACCESS_ID,
        CF_ACCESS_CLIENT_SECRET: ACCESS_SECRET,
      });
      const recordsPath = path.join(dir, "records.json");
      const storePath = path.join(dir, "store.json");
      loaded.recordsPath = recordsPath;
      loaded.storePath = storePath;
      const records = openRecords(recordsPath);
      records.transact((data) => {
        data.audit.push({ event: "chain.secrets" });
      });
      const store = openStore(storePath, "test-token-encryption-key");
      let server;
      try {
        server = createServer({
          config: loaded,
          store,
          records,
          fetchImpl: async () => {
            throw new Error("down");
          },
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        let body;
        for (let i = 0; i < 20; i += 1) {
          body = await (await fetch(`${base}/config`)).json();
          if (body.chain && body.chain.state !== "checking") break;
          await new Promise((resolve) => setImmediate(resolve));
        }
        assertClean("config", JSON.stringify(body));
        assert.equal(body.chain.state, "degraded");
      } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
      }

      const surfaces = [
        logs.lines.join("\n"),
        errors.join("\n"),
        inspect(chain),
        inspect(chain, { showHidden: true, depth: 8 }),
        JSON.stringify(chain),
        JSON.stringify(chain.status()),
        JSON.stringify(publicConfig(loaded)),
        fs.readFileSync(recordsPath, "utf8"),
        JSON.stringify(mock.reads()),
      ];
      surfaces.forEach((text, index) => assertClean("surface " + index, text));
      for (const call of mock.writes()) {
        assert.equal(call.method, "eth_sendRawTransaction");
        assert.equal(call.headers["CF-Access-Client-Id"], ACCESS_ID);
        assert.equal(call.headers["CF-Access-Client-Secret"], ACCESS_SECRET);
        assertClean("write body", JSON.stringify({ url: call.url, method: call.method, params: call.params }));
      }
      assert.ok(mock.writes().length >= 1);
    } finally {
      logs.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
