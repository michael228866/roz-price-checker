const test = require("node:test");
const assert = require("node:assert/strict");
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

test("launcher detaches Electron from the BAT process", () => {
  let unref = false;
  let options;
  const count = () => ({ status: 0, stdout: "0" });
  const start = (_exe, args, value) => {
    assert.deepEqual(args, ["."]);
    options = value;
    return { pid: 123, once() {}, unref() { unref = true; } };
  };
  assert.equal(launch(count, start), 0);
  assert.equal(options.detached, true);
  assert.equal(options.stdio[0], "ignore");
  assert.equal(typeof options.stdio[1], "number");
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(unref, true);
});
