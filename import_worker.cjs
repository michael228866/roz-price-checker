const { parentPort, workerData } = require("node:worker_threads");
const { MarketStore } = require("./store.cjs");
const { AuthorizedFileAdapter } = require("./source_import.cjs");

let store;
let adapter;
try {
  const { filename, input, ratio } = workerData;
  adapter = new AuthorizedFileAdapter(input.sourceId, input.authorizationReference);
  adapter.validateConfiguration();
  store = new MarketStore(filename);
  const batch = adapter.fetchOrImport(input.content, input.format);
  parentPort.postMessage({ ok: true,
    report: store.importSourceObservations(adapter, batch, ratio) });
} catch (error) {
  if (store && adapter) {
    const category = error instanceof SyntaxError || error instanceof TypeError ||
      error instanceof RangeError ? "VALIDATION_FAILED" : "IMPORT_FAILED";
    try { store.recordImportFailure(adapter, category); } catch { /* Preserve original error. */ }
  }
  parentPort.postMessage({ ok: false, error: error.message });
} finally { store?.close(); }
