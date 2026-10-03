const fs = require("node:fs");
const path = require("node:path");
const { encryptString, decryptString } = require("./crypto-box");

const PENDING_AAD = "oceanrelay-pkce-verifier";
const REFRESH_AAD = "oceanrelay-refresh-token";
const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_MAX_ROWS = 1000;

function emptyData() {
  return { pending: {}, connections: {} };
}

function pendingExpired(row, now) {
  return now - row.createdAt > PENDING_TTL_MS;
}

function pruneExpiredPending(pending, now) {
  for (const sessionId of Object.keys(pending)) {
    const row = pending[sessionId];
    if (row && pendingExpired(row, now)) delete pending[sessionId];
  }
}

function pendingCreatedAt(row) {
  const createdAt = row && row.createdAt;
  return typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY;
}

function evictOldestPending(pending) {
  const ids = Object.keys(pending);
  if (ids.length <= PENDING_MAX_ROWS) return;
  ids.sort((leftId, rightId) => {
    const leftAt = pendingCreatedAt(pending[leftId]);
    const rightAt = pendingCreatedAt(pending[rightId]);
    if (leftAt < rightAt) return -1;
    if (leftAt > rightAt) return 1;
    return 0;
  });
  const overflow = ids.length - PENDING_MAX_ROWS;
  for (let index = 0; index < overflow; index += 1) {
    delete pending[ids[index]];
  }
}

function openStore(filePath, encryptionKey) {
  const memoryOnly = !filePath;
  let data = emptyData();
  if (!memoryOnly) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        data = {
          pending: parsed.pending && typeof parsed.pending === "object" ? parsed.pending : {},
          connections: parsed.connections && typeof parsed.connections === "object" ? parsed.connections : {},
        };
      } catch {
        data = emptyData();
      }
    }
  }

  function persist() {
    if (memoryOnly) return;
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600);
  }

  function requireKey() {
    if (!encryptionKey) throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
  }

  return {
    filePath: memoryOnly ? null : filePath,
    savePending(sessionId, { state, verifier, createdAt }) {
      requireKey();
      pruneExpiredPending(data.pending, Date.now());
      data.pending[sessionId] = {
        state,
        verifierCiphertext: encryptString(encryptionKey, verifier, PENDING_AAD),
        createdAt,
      };
      evictOldestPending(data.pending);
      persist();
    },
    takePending(sessionId, state) {
      const row = data.pending[sessionId];
      if (row !== undefined) {
        delete data.pending[sessionId];
        persist();
      }
      if (!row || row.state !== state || pendingExpired(row, Date.now())) return null;
      if (!encryptionKey) return null;
      const verifier = decryptString(encryptionKey, row.verifierCiphertext, PENDING_AAD);
      if (!verifier) return null;
      return { verifier };
    },
    saveConnection(sessionId, { refreshToken, scopes, profile }) {
      requireKey();
      const now = Date.now();
      data.connections[sessionId] = {
        refreshCiphertext: encryptString(encryptionKey, refreshToken, REFRESH_AAD),
        scopes,
        profile,
        connectedAt: now,
        updatedAt: now,
      };
      persist();
    },
    replaceRefreshToken(sessionId, refreshToken) {
      requireKey();
      const row = data.connections[sessionId];
      if (!row) return false;
      row.refreshCiphertext = encryptString(encryptionKey, refreshToken, REFRESH_AAD);
      row.updatedAt = Date.now();
      persist();
      return true;
    },
    connectionSecrets(sessionId) {
      const row = data.connections[sessionId];
      if (!row || !encryptionKey) return null;
      const refreshToken = decryptString(encryptionKey, row.refreshCiphertext, REFRESH_AAD);
      if (!refreshToken) return null;
      return { refreshToken, scopes: row.scopes, profile: row.profile };
    },
    publicConnection(sessionId) {
      const row = data.connections[sessionId];
      if (!row) return null;
      return {
        connected: true,
        scopes: row.scopes,
        profile: row.profile,
        connectedAt: new Date(row.connectedAt).toISOString(),
      };
    },
    deleteConnection(sessionId) {
      delete data.connections[sessionId];
      persist();
    },
  };
}

module.exports = { openStore };
