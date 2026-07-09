import { contextBridge, ipcRenderer } from "electron"

const appShell = {
  platform: process.platform,
  testWorkspaceRoot: ".superapp-test-workspace",
  shortcuts: {
    onShortcut: (callback: (shortcut: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(payload)
      }

      ipcRenderer.on("app:shortcut", listener)
      return () => ipcRenderer.removeListener("app:shortcut", listener)
    },
  },
  ensemble: {
    getState: () => ipcRenderer.invoke("ensemble:state"),
    dispatch: (input: unknown) => ipcRenderer.invoke("ensemble:dispatch", input),
    onEvent: (callback: (event: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        callback(payload)
      }

      ipcRenderer.on("ensemble:event", listener)
      return () => ipcRenderer.removeListener("ensemble:event", listener)
    },
  },
  workspace: {
    chooseDirectory: () => ipcRenderer.invoke("workspace:choose-directory"),
  },
  chat: {
    complete: (input: unknown) => ipcRenderer.invoke("chat:complete", input),
  },
  agent: {
    send: (input: unknown) => ipcRenderer.invoke("agent:send", input),
    startTurn: (input: unknown) => ipcRenderer.invoke("agent:turn:start", input),
    interrupt: (input: unknown) => ipcRenderer.invoke("agent:turn:interrupt", input),
    respondApproval: (input: unknown) => ipcRenderer.invoke("agent:approval:respond", input),
    respondUserInput: (input: unknown) => ipcRenderer.invoke("agent:user-input:respond", input),
    onEvent: (sessionId: string, callback: (event: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { sessionId: string }) => {
        if (payload.sessionId === sessionId) {
          callback(payload)
        }
      }

      ipcRenderer.on("agent:event", listener)
      return () => ipcRenderer.removeListener("agent:event", listener)
    },
  },
  files: {
    tree: (input: unknown) => ipcRenderer.invoke("files:tree", input),
    list: (input: unknown) => ipcRenderer.invoke("files:list", input),
    read: (input: unknown) => ipcRenderer.invoke("files:read", input),
    write: (input: unknown) => ipcRenderer.invoke("files:write", input),
  },
  terminal: {
    run: (input: unknown) => ipcRenderer.invoke("terminal:run", input),
    create: (input: unknown) => ipcRenderer.invoke("terminal:session:create", input),
    input: (input: unknown) => ipcRenderer.send("terminal:session:input", input),
    resize: (input: unknown) => ipcRenderer.send("terminal:session:resize", input),
    close: (input: unknown) => ipcRenderer.send("terminal:session:close", input),
    onEvent: (sessionId: string, callback: (event: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { sessionId: string }) => {
        if (payload.sessionId === sessionId) {
          callback(payload)
        }
      }

      ipcRenderer.on("terminal:event", listener)
      return () => ipcRenderer.removeListener("terminal:event", listener)
    },
  },
  review: {
    get: (input: unknown) => ipcRenderer.invoke("review:get", input),
  },
}

contextBridge.exposeInMainWorld("appShell", appShell)

export type AppShellApi = typeof appShell
