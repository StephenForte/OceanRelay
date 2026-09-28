const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;

function freshData() {
  return { schemaVersion: SCHEMA_VERSION, offers: {}, audit: [] };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isThenable(value) {
  return Boolean(value) && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}

function readRecords(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("oceanrelay records file is unparsable");
  }
  if (!isPlainObject(parsed)) throw new Error("oceanrelay records file is unparsable");
  if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`oceanrelay records schemaVersion ${String(parsed.schemaVersion)} is not supported`);
  }
  if (parsed.offers === undefined) parsed.offers = {};
  if (parsed.audit === undefined) parsed.audit = [];
  if (!isPlainObject(parsed.offers)) throw new Error("oceanrelay records offers must be an object");
  if (!Array.isArray(parsed.audit)) throw new Error("oceanrelay records audit must be an array");
  return parsed;
}

function openRecords(filePath) {
  const memoryOnly = filePath == null || filePath === "";
  let data = freshData();
  let inTransact = false;

  function persistSnapshot(snapshot) {
    if (memoryOnly) return;
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);
  }

  if (!memoryOnly) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(filePath)) data = readRecords(filePath);
    else persistSnapshot(data);
  }

  return {
    filePath: memoryOnly ? null : filePath,
    // Synchronous on purpose (D-3). An async callback would await between a
    // check and the persist, so two requests could take the last unit.
    transact(fn) {
      if (typeof fn !== "function") throw new TypeError("transact requires a function");
      if (fn.constructor && fn.constructor.name === "AsyncFunction") {
        throw new Error("transact callback must be synchronous");
      }
      if (inTransact) throw new Error("transact cannot be nested");
      const draft = structuredClone(data);
      let result;
      inTransact = true;
      try {
        result = fn(draft);
      } finally {
        inTransact = false;
      }
      if (isThenable(result)) {
        Promise.resolve(result).then(() => {}, () => {});
        throw new Error("transact callback must be synchronous");
      }
      persistSnapshot(draft);
      data = draft;
      return result;
    },
  };
}

module.exports = { openRecords, SCHEMA_VERSION };
