const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

async function runScenario({ first, second, analyses = [], checkpoint = null,
  resumeAfterFailure = false }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-flow-"));
  if (checkpoint) fs.writeFileSync(path.join(directory, "scan-checkpoint.json"),
    JSON.stringify(checkpoint));
  const handlers = new Map();
  const saves = [];
  const unavailable = [];
  const events = [];
  let searches = 0;
  class BrowserWindow {
    constructor() { this.webContents = { send: (name, value) => events.push({ name, value }), once() {}, on() {},
      executeJavaScript: async () => true }; }
    loadFile() {} loadURL() {} once() {} on() {} show() {} focus() {}
    isDestroyed() { return false; }
  }
  class FakeStore {
    catalog() { return []; }
    dueCatalog() { return []; }
    activeReferences() { return []; }
    recentReferences() { return []; }
    markListingUnavailable(item) { unavailable.push(item); }
    unseenCandidates() { return analyses; }
    markKeyword() {} markSearchAttempt() {}
    recordKeywordPages() {}
    startRun() { return 1; }
    finishRun() {}
    saveObservations(_run, items, candidates, options) {
      saves.push({ items, candidates, options });
      return [];
    }
    pendingAlerts() { return []; }
    status() { return { catalog: 0, listings: 0, pendingAlerts: 0, lastRun: null }; }
  }
  const electron = { app: { requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), on() {}, getPath: () => directory },
    BrowserWindow, ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    Notification: { isSupported: () => false },
    safeStorage: { isEncryptionAvailable: () => false } };
  const market = require("./market.cjs");
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8"), {
    require: (name) => name === "electron" ? electron
      : name === "./store.cjs" ? { MarketStore: FakeStore }
      : name === "./market.cjs" ? { ...market, analyze: () => analyses }
      : name === "./shop_scanner.cjs" ? { challengeVisible: async () => false,
        scanKeywordPages: async (_contents, _keyword, options) => {
        searches += 1;
        options.onRequest();
        return searches === 1 ? first : second(options, searches);
      } } : require(name),
    __dirname, setTimeout: (callback) => callback(),
    setInterval: () => 1, clearInterval() {}
  });
  await Promise.resolve();
  try {
    if (checkpoint) {
      handlers.get("open-shop")();
      await handlers.get("resume-scanning")();
    }
    else await handlers.get("start-scanning")(null,
      { keywords: ["Stone"], ratio: 0.15 });
    const savedCheckpoint = fs.existsSync(path.join(directory, "scan-checkpoint.json"))
      ? JSON.parse(fs.readFileSync(path.join(directory, "scan-checkpoint.json"), "utf8")) : null;
    if (resumeAfterFailure) await handlers.get("resume-scanning")();
    return { saves, searches, unavailable, events, savedCheckpoint };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

const listing = { serverId: 529, keyword: "Stone", shop: "Shop", ssi: "one",
  itemName: "Stone", price: 100, quantity: 1, storeType: "販售",
  specification: "full", specComplete: true };

test("a max-page partial scan persists its 600 observed rows without claiming active quotes", async () => {
  const items = Array.from({ length: 600 }, (_, index) => ({
    ...listing, shop: `Shop${index}`, ssi: `ssi-${index}`
  }));
  const result = await runScenario({ first: { status: "PARTIAL", items },
    second: () => ({ status: "COMPLETE", items: [] }) });
  assert.ok(result.saves.some((save) => save.items.length === 600));
  assert.ok(result.saves.every((save) =>
    !(save.options.scannedKeywords ?? []).includes("Stone")));
});

test("network loss during candidate verification cannot erase first-pass snapshot", async () => {
  const candidate = { ...listing, referencePrice: 1000, sampleCount: 5,
    confidence: "HIGH", anomalyType: "POSSIBLE_MISSING_ZERO", ratio: 0.1 };
  const result = await runScenario({ first: { status: "COMPLETE", items: [listing] },
    analyses: [candidate], second: () => { throw new Error("NETWORK_LOST"); } });
  assert.ok(result.saves.some((save) => save.items.length === 1 &&
    save.candidates.length === 0));
});

test("verification challenge pauses with checkpoint and matched request counts", async () => {
  const candidate = { ...listing, referencePrice: 1000, sampleCount: 5,
    confidence: "HIGH", anomalyType: "POSSIBLE_MISSING_ZERO", ratio: 0.1 };
  const result = await runScenario({ first: { status: "COMPLETE", items: [listing] },
    analyses: [candidate], second: () => { throw new Error("請完成圖形驗證"); } });
  assert.equal(result.savedCheckpoint.phase, "VERIFYING");
  assert.equal(result.savedCheckpoint.nextIndex, 1);
  assert.deepEqual(result.savedCheckpoint.requestStats, { searches: 2, requests: 2 });
  assert.ok(result.events.some(({ name, value }) => name === "scan-state" && value === "paused"));
  assert.ok(result.events.some(({ name, value }) => name === "scan-status" &&
    value.message.includes("官方查詢請求 2 次")));
});

test("verification resumes from its saved snapshot after a network interruption", async () => {
  const candidate = { ...listing, referencePrice: 1000, sampleCount: 5,
    confidence: "HIGH", anomalyType: "POSSIBLE_MISSING_ZERO", ratio: 0.1 };
  const result = await runScenario({ first: { status: "COMPLETE", items: [listing] },
    analyses: [candidate], resumeAfterFailure: true,
    second: (options, call) => {
      if (call === 2) throw new Error("NETWORK_LOST");
      options.targets[0]._confirmed = true;
      return { status: "COMPLETE", items: [listing] };
    } });
  assert.equal(result.searches, 3);
  assert.ok(result.saves.some((save) => save.candidates.length === 1));
});

test("crash after the last keyword resumes without repeating the first pass", async () => {
  const result = await runScenario({ first: null, second: () => {
    throw new Error("first pass must not repeat");
  }, checkpoint: { keywords: ["Stone"], listings: [listing],
    pageStatuses: ["COMPLETE"], nextIndex: 1, phase: "SCANNING", runId: 7 } });
  assert.equal(result.searches, 0);
  assert.ok(result.saves.some((save) => save.items.length === 1));
});

test("listing sold between scan and verification cannot become an alert", async () => {
  const candidate = { ...listing, referencePrice: 1000, sampleCount: 5,
    confidence: "HIGH", anomalyType: "POSSIBLE_MISSING_ZERO", ratio: 0.1 };
  const result = await runScenario({ first: { status: "COMPLETE", items: [listing] },
    analyses: [candidate], second: () => ({ status: "COMPLETE", items: [] }) });
  assert.equal(result.unavailable.length, 1);
  assert.ok(result.saves.every((save) => save.candidates.length === 0));
});
