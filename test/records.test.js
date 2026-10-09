const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openRecords } = require("../lib/records");
const { loadConfig, publicConfig } = require("../lib/config");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oceanrelay-records-"));
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

describe("records store", () => {
  it("writes a fresh v7 file with mode 0600 when the file is missing", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "nested", "oceanrelay-records.json");
      const records = openRecords(file);
      assert.equal(records.filePath, file);
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepEqual(onDisk, { schemaVersion: 7, offers: {}, requests: {}, audit: [], companies: {} });
      assert.equal(mode(file), 0o600);
      const version = records.transact((data) => data.schemaVersion);
      assert.equal(version, 7);
      assert.equal(mode(file), 0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a transact and reloads it", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const records = openRecords(file);
      const created = records.transact((data) => {
        data.offers.o1 = { qty: 4 };
        data.audit.push({ event: "created" });
        return "saved";
      });
      assert.equal(created, "saved");
      assert.equal(mode(file), 0o600);
      const again = openRecords(file);
      again.transact((data) => {
        assert.equal(data.schemaVersion, 7);
        assert.deepEqual(data.requests, {});
        assert.deepEqual(data.companies, {});
        assert.deepEqual(data.offers.o1, { qty: 4 });
        assert.deepEqual(data.audit, [{ event: "created" }]);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps unknown top-level keys when a v1 file is migrated and reopened", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      fs.writeFileSync(file, JSON.stringify({
        schemaVersion: 1,
        offers: { a: { qty: 2 } },
        audit: [],
        future: { keep: true },
      }));
      const records = openRecords(file);
      records.transact((data) => {
        assert.equal(data.future.keep, true);
        data.offers.a.qty = 3;
      });
      const again = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(again.future.keep, true);
      assert.equal(again.offers.a.qty, 3);
      assert.equal(again.schemaVersion, 7);
      assert.deepEqual(again.companies, {});
      assert.deepEqual(again.requests, {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists nothing when the callback throws", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const records = openRecords(file);
      records.transact((data) => {
        data.offers.a = { qty: 1 };
      });
      const before = fs.readFileSync(file, "utf8");
      assert.throws(() => records.transact((data) => {
        data.offers.a.qty = 9;
        data.offers.leak = true;
        throw new Error("boom");
      }), /boom/);
      assert.equal(fs.readFileSync(file, "utf8"), before);
      openRecords(file).transact((data) => {
        assert.equal(data.offers.a.qty, 1);
        assert.equal(data.offers.leak, undefined);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when the callback is async and does not persist that attempt", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const records = openRecords(file);
      records.transact((data) => {
        data.offers.a = { qty: 1 };
      });
      const before = fs.readFileSync(file, "utf8");
      assert.throws(() => records.transact(async () => {}), /synchronous/);
      assert.throws(() => records.transact((data) => {
        data.offers.a.qty = 9;
        return Promise.resolve("later");
      }), /synchronous/);
      assert.equal(fs.readFileSync(file, "utf8"), before);
      records.transact((data) => {
        assert.equal(data.offers.a.qty, 1);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on a corrupt file and leaves it in place", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      fs.writeFileSync(file, "{not json");
      assert.throws(() => openRecords(file), /unparsable/);
      assert.equal(fs.readFileSync(file, "utf8"), "{not json");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on schemaVersion 8 and does not replace the file", () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, "records.json");
      const original = JSON.stringify({ schemaVersion: 8, offers: { keep: { qty: 7 } }, audit: ["stay"] });
      fs.writeFileSync(file, original);
      assert.throws(() => openRecords(file), /schemaVersion/);
      assert.equal(fs.readFileSync(file, "utf8"), original);
      assert.equal(fs.existsSync(`${file}.pre-m2.bak`), false);
      assert.equal(fs.existsSync(`${file}.pre-m3.bak`), false);
      assert.equal(fs.existsSync(`${file}.pre-m4.bak`), false);
      assert.equal(fs.existsSync(`${file}.pre-m5.bak`), false);
      assert.equal(fs.existsSync(`${file}.pre-m6.bak`), false);
      assert.equal(fs.existsSync(`${file}.pre-m7.bak`), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a memory-only store when filePath is null", () => {
    const records = openRecords(null);
    assert.equal(records.filePath, null);
    const length = records.transact((data) => {
      assert.equal(data.schemaVersion, 7);
      assert.deepEqual(data.requests, {});
      assert.deepEqual(data.companies, {});
      data.audit.push({ event: "memory" });
      return data.audit.length;
    });
    assert.equal(length, 1);
    records.transact((data) => {
      assert.deepEqual(data.audit, [{ event: "memory" }]);
    });
  });
});

describe("records config", () => {
  it("defaults OCEANRELAY_RECORDS_PATH and publishes the path", () => {
    const secret = "super-secret-should-not-appear";
    const config = loadConfig({
      RATE_NINJA_CLIENT_SECRET: secret,
      OCEANRELAY_RECORDS_PATH: "  data/custom-records.json  ",
    });
    assert.equal(config.recordsPath, "data/custom-records.json");
    assert.equal(loadConfig({}).recordsPath, "data/oceanrelay-records.json");
    const view = publicConfig(loadConfig({}));
    assert.equal(view.settings.OCEANRELAY_RECORDS_PATH, "data/oceanrelay-records.json");
    assert.equal(JSON.stringify(publicConfig(config)).includes(secret), false);
  });
});
