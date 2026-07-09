import { FitAddon } from "@xterm/addon-fit"
import { Terminal as XTerm } from "@xterm/xterm"
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react"
import { type CSSProperties, createElement, useCallback, useEffect, useRef, useState } from "react"
import "@xterm/xterm/css/xterm.css"
import type { TabExtensionDefinition, TabRenderContext } from "../../tab-sdk"
import { FilePreviewTab, FileTreeTab } from "./FilesTab"

type BrowserTabState = {
  url?: string
  history?: string[]
  historyIndex?: number
  webContentsId?: number
}

type TerminalTabState = {
  terminalSessionId?: string | null
}

type BrowserWebviewElement = HTMLElement & {
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  getWebContentsId?: () => number
  getURL?: () => string
  goBack?: () => void
  goForward?: () => void
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>
  loadURL?: (url: string, options?: { userAgent?: string }) => Promise<void> | void
  reload?: () => void
}

type BrowserLoadErrorEvent = Event & {
  errorCode?: number
  errorDescription?: string
  isMainFrame?: boolean
  validatedURL?: string
}

const BROWSER_CHROME_FALLBACK_COLOR = "#15161a"
const BROWSER_CHROME_COLOR_SCRIPT = String.raw`
(() => {
  const fallback = "${BROWSER_CHROME_FALLBACK_COLOR}";
  const isVisibleColor = (color) => {
    if (!color || color === "transparent") {
      return false;
    }

    const rgba = color.match(/^rgba?\((.+)\)$/);
    if (!rgba) {
      return true;
    }

    const alpha = rgba[1].split(",").map((part) => part.trim())[3];
    return alpha == null || Number.parseFloat(alpha) > 0.05;
  };
  const supportsColor = (color) =>
    typeof CSS === "undefined" || CSS.supports("color", color);
  const themeColor = Array.from(document.querySelectorAll('meta[name="theme-color"]'))
    .map((meta) => ({
      color: meta.getAttribute("content")?.trim(),
      media: meta.getAttribute("media")?.trim(),
    }))
    .find(({ color, media }) => {
      if (!color || !supportsColor(color)) {
        return false;
      }

      return !media || matchMedia(media).matches;
    })?.color;

  if (themeColor) {
    return themeColor;
  }

  const width = Math.max(document.documentElement.clientWidth, innerWidth, 1);
  const points = [0.08, 0.5, 0.92].flatMap((xRatio) =>
    [0, 8, 24, 48, 80].map((y) => [Math.round(width * xRatio), y]),
  );

  for (const [x, y] of points) {
    for (const element of document.elementsFromPoint(x, y)) {
      const color = getComputedStyle(element).backgroundColor;

      if (isVisibleColor(color)) {
        return color;
      }
    }
  }

  for (const element of [document.body, document.documentElement]) {
    if (!element) {
      continue;
    }

    const color = getComputedStyle(element).backgroundColor;

    if (isVisibleColor(color)) {
      return color;
    }
  }

  return fallback;
})()
`

type ColorChannels = {
  r: number
  g: number
  b: number
}

function updateTabState(context: TabRenderContext, state: Record<string, unknown>): void {
  context.dispatch({
    ...context.commandContext,
    type: "tab.updateState",
    paneId: context.paneId,
    tabId: context.tab.id,
    state,
  })
}

function normalizeUrl(url: string): string {
  if (/^https?:\/\//.test(url)) {
    return url
  }

  return `https://${url}`
}

function isElectronRuntime(apiPlatform: string): boolean {
  if (apiPlatform !== "browser") {
    return true
  }

  return typeof navigator !== "undefined" && /\bElectron\//.test(navigator.userAgent)
}

function getBrowserUserAgent(): string | undefined {
  if (typeof navigator === "undefined") {
    return undefined
  }

  const withoutElectron = navigator.userAgent.replace(/\sElectron\/[^\s]+/g, "")
  return withoutElectron === navigator.userAgent ? undefined : withoutElectron
}

function getLoadErrorMessage(event: BrowserLoadErrorEvent): string {
  const description = event.errorDescription ?? "Navigation failed"
  const url = event.validatedURL ? ` (${event.validatedURL})` : ""
  const code = typeof event.errorCode === "number" ? ` [${event.errorCode}]` : ""

  return `${description}${code}${url}`
}

function normalizeBrowserChromeColor(color: unknown): string | null {
  if (typeof color !== "string") {
    return null
  }

  const trimmedColor = color.trim()

  if (!trimmedColor || trimmedColor === "transparent") {
    return null
  }

  if (typeof CSS !== "undefined" && !CSS.supports("color", trimmedColor)) {
    return null
  }

  return trimmedColor
}

