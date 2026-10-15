const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const files = new Map([["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]]]);

function createLocalServer(repository, { port = 0, webRoot = path.join(__dirname, "web"),
  syncStatus = () => ({ state: "IDLE" }) } = {}) {
  const server = http.createServer((request, response) => {
    const host = request.headers.host ?? "";
    const actualPort = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    if (!allowedHosts.includes(host) || request.headers.origin &&
        !allowedHosts.some((value) => request.headers.origin === `http://${value}`)) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    let url;
    try { url = new URL(request.url, `http://${host}`); }
    catch { response.writeHead(400).end(); return; }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'");
    if (url.pathname.startsWith("/api/")) {
      try {
        let result;
        if (url.pathname === "/api/health") result = { ok: true, asOf: new Date().toISOString() };
        else if (url.pathname === "/api/market/summary") result = repository.summary(syncStatus().state);
        else if (url.pathname === "/api/items") result = repository.items(url.searchParams);
        else if (url.pathname === "/api/alerts") result = repository.alerts(url.searchParams);
        else if (url.pathname === "/api/sync/status") result = syncStatus();
        else if (url.pathname === "/api/sources") result = { items: repository.sources(), asOf: new Date().toISOString() };
        else if (url.pathname === "/api/coverage") result = { ...repository.coverage(), asOf: new Date().toISOString() };
        else {
          const match = /^\/api\/items\/([^/]+)\/(listings|history)$/.exec(url.pathname);
          if (!match) { response.writeHead(404).end(); return; }
          result = match[2] === "listings" ? repository.listings(match[1], url.searchParams)
            : repository.history(match[1], url.searchParams.get("range") ?? "7d");
        }
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(error instanceof RangeError ? 400 : 500,
          { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error instanceof RangeError
          ? error.message : "本地查詢失敗" }));
      }
      return;
    }
    const asset = files.get(url.pathname);
    if (!asset) { response.writeHead(404).end(); return; }
    try {
      const content = fs.readFileSync(path.join(webRoot, asset[0]));
      response.writeHead(200, { "Content-Type": asset[1] });
      response.end(content);
    } catch { response.writeHead(500).end(); }
  });
  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      return `http://127.0.0.1:${server.address().port}/`;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    address: () => server.address()
  };
}

module.exports = { createLocalServer };
