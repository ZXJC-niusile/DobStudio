const {
  contextBridge,
  ipcRenderer,
}: typeof import("electron") = require("electron");
import type { DesktopApi } from "@dobstudio/core/studio";
const invoke = (name: string, ...args: unknown[]) =>
  ipcRenderer.invoke(`studio:${name}`, ...args);
const api: DesktopApi = {
  snapshot: () => invoke("snapshot"),
  createProject: (s) => invoke("createProject", s),
  saveCues: (id, rev, cues) => invoke("saveCues", id, rev, cues),
  importSrt: (id, rev) => invoke("importSrt", id, rev),
  mediaUrl: (id) => invoke("mediaUrl", id),
  exportSrt: (id) => invoke("exportSrt", id),
  submit: (id, r) => invoke("submit", id, r),
  cancel: (id) => invoke("cancel", id),
  saveSettings: (s) => invoke("saveSettings", s),
  pick: (kind) => invoke("pick", kind),
  reveal: (path) => invoke("reveal", path),
  status: () => invoke("status"),
  install: (model) => invoke("install", model),
  onChange: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("studio:changed", listener);
    return () => ipcRenderer.removeListener("studio:changed", listener);
  },
};
contextBridge.exposeInMainWorld("dobstudio", api);
