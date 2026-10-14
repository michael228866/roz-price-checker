const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("resumes after human verification without losing completed keywords", async () => {
  const handlers = new Map();
  const events = [];
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "roz-main-"));
  let queries = 0;
  class BrowserWindow {
    constructor() {
      this.webContents = {
        send: (name, value) => events.push({ name, value }),
        once() {},
        executeJavaScript: async (script) => {
          if (script.includes("document.readyState")) return true;
          if (script.includes("return { started: true }")) {
            queries += 1;
            return { started: true };
          }
          if (script.includes("const message =")) {
            return {
              changed: queries !== 3,
              loading: false,
              noResults: false,
              output: [{ shop: `shop${queries}`, itemName: "Example", slots: "1", price: 100, quantity: 1, storeType: "販售" }],
              messageText: queries === 2 ? "請完成圖形驗證" : ""
            };
          }
          return undefined;
        }
      };
    }
    loadFile() {}
    loadURL() {}
    once() {}
    on() {}
    focus() {}
    isDestroyed() { return false; }
  }
  const electron = {
    app: { requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(), on() {}, getPath: () => directory },
    BrowserWindow,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    Notification: { isSupported: () => false },
    safeStorage: { isEncryptionAvailable: () => false }
  };
  class FakeStore {
    catalog() { return []; }
    dueCatalog() { return []; }
    historicalReferences() { return []; }
    activeReferences() { return []; }
    unseenCandidates() { return []; }
    markKeyword() {}
    markSearchAttempt() {}
    startRun() { return 1; }
    finishRun() {}
    saveObservations() { return []; }
    saveVisibleAlerts() { return []; }
    pendingAlerts() { return []; }
    status() { return { catalog: 0, listings: 0, pendingAlerts: 0, lastRun: null }; }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8"), {
    require: (name) => name === "electron" ? electron
      : name === "./store.cjs" ? { MarketStore: FakeStore }
      : name === "./shop_scanner.cjs" ? { scanKeywordPages: async (_webContents, keyword) => {
        queries += 1;
        if (queries === 2) throw new Error("請完成圖形驗證");
        return { status: "COMPLETE", items: [{ keyword, shop: `shop${queries}`,
          itemName: "Example", slots: "1", price: 100, quantity: 1,
          storeType: "販售", serverId: 529 }] };
      } } : require(name),
    __dirname,
    setTimeout: (callback) => callback(),
    setInterval: () => 1,
    clearInterval() {}
  });
  await Promise.resolve();

  await handlers.get("start-scanning")(null, { keywords: ["first", "second"], ratio: 0.15 });
  assert.equal(queries, 2, JSON.stringify(events));
  assert.ok(events.some(({ name, value }) => name === "scan-state" && value === "paused"));

  await handlers.get("resume-scanning")();
  assert.equal(queries, 3);
  assert.equal(events.find(({ name }) => name === "scan-results").value.listingCount, 2);

  handlers.get("stop-scanning")();
  await assert.rejects(handlers.get("resume-scanning")(), /沒有可繼續的掃描/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a second app instance quits before opening the shared user data", () => {
  let quits = 0;
  let readyCalls = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8"), {
    require: (name) => name === "electron" ? {
      app: { requestSingleInstanceLock: () => false, quit: () => { quits += 1; },
        whenReady: () => { readyCalls += 1; return Promise.resolve(); } },
      ipcMain: { handle() {} }
    } : require(name),
    __dirname
  });
  assert.equal(quits, 1);
  assert.equal(readyCalls, 0);
});
