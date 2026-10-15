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
        once() {}, on() {},
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
    recentReferences() { return []; }
    markListingUnavailable() {}
    unseenCandidates() { return []; }
    markKeyword() {}
    markSearchAttempt() {}
    recordKeywordPages() {}
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
      : name === "./shop_scanner.cjs" ? { challengeVisible: async () => false,
        scanKeywordPages: async (_webContents, keyword) => {
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

test("challenge before the search form is ready keeps a resumable checkpoint", async () => {
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "roz-early-challenge-"));
  const handlers = new Map();
  let challenged = true;
  let searched = 0;
  class BrowserWindow {
    constructor() { this.webContents = { send() {}, once() {}, on() {},
      executeJavaScript: async () => true }; }
    loadFile() {} loadURL() {} once() {} on() {} show() {} focus() {}
    isDestroyed() { return false; }
  }
  class FakeStore {
    dueCatalog() { return []; } activeReferences() { return []; }
    recentReferences() { return []; } unseenCandidates() { return []; }
    startRun() { return 1; } finishRun() {} markSearchAttempt() {}
    saveObservations() { return []; } recordKeywordPages() {}
    pendingAlerts() { return []; } status() { return { lastRun: null }; }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8"), {
    require: (name) => name === "electron" ? {
      app: { requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
        on() {}, getPath: () => directory }, BrowserWindow,
      ipcMain: { handle: (key, callback) => handlers.set(key, callback) },
      safeStorage: { isEncryptionAvailable: () => false },
      Notification: { isSupported: () => false }
    } : name === "./store.cjs" ? { MarketStore: FakeStore }
      : name === "./shop_scanner.cjs" ? {
        challengeVisible: async () => challenged,
        scanKeywordPages: async () => { searched += 1; return { status: "COMPLETE", items: [] }; }
      } : require(name),
    __dirname, setTimeout: (callback) => callback(), setInterval: () => 1, clearInterval() {}
  });
  await Promise.resolve();
  try {
    await handlers.get("start-scanning")(null, { keywords: ["Stone"], ratio: 0.15 });
    assert.equal(searched, 0);
    const checkpoint = JSON.parse(fs.readFileSync(path.join(directory, "scan-checkpoint.json"), "utf8"));
    assert.equal(checkpoint.planned, false);
    challenged = false;
    await handlers.get("resume-scanning")();
    assert.equal(searched, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Electron opens the local market URL in the system browser", async () => {
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "roz-local-open-"));
  const handlers = new Map();
  let opened;
  class BrowserWindow {
    constructor() { this.webContents = { send() {}, once() {}, on() {} }; }
    loadFile() {} once() {} show() {} focus() {}
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8"), {
    require: (name) => name === "electron" ? {
      app: { requestSingleInstanceLock: () => true,
        whenReady: () => Promise.resolve(), on() {}, getPath: () => directory },
      BrowserWindow, ipcMain: { handle: (key, callback) => handlers.set(key, callback) },
      shell: { openExternal: async (url) => { opened = url; } },
      safeStorage: { isEncryptionAvailable: () => false }
    } : name === "./store.cjs" ? { MarketStore: class {
      constructor() { this.db = {}; }
      markInterruptedDeliveries() {} status() { return { lastRun: null }; }
    } } : name === "./market_repository.cjs" ? { MarketRepository: class {} }
      : name === "./local_server.cjs" ? { createLocalServer: () => ({
        start: async () => "http://127.0.0.1:32123/", close: async () => {}
      }) } : require(name),
    __dirname, process, setInterval: () => 1, clearInterval() {}
  });
  await new Promise(setImmediate);
  try {
    await handlers.get("open-local-market")();
    assert.equal(opened, "http://127.0.0.1:32123/");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
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

test("checkpoint after the final keyword resumes the analysis phase", () => {
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "roz-checkpoint-"));
  const checkpoint = { keywords: ["Stone"], listings: [], pageStatuses: ["COMPLETE"],
    nextIndex: 1, phase: "SCANNING", runId: 7 };
  fs.writeFileSync(path.join(directory, "scan-checkpoint.json"), JSON.stringify(checkpoint));
  const source = `${fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8")}\n` +
    "globalThis.readCheckpointForTest = loadCheckpoint;";
  const context = { require: (name) => name === "electron" ? {
    app: { requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}),
      on() {}, getPath: () => directory }, ipcMain: { handle() {} }
  } : require(name), __dirname };
  vm.runInNewContext(source, context);
  try { assert.equal(context.readCheckpointForTest()?.nextIndex, 1); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("startup database failure is logged and exits instead of leaving an invisible process", async () => {
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "roz-startup-"));
  let quits = 0;
  let errorMessage = "";
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8"), {
    require: (name) => name === "electron" ? {
      app: { requestSingleInstanceLock: () => true,
        whenReady: () => Promise.resolve(), on() {},
        getPath: () => directory, quit: () => { quits += 1; } },
      ipcMain: { handle() {} },
      dialog: { showErrorBox: (_title, message) => { errorMessage = message; } }
    } : name === "./store.cjs" ? { MarketStore: class {
      constructor() { throw new Error("DATABASE_STARTUP_FAILED"); }
    } } : require(name),
    __dirname
  });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(quits, 1);
    assert.match(errorMessage, /DATABASE_STARTUP_FAILED/);
    assert.match(fs.readFileSync(path.join(directory, "startup.log"), "utf8"),
      /STARTUP_FAILED/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
