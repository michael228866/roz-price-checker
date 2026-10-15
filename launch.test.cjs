const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { existingInstanceCount, launch } = require("./launch.cjs");

test("launcher detects another main Electron process without starting a second one", () => {
  if (process.platform !== "win32") return;
  const count = existingInstanceCount("C:\\app\\electron.exe", (_command, _args, options) => {
    assert.equal(options.env.ROZ_ELECTRON_EXE, "C:\\app\\electron.exe");
    return { status: 0, stdout: "2\r\n" };
  });
  assert.equal(count, 2);
});

test("launcher refuses to proceed when process inspection fails", () => {
  if (process.platform !== "win32") return;
  assert.throws(() => existingInstanceCount("C:\\app\\electron.exe", () => ({
    status: 1, stdout: ""
  })), /無法確認程式是否已在執行/);
});

test("launcher reports a no-renderer process instead of claiming the UI is open", () => {
  if (process.platform !== "win32") return;
  assert.throws(() => existingInstanceCount("C:\\app\\electron.exe", () => ({
    status: 0, stdout: "STALE:12345\r\n"
  })), /PID 12345/);
});

test("launcher detaches Electron from the BAT process", () => {
  let unref = false;
  let options;
  const fileCalls = [];
  const fileSystem = {
    mkdirSync(...args) { fileCalls.push(["mkdir", ...args]); },
    openSync(...args) { fileCalls.push(["open", ...args]); return 42; },
    closeSync(...args) { fileCalls.push(["close", ...args]); }
  };
  const count = () => ({ status: 0, stdout: "0" });
  const start = (_exe, args, value) => {
    assert.deepEqual(args, ["."]);
    options = value;
    return { pid: 123, once() {}, unref() { unref = true; } };
  };
  assert.equal(launch(count, start, fileSystem), 0);
  assert.equal(options.detached, true);
  assert.equal(options.windowsHide, false);
  assert.equal(options.stdio[0], "ignore");
  assert.deepEqual(options.stdio, ["ignore", 42, 42]);
  assert.deepEqual(fileCalls[0], ["mkdir", path.dirname(fileCalls[1][1]), { recursive: true }]);
  assert.equal(path.basename(fileCalls[1][1]), "startup.log");
  assert.equal(fileCalls[1][2], "a");
  assert.deepEqual(fileCalls[2], ["close", 42]);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(unref, true);
});
