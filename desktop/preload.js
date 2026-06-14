const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("poly", {
  status: () => ipcRenderer.invoke("status"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  saveKey: (k) => ipcRenderer.invoke("save-key", k),
  listFiles: (dir) => ipcRenderer.invoke("list-files", dir),
  readFile: (file) => ipcRenderer.invoke("read-file", file),
  capture: (file) => ipcRenderer.invoke("capture", file),
  runAgent: (goal, cwd) => ipcRenderer.send("run-agent", { goal, cwd }),
  setupLocal: () => ipcRenderer.send("setup-local"),
  onEvent: (cb) => ipcRenderer.on("agent-event", (_e, ev) => cb(ev)),
  onLog: (cb) => ipcRenderer.on("agent-log", (_e, s) => cb(s)),
  onAuto: (cb) => ipcRenderer.on("auto", (_e, a) => cb(a)),
});
