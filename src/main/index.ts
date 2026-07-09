import { join } from "node:path"
import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  shell,
} from "electron"
import { ENSEMBLE_CONTROL_DEFAULT_URL } from "../shared/ensembleControl"
import { initializeEnsembleCore } from "./ensembleCore"
import { ensureTestWorkspace, registerRuntimeIpc, startRuntimeHttpServer } from "./workspaceRuntime"

const isMac = process.platform === "darwin"
const APP_NAME = "Ensemble"
let mainWindow: BrowserWindow | null = null

type AppShortcut =
  | { type: "tab.close" }
  | { type: "tab.new" }
  | { type: "tab.next" }
  | { type: "tab.previous" }
  | { type: "tab.select"; index: number }

app.setName(APP_NAME)

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
}

function getAppIconPath(): string {
  return join(app.getAppPath(), "assets", "ensemble-icon.png")
}

function shortcutFromInput(input: Electron.Input): AppShortcut | null {
  if (input.type !== "keyDown" || input.isComposing) {
    return null
  }

  const key = input.key.toLowerCase()
  const hasPrimaryModifier = isMac ? input.meta : input.control
  const hasOnlyPrimaryModifier =
    hasPrimaryModifier && !input.alt && !input.shift && (isMac ? !input.control : !input.meta)
  const hasPrimaryShift =
    hasPrimaryModifier && input.shift && !input.alt && (isMac ? !input.control : !input.meta)

  if (hasOnlyPrimaryModifier && key === "w") {
    return { type: "tab.close" }
  }

  if (hasOnlyPrimaryModifier && key === "t") {
    return { type: "tab.new" }
  }

  if (hasPrimaryShift && (key === "]" || key === "}")) {
    return { type: "tab.next" }
  }

  if (hasPrimaryShift && (key === "[" || key === "{")) {
    return { type: "tab.previous" }
  }

  if (hasOnlyPrimaryModifier && /^[1-9]$/.test(key)) {
    return { type: "tab.select", index: Number(key) - 1 }
  }

  if (!input.meta && input.control && !input.alt && key === "tab") {
    return { type: input.shift ? "tab.previous" : "tab.next" }
  }

  return null
}

function configureApplicationMenu(): void {
  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: APP_NAME,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : []

  const windowMenu: MenuItemConstructorOptions[] = [{ role: "minimize" }, { role: "zoom" }]

  if (isMac) {
    windowMenu.push({ role: "front" })
  }

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: windowMenu,
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: APP_NAME,
    icon: getAppIconPath(),
    backgroundColor: "#101113",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  })
  mainWindow = window

  window.webContents.on("before-input-event", (event, input) => {
    const shortcut = shortcutFromInput(input)

    if (!shortcut) {
      return
    }

    event.preventDefault()
    window.webContents.send("app:shortcut", shortcut)
  })

  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.contextIsolation = true
    webPreferences.nodeIntegration = false
    webPreferences.sandbox = true

    if (!params.src || !/^https?:\/\//.test(params.src)) {
      event.preventDefault()
    }
  })

  window.once("ready-to-show", () => {
    window.show()
  })

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"))
  }
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    await ensureTestWorkspace()
    await initializeEnsembleCore({ controlUrl: ENSEMBLE_CONTROL_DEFAULT_URL })
    registerRuntimeIpc()
    startRuntimeHttpServer()
    app.setAboutPanelOptions({ applicationName: APP_NAME })
    configureApplicationMenu()
    const appIcon = nativeImage.createFromPath(getAppIconPath())

    if (!appIcon.isEmpty()) {
      app.dock?.setIcon(appIcon)
    }

    createWindow()

    app.on("second-instance", () => {
      if (!mainWindow) {
        createWindow()
        return
      }

      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }

      mainWindow.focus()
    })

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
}

app.on("window-all-closed", () => {
  if (!isMac) {
    app.quit()
  }
})
