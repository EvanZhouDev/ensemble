#!/usr/bin/env bun

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AgentTurnStartResult } from "../shared/agentEvents"
import { createEnsembleCliUsage } from "../shared/ensembleCliDocumentation"
import {
  ENSEMBLE_CONTROL_DEFAULT_URL,
  type EnsembleCommandRequest,
  type EnsembleCommandResponse,
  type EnsembleControlFile,
  type EnsembleSnapshot,
} from "../shared/ensembleControl"
import {
  collectPanes,
  EMPTY_TAB_TYPE_ID,
  findPane,
  getActiveTabId,
  getActiveView,
  getActiveWorkspace,
  getWorkspaceViewState,
  type PaneNode,
  type ShellCommand,
  type ShellView,
  type SplitDirection,
  type SplitPlacement,
  type Workspace,
  type WorkspaceTab,
} from "../shared/shellModel"

type FlagValue = string | true

type ParsedCli = {
  flags: Map<string, FlagValue>
  positionals: string[]
}

type CliContext = {
  snapshot: EnsembleSnapshot
  actorId: string
  view: ShellView
  workspace: Workspace
}

type BrowserRunResult = {
  tabId: string
  url: string
  result: unknown
}

type TerminalTabRunResult = {
  tabId: string
  sessionId: string
  command: string
  cwd: string
}

const defaultAgentBaseUrl = "http://127.0.0.1:10531/v1"
const defaultAgentModel = "gpt-5.5"

const tabTypeTitles: Record<string, string> = {
  [EMPTY_TAB_TYPE_ID]: "New Tab",
  "ai-agent.chat": "AI Chat",
  "ai-agent.review": "Review",
  "core.browser": "Browser",
  "core.terminal": "Terminal",
  "core.files": "Files",
  "core.filePreview": "File Preview",
}

function parseCli(argv: string[]): ParsedCli {
  const flags = new Map<string, FlagValue>()
  const positionals: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg.startsWith("--")) {
      const [rawName, rawValue] = arg.slice(2).split("=", 2)

      if (rawValue !== undefined) {
        flags.set(rawName, rawValue)
        continue
      }

      const nextArg = argv[index + 1]

      if (nextArg && !nextArg.startsWith("--")) {
        flags.set(rawName, nextArg)
        index += 1
        continue
      }

      flags.set(rawName, true)
      continue
    }

    positionals.push(arg)
  }

  return { flags, positionals }
}

function flagString(flags: Map<string, FlagValue>, name: string): string | null {
  const value = flags.get(name)

  if (typeof value !== "string" || value.trim().length === 0) {
    return null
  }

  return value
}

function flagBoolean(flags: Map<string, FlagValue>, name: string): boolean {
  return flags.get(name) === true
}

function defaultControlFilePath(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Ensemble", "control.json")
  }

  const configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(configRoot, "Ensemble", "control.json")
}

async function readControlUrl(flags: Map<string, FlagValue>): Promise<string> {
  const explicitUrl = flagString(flags, "url") ?? process.env.ENSEMBLE_CONTROL_URL

  if (explicitUrl) {
    return explicitUrl
  }

  const controlFilePath =
    flagString(flags, "control-file") ??
    process.env.ENSEMBLE_CONTROL_FILE ??
    defaultControlFilePath()

  try {
    const controlFile = JSON.parse(await readFile(controlFilePath, "utf8")) as EnsembleControlFile

    if (typeof controlFile.url === "string" && controlFile.url.length > 0) {
      return controlFile.url
    }
  } catch {
    // Fall through to the dev server default.
  }

  return ENSEMBLE_CONTROL_DEFAULT_URL
}

