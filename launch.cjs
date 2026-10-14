const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function existingInstanceCount(electronExe, run = spawnSync) {
  if (process.platform !== "win32") return 0;
  const command = `@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
    Where-Object { $_.ExecutablePath -eq $env:ROZ_ELECTRON_EXE -and
      $_.CommandLine -notmatch '--type=' }).Count`;
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, ROZ_ELECTRON_EXE: electronExe }
  });
  const count = Number(result.stdout?.trim());
  if (result.error || result.status !== 0 || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("無法確認程式是否已在執行，請先關閉其他視窗再啟動。");
  }
  return count;
}

function launch(run = spawnSync, start = spawn) {
  const electronExe = require("electron");
  if (existingInstanceCount(electronExe, run) > 0) {
    process.stdout.write("ROZ 查價器已在執行，請切換至已開啟的視窗。\n");
    return 0;
  }
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const logPath = path.join(process.env.APPDATA || __dirname,
    "roz-shop-price-alert", "startup.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, "a");
  let child;
  try {
    child = start(electronExe, ["."], {
      cwd: path.resolve(__dirname), detached: true,
      stdio: ["ignore", log, log], windowsHide: true, env: environment
    });
  } finally { fs.closeSync(log); }
  if (!child.pid) throw new Error("Electron 啟動失敗。");
  child.once("error", (error) => process.stderr.write(`Electron 啟動失敗：${error.message}\n`));
  child.unref();
  process.stdout.write("ROZ 查價器已啟動；BAT 視窗可直接關閉。\n");
  return 0;
}

if (require.main === module) {
  try { process.exitCode = launch(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { existingInstanceCount, launch };
