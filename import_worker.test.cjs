const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { MarketStore } = require("./store.cjs");

test("large authorized import runs in a worker and commits a consistent batch", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-worker-"));
  const filename = path.join(directory, "market.sqlite");
  const store = new MarketStore(filename);
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    serverId: 529, itemName: "魔靈石", shop: `店${index}`, price: 100 + index,
    quantity: 1, storeType: "販售", observedAt: new Date().toISOString(),
    sourceListingId: String(index), sourceId: "bulk-import"
  }));
  try {
    const message = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "import_worker.cjs"), { workerData: {
        filename, input: { sourceId: "bulk-import", authorizationReference: "owned file",
          format: "json", content: JSON.stringify(rows) }, ratio: 0.15
      } });
      let result;
      worker.once("message", (value) => { result = value; });
      worker.once("exit", (code) => code === 0 ? resolve(result) : reject(new Error("worker failed")));
      worker.once("error", reject);
    });
    assert.equal(message.ok, true, message.error);
    assert.equal(message.report.inserted, 1000);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM source_observations").get().count, 1000);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("invalid worker import records a failed job without partial observations", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roz-worker-fail-"));
  const filename = path.join(directory, "market.sqlite");
  const store = new MarketStore(filename);
  try {
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "import_worker.cjs"), { workerData: {
        filename, input: { sourceId: "bad-file", authorizationReference: "owned file",
          format: "json", content: "{" }, ratio: 0.15
      } });
      let message;
      worker.once("message", (value) => { message = value; });
      worker.once("exit", (code) => code === 0 ? resolve(message) : reject(new Error("worker failed")));
      worker.once("error", reject);
    });
    assert.equal(result.ok, false);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM source_observations").get().count, 0);
    assert.equal(store.db.prepare("SELECT status FROM sync_jobs WHERE source_id='bad-file'").get().status,
      "FAILED");
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
