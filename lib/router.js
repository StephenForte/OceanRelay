function createRouter() {
  const exact = {
    GET: new Map(),
    POST: new Map(),
  };
  const patterns = [];

  function addExact(method, path, handler) {
    if (exact[method].has(path)) {
      throw new Error(`duplicate route ${method} ${path}`);
    }
    exact[method].set(path, handler);
  }

  return {
    get(path, handler) {
      addExact("GET", path, handler);
    },
    post(path, handler) {
      addExact("POST", path, handler);
    },
    pattern(method, regex, handler) {
      if (!(regex instanceof RegExp)) throw new TypeError("pattern requires a RegExp");
      patterns.push({ method: String(method).toUpperCase(), regex, handler });
    },
    async handle(req, res, url) {
      const method = req.method || "GET";
      const pathname = url.pathname;
      const table = exact[method];
      if (table && table.has(pathname)) {
        await table.get(pathname)(req, res, url);
        return true;
      }
      for (const entry of patterns) {
        if (entry.method !== method) continue;
        entry.regex.lastIndex = 0;
        const match = entry.regex.exec(pathname);
        entry.regex.lastIndex = 0;
        if (!match) continue;
        await entry.handler(req, res, url, match);
        return true;
      }
      return false;
    },
  };
}

module.exports = { createRouter };
