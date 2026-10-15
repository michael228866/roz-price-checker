const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shopAlert", {
  openShop: () => ipcRenderer.invoke("open-shop"),
  startScanning: (config) => ipcRenderer.invoke("start-scanning", config),
  openLocalMarket: () => ipcRenderer.invoke("open-local-market"),
  importMarketFile: (input) => ipcRenderer.invoke("import-market-file", input),
  retryUncertainAlert: (key) => ipcRenderer.invoke("retry-uncertain-alert", key),
  resumeScanning: () => ipcRenderer.invoke("resume-scanning"),
  stopScanning: () => ipcRenderer.invoke("stop-scanning"),
  showShop: () => ipcRenderer.invoke("show-shop"),
  importCatalog: (csv) => ipcRenderer.invoke("import-catalog", csv),
  marketStatus: () => ipcRenderer.invoke("market-status"),
  setDiscord: (url) => ipcRenderer.invoke("set-discord", url),
  discordStatus: () => ipcRenderer.invoke("discord-status"),
  copyNavigation: (command) => ipcRenderer.invoke("copy-navigation", command),
  onStatus: (callback) => ipcRenderer.on("scan-status", (_event, value) => callback(value)),
  onState: (callback) => ipcRenderer.on("scan-state", (_event, value) => callback(value)),
  onResults: (callback) => ipcRenderer.on("scan-results", (_event, value) => callback(value)),
  onMarketStatus: (callback) => ipcRenderer.on("market-status", (_event, value) => callback(value))
});
