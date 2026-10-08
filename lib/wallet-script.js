"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const text = fs.readFileSync(path.join(__dirname, "assets", "wallet.js"), "utf8");
const hash = crypto.createHash("sha256").update(text).digest("hex");

module.exports = {
  text,
  hash,
  href: `/assets/wallet.js?v=${hash}`,
};
