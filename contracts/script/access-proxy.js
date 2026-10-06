"use strict";

// Local proxy that adds Cloudflare Access headers before forwarding JSON-RPC.
// Foundry 1.8.5's `forge script` has no header flag and does not send ETH_RPC_HEADERS.
// The process reads the header values from the environment and does not print them.

const http = require("http");
const https = require("https");

const rawTarget = process.env.FORTEL2_WRITE_RPC || "";
const clientId = process.env.CF_ACCESS_CLIENT_ID || "";
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET || "";

if (!rawTarget || !clientId || !clientSecret) {
  console.error("Set FORTEL2_WRITE_RPC, CF_ACCESS_CLIENT_ID, and CF_ACCESS_CLIENT_SECRET.");
  process.exit(1);
}

let target;
try {
  target = new URL(rawTarget);
} catch (err) {
  console.error("FORTEL2_WRITE_RPC is not a URL.");
  process.exit(1);
}

if (target.protocol !== "https:" && target.protocol !== "http:") {
  console.error("FORTEL2_WRITE_RPC must be http or https.");
  process.exit(1);
}

const port = Number(process.env.LEDGER_PROXY_PORT || 8546);
const transport = target.protocol === "https:" ? https : http;

const server = http.createServer((req, res) => {
  const headers = Object.assign({}, req.headers, {
    host: target.host,
    "CF-Access-Client-Id": clientId,
    "CF-Access-Client-Secret": clientSecret,
  });
  const base = target.pathname.replace(/\/$/, "");
  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: base + (req.url || "/"),
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(err.message);
  });
  req.pipe(upstream);
});

server.listen(port, "127.0.0.1", () => {
  console.log("OceanRelay ledger proxy listening on 127.0.0.1:" + port);
});