async function requestJson<TResult>(url: string, path: string, body?: unknown): Promise<TResult> {
  const response = await fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Request failed with ${response.status}`)
  }

  return response.json() as Promise<TResult>
}

async function loadSnapshot(url: string): Promise<EnsembleSnapshot> {
  return requestJson<EnsembleSnapshot>(url, "/ensemble/state")
}

async function dispatchCommand(
  url: string,
  request: EnsembleCommandRequest,
): Promise<EnsembleCommandResponse> {
  return requestJson<EnsembleCommandResponse>(url, "/ensemble/command", request)
}

function resolveContext(snapshot: EnsembleSnapshot, flags: Map<string, FlagValue>): CliContext {
  const state = snapshot.state
  const actorSelector =
    flagString(flags, "actor") ?? process.env.ENSEMBLE_ACTOR ?? state.activeActorId
  const actor = resolveActor(snapshot, actorSelector)

  const actorId = actor.id
  const explicitViewId = flagString(flags, "view") ?? process.env.ENSEMBLE_VIEW
  const view =
    state.views.find((item) => item.id === explicitViewId && item.actorId === actorId) ??
    state.views.find((item) => item.id === state.activeViewId && item.actorId === actorId) ??
    state.views.find((item) => item.actorId === actorId)

  if (!view) {
    throw new Error(`No view found for actor ${actorId}.`)
  }

  return {
    snapshot,
    actorId,
    view,
    workspace: getActiveWorkspace(state, view),
  }
}

function resolveActor(snapshot: EnsembleSnapshot, selector: string): { id: string; name: string } {
  const actor = snapshot.state.actors.find(
    (candidate) => candidate.id === selector || candidate.name === selector,
  )

  if (!actor) {
    throw new Error(`Actor not found: ${selector}`)
  }

  return actor
}

function resolvePane(context: CliContext, paneSelector: string | null): PaneNode {
  const viewState = getWorkspaceViewState(context.view, context.workspace)
  const panes = collectPanes(context.workspace.root)
  const selector = paneSelector ?? "focused"

  if (selector === "focused" || selector === "active") {
    const focusedPane = viewState.focusedPaneId
      ? panes.find((pane) => pane.id === viewState.focusedPaneId)
      : null

    if (focusedPane) {
      return focusedPane
    }
  }

  if (selector === "first") {
    const firstPane = panes[0]

    if (firstPane) {
      return firstPane
    }
  }

  const exactPane = findPane(context.workspace.root, selector)

  if (!exactPane) {
    throw new Error(`Pane not found: ${selector}`)
  }

  return exactPane
}

function resolveTab(
  context: CliContext,
  tabSelector: string | null,
  paneSelector: string | null,
): { pane: PaneNode; tab: WorkspaceTab } {
  const pane = resolvePane(context, paneSelector)
  const selector = tabSelector ?? "active"

  if (selector === "active") {
    const activeTabId = getActiveTabId(pane, getWorkspaceViewState(context.view, context.workspace))
    const activeTab = pane.tabs.find((tab) => tab.id === activeTabId)

    if (activeTab) {
      return { pane, tab: activeTab }
    }
  }

  const paneTab = pane.tabs.find((tab) => tab.id === selector || tab.title === selector)

  if (paneTab) {
    return { pane, tab: paneTab }
  }

  const matches = collectPanes(context.workspace.root).flatMap((candidatePane) =>
    candidatePane.tabs
      .filter((candidate) => candidate.id === selector || candidate.title === selector)
      .map((tab) => ({ pane: candidatePane, tab })),
  )

  if (matches.length === 1) {
    return matches[0]
  }

  if (matches.length > 1) {
    throw new Error(`Tab selector is ambiguous: ${selector}. Pass --pane <pane-id>.`)
  }

  throw new Error(`Tab not found: ${selector}`)
}

function resolveWorkspace(snapshot: EnsembleSnapshot, selector: string): Workspace {
  const workspace = snapshot.state.workspaces.find(
    (candidate) => candidate.id === selector || candidate.name === selector,
  )

  if (!workspace) {
    throw new Error(`Workspace not found: ${selector}`)
  }

  return workspace
}

function parseDirection(value: string | null): SplitDirection {
  if (value === "horizontal" || value === "vertical") {
    return value
  }

  throw new Error("Expected --direction horizontal|vertical.")
}

function parsePlacement(value: string | null): SplitPlacement {
  if (value === "before" || value === "after") {
    return value
  }

  throw new Error("Expected --placement before|after.")
}

function parseIndex(value: string | null, fallback: number): number {
  if (value === null) {
    return fallback
  }

  const index = Number.parseInt(value, 10)

  if (!Number.isFinite(index)) {
    throw new Error(`Invalid index: ${value}`)
  }

  return index
}

function parseStateJson(value: string | null): Record<string, unknown> | undefined {
  if (value === null) {
    return undefined
  }

  const parsed = JSON.parse(value) as unknown

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--state must be a JSON object.")
  }

  return parsed as Record<string, unknown>
}

function tabTitleForType(typeId: string, flags: Map<string, FlagValue>): string {
  return flagString(flags, "title") ?? tabTypeTitles[typeId] ?? typeId
}

function tabStateString(tab: WorkspaceTab, key: string, fallback: string): string {
  const value = tab.state[key]

  if (typeof value === "string" && value.trim().length > 0) {
    return value
  }

  return fallback
}

function tabStateOptionalString(tab: WorkspaceTab, key: string): string | undefined {
  const value = tab.state[key]

  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function chatAgentActorId(tab: WorkspaceTab): string {
  return tabStateOptionalString(tab, "agentActorId") ?? `agent-actor-${tab.id}`
}

function chatAgentViewId(tab: WorkspaceTab): string {
  return tabStateOptionalString(tab, "agentViewId") ?? `agent-view-${tab.id}`
}

function commandContext(context: CliContext): { actorId: string; viewId: string } {
  return {
    actorId: context.actorId,
    viewId: context.view.id,
  }
}

function isLocalActorContext(context: CliContext): boolean {
  return context.actorId === context.snapshot.state.actors[0]?.id
}

async function activateTabForContext(
  url: string,
  context: CliContext,
  pane: PaneNode,
  tab: WorkspaceTab,
): Promise<void> {
  const activeTabId = getActiveTabId(pane, getWorkspaceViewState(context.view, context.workspace))

  if (activeTabId === tab.id) {
    return
  }

  await dispatchCommand(url, {
    command: {
      ...commandContext(context),
      type: "tab.activate",
      paneId: pane.id,
      tabId: tab.id,
    },
  })
}

async function claimTabForAgentActor(
  url: string,
  context: CliContext,
  pane: PaneNode,
  tab: WorkspaceTab,
): Promise<void> {
  if (isLocalActorContext(context)) {
    return
  }

  await dispatchCommand(url, {
    command: {
      ...commandContext(context),
      type: "tab.updateState",
      paneId: pane.id,
      tabId: tab.id,
      state: {
        agentActorId: context.actorId,
        agentViewId: context.view.id,
      },
    },
  })
}

function createCommand(context: CliContext, cli: ParsedCli): ShellCommand {
  const [domain, action, firstArg] = cli.positionals
  const flags = cli.flags

  if (domain === "actor" && action === "create") {
    return {
      ...commandContext(context),
      type: "actor.create",
      name: firstArg ?? flagString(flags, "name") ?? undefined,
      workspaceId: flagString(flags, "workspace") ?? undefined,
    }
  }

  if (domain === "actor" && action === "activate") {
    const actor = resolveActor(context.snapshot, firstArg ?? flagString(flags, "actor") ?? "")
    const view =
      context.snapshot.state.views.find((item) => item.id === flagString(flags, "view")) ??
      context.snapshot.state.views.find((item) => item.actorId === actor.id)

    if (!view) {
      throw new Error(`No view found for actor ${actor.name}.`)
    }

    return {
      actorId: actor.id,
      viewId: view.id,
      type: "view.activate",
    }
  }

  if (domain === "workspace" && action === "create") {
    const directory = firstArg ?? flagString(flags, "directory") ?? undefined
    const name = flagString(flags, "name") ?? undefined

    return {
      ...commandContext(context),
      type: "workspace.create",
      directory,
      name,
    }
  }

  if (domain === "workspace" && action === "select") {
    const selector = firstArg

    if (!selector) {
      throw new Error("Usage: ensemble workspace select <workspace-id-or-name>")
    }

    return {
      ...commandContext(context),
      type: "workspace.select",
      workspaceId: resolveWorkspace(context.snapshot, selector).id,
    }
  }

  if (domain === "tab" && action === "new") {
    const pane = resolvePane(context, flagString(flags, "pane"))

    return {
      ...commandContext(context),
      type: "tab.create",
      paneId: pane.id,
    }
  }

  if (domain === "tab" && action === "open") {
    const tabTypeId = firstArg ?? EMPTY_TAB_TYPE_ID
    const pane = resolvePane(context, flagString(flags, "pane"))

    return {
      ...commandContext(context),
      type: "tab.open",
      paneId: pane.id,
      tabTypeId,
      title: tabTitleForType(tabTypeId, flags),
      state: parseStateJson(flagString(flags, "state")),
    }
  }

  if (domain === "tab" && action === "activate") {
    const resolved = resolveTab(context, firstArg ?? null, flagString(flags, "pane"))

    return {
      ...commandContext(context),
      type: "tab.activate",
      paneId: resolved.pane.id,
      tabId: resolved.tab.id,
    }
  }

  if (domain === "tab" && action === "close") {
    const resolved = resolveTab(context, firstArg ?? null, flagString(flags, "pane"))

    return {
      ...commandContext(context),
      type: "tab.close",
      paneId: resolved.pane.id,
      tabId: resolved.tab.id,
    }
  }

  if (domain === "tab" && action === "move") {
    const targetPane = resolvePane(context, flagString(flags, "to-pane"))
    const resolved = resolveTab(context, firstArg ?? null, flagString(flags, "from-pane"))

    return {
      ...commandContext(context),
      type: "tab.move",
      tabId: resolved.tab.id,
      sourcePaneId: resolved.pane.id,
      targetPaneId: targetPane.id,
      targetIndex: parseIndex(flagString(flags, "index"), targetPane.tabs.length),
    }
  }

  if (domain === "tab" && action === "split") {
    const targetPane = resolvePane(context, flagString(flags, "target-pane"))
    const resolved = resolveTab(context, firstArg ?? null, flagString(flags, "from-pane"))

    if (resolved.pane.id === targetPane.id && resolved.pane.tabs.length <= 1) {
      throw new Error("Cannot split the only tab in its own pane.")
    }

    return {
      ...commandContext(context),
      type: "tab.split",
      tabId: resolved.tab.id,
      sourcePaneId: resolved.pane.id,
      targetPaneId: targetPane.id,
      direction: parseDirection(flagString(flags, "direction")),
      placement: parsePlacement(flagString(flags, "placement")),
    }
  }

  throw new Error(`Unknown command: ${cli.positionals.join(" ") || "(none)"}`)
}

function formatPane(pane: PaneNode, view: ShellView, workspace: Workspace): string {
  const viewState = getWorkspaceViewState(view, workspace)
  const activeTabId = getActiveTabId(pane, viewState)
  const tabs = pane.tabs
    .map((tab) => {
      const marker = tab.id === activeTabId ? "*" : " "
      return `${marker}${tab.title} (${tab.typeId}) ${tab.id}`
    })
    .join("\n    ")

  return `  ${pane.id} (${pane.tabs.length} tab${pane.tabs.length === 1 ? "" : "s"})\n    ${tabs}`
}

function printStatus(snapshot: EnsembleSnapshot, context?: CliContext): void {
  const state = snapshot.state
  const actorId = context?.actorId ?? state.activeActorId
  const view = context?.view ?? getActiveView(state)
  const workspace = context?.workspace ?? getActiveWorkspace(state, view)
  const panes = collectPanes(workspace.root)

  console.log(`Ensemble Core v${snapshot.version}`)
  console.log(`actor ${actorId}`)
  console.log(`view ${view.id}`)
  console.log(`workspace ${workspace.name} ${workspace.id}`)
  console.log(`directory ${workspace.directory}`)
  console.log(`panes ${panes.length}`)
  console.log(panes.map((pane) => formatPane(pane, view, workspace)).join("\n"))
}

function printHelp(): void {
  console.log(createEnsembleCliUsage())
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

async function askAgent(
  url: string,
  context: CliContext,
  cli: ParsedCli,
): Promise<AgentTurnStartResult> {
  const [, , firstArg, ...messageParts] = cli.positionals
  const tabSelector = firstArg ?? flagString(cli.flags, "tab")

  if (!tabSelector) {
    throw new Error("Usage: ensemble agent ask <chat-tab-id-or-title> <prompt...>")
  }

  const resolved = resolveTab(context, tabSelector, flagString(cli.flags, "pane"))

  if (resolved.tab.typeId !== "ai-agent.chat") {
    throw new Error(`Tab is ${resolved.tab.typeId}, not ai-agent.chat.`)
  }

  const message = (flagString(cli.flags, "message") ?? messageParts.join(" ")).trim()

  if (!message) {
    throw new Error("Usage: ensemble agent ask <chat-tab-id-or-title> <prompt...>")
  }

  const actorId = chatAgentActorId(resolved.tab)
  const viewId = chatAgentViewId(resolved.tab)
  const baseUrl =
    flagString(cli.flags, "base-url") ??
    tabStateString(resolved.tab, "baseUrl", defaultAgentBaseUrl)
  const apiKey = flagString(cli.flags, "api-key") ?? tabStateString(resolved.tab, "apiKey", "")
  const model =
    flagString(cli.flags, "model") ?? tabStateString(resolved.tab, "model", defaultAgentModel)

  await dispatchCommand(url, {
    command: {
      ...commandContext(context),
      type: "actor.ensure",
      targetActorId: actorId,
      targetViewId: viewId,
      name: `${resolved.tab.title} Agent`,
      workspaceId: context.workspace.id,
      focusedPaneId: resolved.pane.id,
      activeTabId: resolved.tab.id,
    },
  })
  await dispatchCommand(url, {
    command: {
      ...commandContext(context),
      type: "tab.updateState",
      paneId: resolved.pane.id,
      tabId: resolved.tab.id,
      state: {
        agentActorId: actorId,
        agentViewId: viewId,
        baseUrl,
        apiKey,
        model,
      },
    },
  })

  return requestJson<AgentTurnStartResult>(url, "/agent/turn/start", {
    sessionId: resolved.tab.id,
    workspaceDirectory: context.workspace.directory,
    actorId,
    viewId,
    baseUrl,
    apiKey,
    model,
    message,
  })
}

async function runBrowser(
  url: string,
  context: CliContext,
  cli: ParsedCli,
): Promise<BrowserRunResult> {
  const [, , firstArg, ...restArgs] = cli.positionals
  const explicitTabSelector = flagString(cli.flags, "tab")
  const explicitCode = flagString(cli.flags, "code")
  const tabSelector =
    explicitTabSelector ??
    (explicitCode ? (firstArg ?? null) : restArgs.length > 0 ? firstArg : null)
  const code = (
    explicitCode ??
    (explicitTabSelector
      ? [firstArg, ...restArgs].filter(Boolean).join(" ")
      : restArgs.length > 0
        ? restArgs.join(" ")
        : (firstArg ?? ""))
  ).trim()

  if (!code) {
    throw new Error("Usage: ensemble browser run [tab] <javascript>")
  }

  const resolved = resolveTab(context, tabSelector, flagString(cli.flags, "pane"))

  if (resolved.tab.typeId !== "core.browser") {
    throw new Error(`Tab is ${resolved.tab.typeId}, not core.browser.`)
  }

  await activateTabForContext(url, context, resolved.pane, resolved.tab)
  await claimTabForAgentActor(url, context, resolved.pane, resolved.tab)

  return requestJson<BrowserRunResult>(url, "/browser/run", {
    tabId: resolved.tab.id,
    actorId: context.actorId,
    viewId: context.view.id,
    code,
    timeoutMs: parseIndex(flagString(cli.flags, "timeout-ms"), 10_000),
  })
}

async function runTerminal(
  url: string,
  context: CliContext,
  cli: ParsedCli,
): Promise<TerminalTabRunResult> {
  const [, , firstArg, ...restArgs] = cli.positionals
  const explicitTabSelector = flagString(cli.flags, "tab")
  const explicitCommand = flagString(cli.flags, "command")
  const tabSelector =
    explicitTabSelector ??
    (explicitCommand ? (firstArg ?? null) : restArgs.length > 0 ? firstArg : null)
  const command = (
    explicitCommand ??
    (explicitTabSelector
      ? [firstArg, ...restArgs].filter(Boolean).join(" ")
      : restArgs.length > 0
        ? restArgs.join(" ")
        : (firstArg ?? ""))
  ).trim()

  if (!command) {
    throw new Error("Usage: ensemble terminal run <command> --tab <terminal-tab>")
  }

  const resolved = resolveTab(context, tabSelector, flagString(cli.flags, "pane"))

  if (resolved.tab.typeId !== "core.terminal") {
    throw new Error(`Tab is ${resolved.tab.typeId}, not core.terminal.`)
  }

  await activateTabForContext(url, context, resolved.pane, resolved.tab)
  await claimTabForAgentActor(url, context, resolved.pane, resolved.tab)

  return requestJson<TerminalTabRunResult>(url, "/terminal/run", {
    tabId: resolved.tab.id,
    command,
    enter: !flagBoolean(cli.flags, "no-enter"),
  })
}

function listTabs(context: CliContext, json: boolean): void {
  const panes = collectPanes(context.workspace.root)
  const tabs = panes.flatMap((pane) => pane.tabs.map((tab) => ({ paneId: pane.id, ...tab })))

  if (json) {
    printJson(tabs)
    return
  }

  for (const tab of tabs) {
    console.log(`${tab.id}\t${tab.paneId}\t${tab.typeId}\t${tab.title}`)
  }
}

function listPanes(context: CliContext, json: boolean): void {
  const panes = collectPanes(context.workspace.root)

  if (json) {
    printJson(panes)
    return
  }

  for (const pane of panes) {
    console.log(`${pane.id}\t${pane.tabs.length} tabs`)
  }
}

function listWorkspaces(snapshot: EnsembleSnapshot, json: boolean): void {
  if (json) {
    printJson(snapshot.state.workspaces)
    return
  }

  for (const workspace of snapshot.state.workspaces) {
    const marker = workspace.id === getActiveView(snapshot.state).activeWorkspaceId ? "*" : " "
    console.log(`${marker} ${workspace.id}\t${workspace.name}\t${workspace.directory}`)
  }
}

function listActors(snapshot: EnsembleSnapshot, json: boolean): void {
  const actors = snapshot.state.actors.map((actor) => ({
    ...actor,
    views: snapshot.state.views.filter((view) => view.actorId === actor.id),
  }))

  if (json) {
    printJson(actors)
    return
  }

  for (const actor of actors) {
    const marker = actor.id === snapshot.state.activeActorId ? "*" : " "
    console.log(`${marker} ${actor.id}\t${actor.name}\t${actor.views.length} views`)
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  const [domain, action] = cli.positionals
  const json = flagBoolean(cli.flags, "json")

  if (!domain || domain === "help" || flagBoolean(cli.flags, "help")) {
    printHelp()
    return
  }

  const url = await readControlUrl(cli.flags)
  const snapshot = await loadSnapshot(url)

  if (domain === "status") {
    if (json) {
      printJson(snapshot)
      return
    }

    printStatus(snapshot, resolveContext(snapshot, cli.flags))
    return
  }

  if (domain === "state") {
    printJson(snapshot)
    return
  }

  const context = resolveContext(snapshot, cli.flags)

  if (domain === "actor" && action === "list") {
    listActors(snapshot, json)
    return
  }

  if (domain === "workspace" && action === "list") {
    listWorkspaces(snapshot, json)
    return
  }

  if (domain === "pane" && action === "list") {
    listPanes(context, json)
    return
  }

  if (domain === "tab" && action === "list") {
    listTabs(context, json)
    return
  }

  if (domain === "agent" && action === "ask") {
    const result = await askAgent(url, context, cli)

    if (json) {
      printJson(result)
      return
    }

    console.log(`ok agent ${result.turnId}`)
    console.log(`session ${result.sessionId}`)
    console.log(`thread ${result.providerThreadId}`)
    return
  }

  if (domain === "browser" && action === "run") {
    printJson(await runBrowser(url, context, cli))
    return
  }

  if (domain === "terminal" && action === "run") {
    printJson(await runTerminal(url, context, cli))
    return
  }

  const response = await dispatchCommand(url, {
    command: createCommand(context, cli),
  })

  if (json) {
    printJson(response)
    return
  }

  console.log(`ok ${response.commandId}`)
  printStatus(response.snapshot, resolveContext(response.snapshot, cli.flags))
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Command failed."

  console.error(`ensemble: ${message}`)
  process.exitCode = 1
})
