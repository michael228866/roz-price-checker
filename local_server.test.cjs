const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { MarketStore } = require("./store.cjs");
const { MarketRepository } = require("./market_repository.cjs");
const { createLocalServer } = require("./local_server.cjs");

test("local market API is loopback only, read only and searches Chinese names safely", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-local-"));
  const store = new MarketStore(path.join(directory, "market.sqlite"));
  const now = new Date().toISOString();
  const insert = store.db.prepare(`INSERT INTO listings
    (key, server_id, shop, item_name, specification, price, quantity, spec_complete,
     first_seen, last_seen) VALUES (?, 529, ?, ?, ?, ?, 1, 1, ?, ?)`);
  insert.run("a", "甲店", "魔靈石", "a".repeat(64), 100, now, now);
  insert.run("b", "乙店", "魔靈石", "b".repeat(64), 50, now, now);
  insert.run("c", "丙店", "其他", "c".repeat(64), 1, now, now);
  insert.run("d", "<script>alert(1)</script>", "惡意文字", "d".repeat(64), 2, now, now);
  store.db.prepare("UPDATE data_sources SET authorization_reference=? WHERE id='official-api'")
    .run("private-token");
  const server = createLocalServer(new MarketRepository(store), {
    syncStatus: () => ({ state: "PAUSED_CHALLENGE" })
  });
  let url;
  try {
    url = await server.start();
    assert.equal(server.address().address, "127.0.0.1");
    const response = await fetch(url + "api/items?q=" + encodeURIComponent("魔靈石") + "&limit=1");
    const first = await response.json();
    assert.equal(first.total, 2);
    assert.equal(first.items[0].lowestPrice, 50);
    const second = await (await fetch(url + "api/items?q=" + encodeURIComponent("魔靈石") +
      "&limit=1&cursor=" + first.nextCursor)).json();
    assert.equal(second.items[0].lowestPrice, 100);
    assert.equal((await (await fetch(url + "api/items?q=" + encodeURIComponent("' OR 1=1 --"))).json()).total, 0);
    assert.equal((await fetch(url + "api/items?limit=1000")).status, 400);
    assert.equal((await fetch(url + "api/items", { method: "POST" })).status, 405);
    const badHost = await new Promise((resolve) => {
      http.get(url + "api/health", { headers: { Host: "evil.example" } },
        (result) => { result.resume(); resolve(result.statusCode); });
    });
    assert.equal(badHost, 403);
    assert.equal((await fetch(url + "api/health", { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(url + "api/market/summary")).status, 200);
    assert.equal((await (await fetch(url + "api/sync/status")).json()).state, "PAUSED_CHALLENGE");
    assert.equal((await (await fetch(url + "api/items?q=魔靈石")).json()).total, 2);
    assert.equal((await fetch(url + "api/sources")).status, 200);
    assert.equal((await fetch(url + "api/sources")).headers.get("access-control-allow-origin"), null);
    assert.ok(!(await (await fetch(url + "api/sources")).text()).includes("private-token"));
    const html = await fetch(url);
    assert.match(html.headers.get("content-security-policy"), /script-src 'self'/);
    assert.ok(!(await html.text()).includes("<script>alert(1)</script>"));
    assert.equal((await fetch(url + "api/coverage")).status, 200);
    assert.equal((await fetch(url + "api/items/" + "a".repeat(64) + "/history")).status, 200);
    assert.equal((await fetch(url + "api/alerts")).status, 200);
    assert.equal((await fetch(url + "api/admin")).status, 404);
    await server.close();
    await assert.rejects(fetch(url + "api/health"));
  } finally {
    await server.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("local dashboard never inserts untrusted market text as HTML", () => {
  const source = fs.readFileSync(path.join(__dirname, "web", "app.js"), "utf8");
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(source, /cell\.textContent = value/);
});