function getColorChannels(color: string): ColorChannels | null {
  const rgbMatch = color.match(/^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/)

  if (rgbMatch) {
    return {
      r: Number(rgbMatch[1]),
      g: Number(rgbMatch[2]),
      b: Number(rgbMatch[3]),
    }
  }

  const hexMatch = color.match(/^#([\da-f]{3}|[\da-f]{6})$/i)

  if (hexMatch) {
    const hex = hexMatch[1]
    const expandedHex =
      hex.length === 3
        ? hex
            .split("")
            .map((digit) => `${digit}${digit}`)
            .join("")
        : hex

    return {
      r: Number.parseInt(expandedHex.slice(0, 2), 16),
      g: Number.parseInt(expandedHex.slice(2, 4), 16),
      b: Number.parseInt(expandedHex.slice(4, 6), 16),
    }
  }

  if (typeof document === "undefined" || !document.body) {
    return null
  }

  const probe = document.createElement("span")
  probe.style.color = color

  if (!probe.style.color) {
    return null
  }

  probe.style.display = "none"
  document.body.append(probe)
  const computedColor = getComputedStyle(probe).color
  probe.remove()

  return computedColor === color ? null : getColorChannels(computedColor)
}

function getBrowserChromeForeground(backgroundColor: string): string {
  const channels = getColorChannels(backgroundColor)

  if (!channels) {
    return "#f2f4f6"
  }

  const toLinear = (channel: number): number => {
    const normalized = channel / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  const luminance =
    0.2126 * toLinear(channels.r) + 0.7152 * toLinear(channels.g) + 0.0722 * toLinear(channels.b)

  return luminance > 0.48 ? "#111316" : "#f2f4f6"
}

function BrowserTab(context: TabRenderContext): React.JSX.Element {
  const state = context.tab.state as BrowserTabState
  const initialUrl = state.url ?? "https://example.com"
  const isElectron = isElectronRuntime(context.api.platform)
  const webviewRef = useRef<BrowserWebviewElement | null>(null)
  const [address, setAddress] = useState(initialUrl)
  const [url, setUrl] = useState(initialUrl)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [chromeColor, setChromeColor] = useState(BROWSER_CHROME_FALLBACK_COLOR)
  const [webviewNavigationState, setWebviewNavigationState] = useState({
    canGoBack: false,
    canGoForward: false,
  })
  const browserUserAgent = getBrowserUserAgent()
  const browserStyle = {
    "--browser-chrome-color": chromeColor,
    "--browser-chrome-foreground": getBrowserChromeForeground(chromeColor),
  } as CSSProperties
  const history = state.history ?? [initialUrl]
  const historyIndex = state.historyIndex ?? 0
  const canGoBack = isElectron ? webviewNavigationState.canGoBack : historyIndex > 0
  const canGoForward = isElectron
    ? webviewNavigationState.canGoForward
    : historyIndex < history.length - 1

  const updateWebviewNavigationState = useCallback(() => {
    const webview = webviewRef.current

    setWebviewNavigationState({
      canGoBack: webview?.canGoBack?.() ?? false,
      canGoForward: webview?.canGoForward?.() ?? false,
    })
  }, [])

  function navigate(nextUrl: string, replace = false): void {
    const normalizedUrl = normalizeUrl(nextUrl)

    if (isElectron) {
      setLoadError(null)
      setUrl(normalizedUrl)
      setAddress(normalizedUrl)
      const load = webviewRef.current?.loadURL?.(normalizedUrl, { userAgent: browserUserAgent })

      if (load) {
        void load.catch((caughtError: unknown) => {
          setLoadError(caughtError instanceof Error ? caughtError.message : "Navigation failed")
        })
      }

      updateTabState(context, { url: normalizedUrl })
      return
    }

    const nextHistory = replace ? [...history] : history.slice(0, historyIndex + 1)
    const nextIndex = replace ? historyIndex : nextHistory.length

    nextHistory[nextIndex] = normalizedUrl
    setUrl(normalizedUrl)
    setAddress(normalizedUrl)
    updateTabState(context, { url: normalizedUrl, history: nextHistory, historyIndex: nextIndex })
  }

  function moveHistory(delta: number): void {
    const nextIndex = historyIndex + delta
    const nextUrl = history[nextIndex]

    if (!nextUrl) {
      return
    }

    setUrl(nextUrl)
    setAddress(nextUrl)
    updateTabState(context, { url: nextUrl, history, historyIndex: nextIndex })
  }

  function goBack(): void {
    if (isElectron) {
      webviewRef.current?.goBack?.()
      return
    }

    moveHistory(-1)
  }

  function goForward(): void {
    if (isElectron) {
      webviewRef.current?.goForward?.()
      return
    }

    moveHistory(1)
  }

  function reload(): void {
    if (isElectron) {
      setLoadError(null)
      webviewRef.current?.reload?.()
      return
    }

    navigate(url, true)
  }

  useEffect(() => {
    if (!isElectron) {
      return
    }

    const webview = webviewRef.current

    if (!webview) {
      return
    }

    const syncUrl = (event: Event): void => {
      const nextUrl =
        "url" in event && typeof event.url === "string" ? event.url : (webview.getURL?.() ?? url)
      setLoadError(null)
      setUrl(nextUrl)
      setAddress(nextUrl)
      updateWebviewNavigationState()
      updateTabState(context, { url: nextUrl })
    }
    const syncNavigationState = (): void => {
      updateWebviewNavigationState()
    }
    const syncWebContentsId = (): void => {
      let webContentsId: number | undefined

      try {
        webContentsId = webview.getWebContentsId?.()
      } catch {
        return
      }

      if (typeof webContentsId === "number" && state.webContentsId !== webContentsId) {
        updateTabState(context, { webContentsId })
      }
    }
    const syncChromeColor = (): void => {
      const chromeColorResult = webview.executeJavaScript?.(BROWSER_CHROME_COLOR_SCRIPT)

      if (!chromeColorResult) {
        setChromeColor(BROWSER_CHROME_FALLBACK_COLOR)
        return
      }

      void chromeColorResult
        .then((nextColor) => {
          setChromeColor(normalizeBrowserChromeColor(nextColor) ?? BROWSER_CHROME_FALLBACK_COLOR)
        })
        .catch(() => {
          setChromeColor(BROWSER_CHROME_FALLBACK_COLOR)
        })
    }
    const syncLoadError = (event: Event): void => {
      const loadEvent = event as BrowserLoadErrorEvent

      if (loadEvent.isMainFrame === false) {
        return
      }

      setLoadError(getLoadErrorMessage(loadEvent))
      setChromeColor(BROWSER_CHROME_FALLBACK_COLOR)
      updateWebviewNavigationState()
    }
    const syncStopLoading = (): void => {
      syncNavigationState()
      syncWebContentsId()
      syncChromeColor()
    }

    webview.addEventListener("dom-ready", syncChromeColor)
    webview.addEventListener("dom-ready", syncWebContentsId)
    webview.addEventListener("did-navigate", syncUrl)
    webview.addEventListener("did-navigate-in-page", syncUrl)
    webview.addEventListener("did-fail-load", syncLoadError)
    webview.addEventListener("did-stop-loading", syncStopLoading)

    return () => {
      webview.removeEventListener("dom-ready", syncChromeColor)
      webview.removeEventListener("dom-ready", syncWebContentsId)
      webview.removeEventListener("did-navigate", syncUrl)
      webview.removeEventListener("did-navigate-in-page", syncUrl)
      webview.removeEventListener("did-fail-load", syncLoadError)
      webview.removeEventListener("did-stop-loading", syncStopLoading)
    }
  }, [context, isElectron, state.webContentsId, updateWebviewNavigationState, url])

  return (
    <div className="tab-surface browser-tab" style={browserStyle}>
      <header className="browser-toolbar">
        <button disabled={!canGoBack} onClick={goBack} title="Back" type="button">
          <ArrowLeft size={15} />
        </button>
        <button disabled={!canGoForward} onClick={goForward} title="Forward" type="button">
          <ArrowRight size={15} />
        </button>
        <button onClick={reload} title="Reload" type="button">
          <RefreshCw size={15} />
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            navigate(address)
          }}
        >
          <input
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                navigate(event.currentTarget.value)
              }
            }}
            value={address}
          />
        </form>
      </header>
      {isElectron ? (
        <>
          {createElement("webview", {
            allowpopups: "true",
            className: "browser-frame browser-webview",
            "data-browser-host": "electron-webview",
            partition: `persist:${context.tab.id}`,
            ref: webviewRef,
            src: url,
            useragent: browserUserAgent,
            webpreferences: "contextIsolation=yes,nodeIntegration=no,sandbox=yes",
          })}
          {loadError ? <p className="browser-load-error">{loadError}</p> : null}
        </>
      ) : (
        <section className="browser-preview-unavailable">
          <h2>Browser preview unavailable</h2>
          <p>
            External sites render in the Electron window. The localhost preview will not frame them.
          </p>
          <a href={url} rel="noreferrer" target="_blank">
            {url}
          </a>
        </section>
      )}
    </div>
  )
}

