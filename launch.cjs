const { spawnSync } = require("node:child_process");
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

function launch(run = spawnSync) {
  const electronExe = require("electron");
  if (existingInstanceCount(electronExe, run) > 0) {
    process.stdout.write("ROZ 查價器已在執行，請切換至已開啟的視窗。\n");
    return 0;
  }
  const child = run(electronExe, ["."], { cwd: path.resolve(__dirname), stdio: "inherit" });
  if (child.error) throw child.error;
  return child.status ?? 1;
}

if (require.main === module) {
  try { process.exitCode = launch(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { existingInstanceCount, launch };
