const { stylesheet } = require("../views/styles");

function register(router, deps) {
  router.get("/health", (req, res) => {
    deps.sendJson(res, 200, { status: "ok" });
  });
  router.get("/config", (req, res) => {
    deps.sendJson(res, 200, deps.publicConfig(deps.config));
  });
  router.get("/assets/oceanrelay.css", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/css; charset=utf-8",
      "Content-Length": Buffer.byteLength(stylesheet),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    res.end(stylesheet);
  });
}

module.exports = { register };