function TerminalTab(context: TabRenderContext): React.JSX.Element {
  const state = context.tab.state as TerminalTabState
  const terminalElementRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: terminal session lifecycle is keyed to the workspace directory.
  useEffect(() => {
    const terminalElement = terminalElementRef.current

    if (!terminalElement) {
      return
    }

    let unsubscribe = (): void => {}
    let resizeObserver: ResizeObserver | null = null
    let disposed = false
    const terminal = new XTerm({
      allowTransparency: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      macOptionIsMeta: true,
      scrollback: 10_000,
      theme: {
        background: "#0f1013",
        black: "#0f1013",
        blue: "#6d8fff",
        brightBlack: "#5f646d",
        brightBlue: "#8ba5ff",
        brightCyan: "#77d9d7",
        brightGreen: "#78dba9",
        brightMagenta: "#d78cff",
        brightRed: "#ff8b8f",
        brightWhite: "#ffffff",
        brightYellow: "#f0c878",
        cursor: "#d9dce1",
        cyan: "#62c9c6",
        foreground: "#d9dce1",
        green: "#6dd6a5",
        magenta: "#c678dd",
        red: "#f2777a",
        selectionBackground: "#2c365e",
        white: "#d9dce1",
        yellow: "#e4b363",
      },
    })
    const fitAddon = new FitAddon()

    terminalRef.current = terminal
    terminal.loadAddon(fitAddon)
    terminal.open(terminalElement)
    fitAddon.fit()
    terminal.focus()

    terminal.onData((data) => {
      const sessionId = sessionIdRef.current

      if (sessionId) {
        context.api.terminal.input({ sessionId, data })
      }
    })

    async function startSession(): Promise<void> {
      try {
        const session = await context.api.terminal.create({
          workspaceDirectory: context.workspace.directory,
          cols: terminal.cols,
          rows: terminal.rows,
        })

        if (disposed) {
          context.api.terminal.close({ sessionId: session.sessionId })
          return
        }

        sessionIdRef.current = session.sessionId
        if (state.terminalSessionId !== session.sessionId) {
          updateTabState(context, { terminalSessionId: session.sessionId })
        }
        unsubscribe = context.api.terminal.onEvent(session.sessionId, (event) => {
          if (event.type === "data") {
            terminal.write(event.data)
            return
          }

          terminal.writeln(`\r\n\x1b[38;5;245mProcess exited with ${event.exitCode}\x1b[0m`)
        })
      } catch (caughtError) {
        const message = caughtError instanceof Error ? caughtError.message : "Terminal failed."
        setError(message)
        terminal.writeln(`\x1b[31m${message}\x1b[0m`)
      }
    }

    resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      const sessionId = sessionIdRef.current

      if (sessionId) {
        context.api.terminal.resize({
          sessionId,
          cols: terminal.cols,
          rows: terminal.rows,
        })
      }
    })
    resizeObserver.observe(terminalElement)
    void startSession()

    return () => {
      disposed = true
      unsubscribe()
      resizeObserver?.disconnect()

      if (sessionIdRef.current) {
        context.api.terminal.close({ sessionId: sessionIdRef.current })
        updateTabState(context, { terminalSessionId: null })
      }

      sessionIdRef.current = null
      terminalRef.current = null
      terminal.dispose()
    }
  }, [context.api.terminal, context.workspace.directory])

  return (
    <div className="tab-surface terminal-tab">
      <div className="terminal-emulator" ref={terminalElementRef} />
      {error ? <p className="inline-error">{error}</p> : null}
    </div>
  )
}

export const coreExtension: TabExtensionDefinition = {
  id: "core",
  title: "Core",
  description: "Built-in workspace primitives.",
  tabs: [
    {
      id: "core.browser",
      extensionId: "core",
      title: "Browser",
      description: "Single-page browser with shell-level tabs.",
      state: {
        url: "https://example.com",
      },
      render: BrowserTab,
    },
    {
      id: "core.terminal",
      extensionId: "core",
      title: "Terminal",
      description: "Run shell commands in the workspace directory.",
      render: TerminalTab,
    },
    {
      id: "core.files",
      extensionId: "core",
      title: "File Tree",
      description: "Browse workspace files and open previews.",
      render: FileTreeTab,
    },
    {
      id: "core.filePreview",
      extensionId: "core",
      title: "File Preview",
      description: "Preview a workspace file.",
      render: FilePreviewTab,
    },
  ],
}
