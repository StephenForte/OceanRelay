function register(router, deps) {
  router.get("/health", (req, res) => {
    deps.sendJson(res, 200, { status: "ok" });
  });
  router.get("/config", (req, res) => {
    deps.sendJson(res, 200, deps.publicConfig(deps.config));
  });
}

module.exports = { register };
