import { spawn as spawnChild } from "node:child_process"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { createInterface } from "node:readline"
import { BrowserWindow, dialog, ipcMain, session, type WebContents, webContents } from "electron"
import { type IPty, spawn as spawnPty } from "node-pty"
import type {
  AgentApprovalDecision,
  AgentStreamEvent,
  AgentToolItem,
  AgentTurnStartResult,
} from "../shared/agentEvents"
import { createAgentEnsembleCliInstructions } from "../shared/ensembleCliDocumentation"
import {
  ENSEMBLE_CONTROL_DEFAULT_URL,
  type EnsembleCommandRequest,
} from "../shared/ensembleControl"
import { collectPanes, type WorkspaceTab } from "../shared/shellModel"
import {
  dispatchEnsembleCommand,
  getEnsembleSnapshot,
  subscribeEnsembleState,
} from "./ensembleCore"

type ChatMessage = {
  role: "user" | "assistant" | "system"
  content: string
}

type ToolCallResult = AgentToolItem

type AgentTurnResult = {
  assistantMessage: string
  toolCalls: ToolCallResult[]
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

type AgentControlContext = {
  actorId?: string
  viewId?: string
}

type AgentStreamEventInput = AgentStreamEvent extends infer Event
  ? Event extends AgentStreamEvent
    ? Omit<Event, "createdAt" | "sequence" | "sessionId" | "turnId"> & { turnId?: string }
    : never
  : never

type JsonRpcMessage = {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: {
    code?: number
    message?: string
    data?: unknown
  }
}

type PendingJsonRpcRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type PendingServerRequest = {
  id: number | string
  method: string
  params?: unknown
}

type AgentRuntimeSession = {
  id: string
  cwd: string
  configKey: string
  child: ReturnType<typeof spawnChild>
  stdout: ReturnType<typeof createInterface>
  pendingRequests: Map<number | string, PendingJsonRpcRequest>
  pendingServerRequests: Map<string, PendingServerRequest>
  nextRequestId: number
  sequence: number
  providerThreadId: string | null
  activeTurnId: string | null
  activeProviderTurnId: string | null
  activeAssistantMessageId: string | null
  assistantMessages: Map<string, string>
  assistantMessageOrder: string[]
  latestDiff: string
  toolCalls: ToolCallResult[]
  stderr: string
  isClosed: boolean
}

type TerminalRunResult = {
  command: string
  cwd: string
  exitCode: number | null
  stdout: string
  stderr: string
}

type TerminalSessionEvent =
  | {
      sessionId: string
      type: "data"
      data: string
    }
  | {
      sessionId: string
      type: "exit"
      exitCode: number
    }

type TerminalSession = {
  id: string
  cwd: string
  pty: IPty
  backlog: TerminalSessionEvent[]
  subscribers: Set<ServerResponse>
}

type FileTreeEntry = {
  name: string
  path: string
  type: "file" | "directory"
}

type FileTreeNode = FileTreeEntry & {
  id: string
  children?: FileTreeNode[]
}

type FileReadResult = {
  path: string
  content: string
  size: number
  modifiedAt: string
}

const repoRoot = process.cwd()
const testWorkspaceRoot = resolve(repoRoot, ".superapp-test-workspace")
const ensembleCliPath = resolve(repoRoot, "src/cli/index.ts")
const defaultWorkspaceName = "workspace-1"
const runtimePort = 10532
const lastAgentTurns = new Map<string, AgentTurnResult>()
const terminalSessions = new Map<string, TerminalSession>()
const agentSessions = new Map<string, AgentRuntimeSession>()
const agentEventBacklogs = new Map<string, AgentStreamEvent[]>()
const agentEventSubscribers = new Map<string, Set<ServerResponse>>()
const backgroundBrowserWindows = new Map<string, BrowserWindow>()
let ensembleIpcEventsRegistered = false
const excludedFileTreeNames = new Set([
  ".DS_Store",
  ".git",
  ".last-agent-turn.json",
  ".next",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "out",
])
let terminalSessionCounter = 0

function isInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child)
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !resolve(relativePath).startsWith(".."))
  )
}

function asWorkspaceRelativePath(workspaceRoot: string, path: string): string {
  return relative(workspaceRoot, path).split(sep).join("/")
}

function shouldShowFileTreeEntry(name: string): boolean {
  return !excludedFileTreeNames.has(name)
}

function sortFileTreeEntries(left: FileTreeEntry, right: FileTreeEntry): number {
  if (left.type !== right.type) {
    return left.type === "directory" ? -1 : 1
  }

  return left.name.localeCompare(right.name)
}

function limitOutput(text: string, limit = 20_000): string {
  if (text.length <= limit) {
    return text
  }

  return `${text.slice(0, limit)}\n... truncated ${text.length - limit} chars`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getRecordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function getStringValue(value: unknown, key: string): string | undefined {
  const field = getRecordValue(value, key)
  return typeof field === "string" ? field : undefined
}

function getNumberValue(value: unknown, key: string): number | undefined {
  const field = getRecordValue(value, key)
  return typeof field === "number" ? field : undefined
}

function stringifyForUi(value: unknown): string {
  if (typeof value === "string") {
    return value
  }

  if (value === undefined || value === null) {
    return ""
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((entry): entry is string => typeof entry === "string")
}

function createToolCall(
  name: string,
  status: ToolCallResult["status"],
  output: string,
  toolInput?: string,
  id?: string,
): ToolCallResult {
  return {
    id: id ?? `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    status,
    input: toolInput,
    output: limitOutput(output, 6_000),
  }
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 20_000,
): Promise<TerminalRunResult> {
  return new Promise((resolveResult) => {
    const child = spawnChild(command, {
      cwd,
      shell: process.env.SHELL ?? true,
      env: process.env,
    })
    let stdout = ""
    let stderr = ""
    let didTimeout = false
    const timeout = setTimeout(() => {
      didTimeout = true
      child.kill("SIGTERM")
    }, timeoutMs)

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("close", (exitCode) => {
      clearTimeout(timeout)
      resolveResult({
        command,
        cwd,
        exitCode,
        stdout: limitOutput(stdout),
        stderr: limitOutput(didTimeout ? `${stderr}\nCommand timed out.` : stderr),
      })
    })
    child.on("error", (error) => {
      clearTimeout(timeout)
      resolveResult({
        command,
        cwd,
        exitCode: 1,
        stdout: "",
        stderr: error.message,
      })
    })
  })
}

function createSessionId(): string {
  terminalSessionCounter += 1
  return `terminal-${Date.now().toString(36)}-${terminalSessionCounter.toString(36)}`
}

function sendTerminalEvent(event: TerminalSessionEvent): void {
  const session = terminalSessions.get(event.sessionId)

  if (session) {
    session.backlog.push(event)

    if (session.backlog.length > 200) {
      session.backlog.splice(0, session.backlog.length - 200)
    }

    for (const subscriber of session.subscribers) {
      writeServerSentEvent(subscriber, event)
    }
  }

  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("terminal:event", event)
  }
}

async function createTerminalSession(input: {
  workspaceDirectory: string
  cols?: number
  rows?: number
}): Promise<{ sessionId: string; cwd: string; shell: string }> {
  const cwd = await resolveWorkspaceDirectory(input.workspaceDirectory)
  const shell = process.env.SHELL ?? "/bin/zsh"
  const sessionId = createSessionId()
  const pty = spawnPty(shell, [], {
    name: "xterm-256color",
    cols: input.cols ?? 80,
    rows: input.rows ?? 24,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
  })
  const session: TerminalSession = {
    id: sessionId,
    cwd,
    pty,
    backlog: [],
    subscribers: new Set(),
  }

  terminalSessions.set(sessionId, session)
  pty.onData((data) => {
    sendTerminalEvent({ sessionId, type: "data", data })
  })
  pty.onExit(({ exitCode }) => {
    sendTerminalEvent({ sessionId, type: "exit", exitCode })
    terminalSessions.delete(sessionId)
  })

  return { sessionId, cwd, shell }
}

function inputTerminalSession(input: { sessionId: string; data: string }): { ok: true } {
  terminalSessions.get(input.sessionId)?.pty.write(input.data)
  return { ok: true }
}

function resizeTerminalSession(input: { sessionId: string; cols: number; rows: number }): {
  ok: true
} {
  terminalSessions.get(input.sessionId)?.pty.resize(input.cols, input.rows)
  return { ok: true }
}

function closeTerminalSession(input: { sessionId: string }): { ok: true } {
  const session = terminalSessions.get(input.sessionId)

  if (session) {
    session.pty.kill()
    terminalSessions.delete(input.sessionId)
  }

  return { ok: true }
}

async function resolveWorkspaceDirectory(workspaceDirectory: string): Promise<string> {
  const requested = workspaceDirectory.trim() || defaultWorkspaceName
  const resolved = isAbsolute(requested)
    ? resolve(requested)
    : resolve(testWorkspaceRoot, requested)

  if (!isAbsolute(requested) && !isInside(testWorkspaceRoot, resolved)) {
    throw new Error("Workspace directory is outside the allowed test workspace root.")
  }

  await mkdir(resolved, { recursive: true })
  return resolved
}

async function chooseWorkspaceDirectory(): Promise<{ path: string; name: string } | null> {
  await mkdir(testWorkspaceRoot, { recursive: true })

  const result = await dialog.showOpenDialog({
    buttonLabel: "Use as Workspace",
    defaultPath: testWorkspaceRoot,
    properties: ["openDirectory", "createDirectory"],
    title: "Choose workspace directory",
  })

  if (result.canceled || !result.filePaths[0]) {
    return null
  }

  const path = result.filePaths[0]

  return {
    path,
    name: basename(path) || path,
  }
}

async function resolveWorkspacePath(workspaceDirectory: string, path = ""): Promise<string> {
  const workspaceRoot = await resolveWorkspaceDirectory(workspaceDirectory)
  const resolved = resolve(workspaceRoot, path)

  if (!isInside(workspaceRoot, resolved)) {
    throw new Error("Path is outside the workspace directory.")
  }

  return resolved
}

async function writeFileIfMissing(path: string, content: string): Promise<void> {
  try {
    await stat(path)
  } catch {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}

export async function ensureTestWorkspace(): Promise<void> {
  const workspace = await resolveWorkspaceDirectory(defaultWorkspaceName)
  await writeFileIfMissing(
    resolve(workspace, "README.md"),
    "# Superapp Test Workspace\n\nThis ignored workspace is used for app-shell E2E testing.\n",
  )
  await writeFileIfMissing(
    resolve(workspace, "agent-notes.md"),
    "# Agent Notes\n\nTracked file used by the prototype agent and Review tab.\n",
  )
  await writeFileIfMissing(resolve(workspace, ".gitignore"), ".last-agent-turn.json\n")
  await writeFileIfMissing(
    resolve(workspace, "src/example.ts"),
    'export const greeting = "hello from the test workspace"\n',
  )

  const gitCheck = await runCommand("git rev-parse --show-toplevel", workspace, 5_000)

  if (gitCheck.exitCode !== 0 || resolve(gitCheck.stdout.trim()) !== workspace) {
    await runCommand("git init -b main", workspace, 10_000)
    await runCommand('git config user.email "superapp@example.test"', workspace, 5_000)
    await runCommand('git config user.name "Superapp Test"', workspace, 5_000)
    await runCommand(
      "git add .gitignore README.md agent-notes.md src/example.ts && git commit -m initial",
      workspace,
      10_000,
    )
  } else {
    const ignoreTracked = await runCommand(
      "git ls-files --error-unmatch .gitignore",
      workspace,
      5_000,
    )

    if (ignoreTracked.exitCode !== 0) {
      await runCommand(
        "git add .gitignore && git commit -m 'Add workspace gitignore'",
        workspace,
        10_000,
      )
    }
  }
}

async function chatComplete(input: {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
}): Promise<{ content: string }> {
  const baseUrl = input.baseUrl.replace(/\/$/, "")
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      stream: false,
    }),
  })

  if (!response.ok) {
    throw new Error(await response.text())
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return {
    content: payload.choices?.[0]?.message?.content ?? "",
  }
}

function buildCodexAppServerArgs(input: {
  baseUrl: string
  apiKey: string
  model: string
}): string[] {
  const args = ["app-server"]
  const baseUrl = input.baseUrl.trim().replace(/\/$/, "")
  const model = input.model.trim()

  if (model) {
    args.push("-c", `model=${JSON.stringify(model)}`)
  }

  if (baseUrl) {
    args.push(
      "-c",
      'model_provider="superapp_local"',
      "-c",
      'model_providers.superapp_local.name="Superapp Local"',
      "-c",
      `model_providers.superapp_local.base_url=${JSON.stringify(baseUrl)}`,
      "-c",
      'model_providers.superapp_local.wire_api="responses"',
    )

    if (input.apiKey.trim()) {
      args.push("-c", 'model_providers.superapp_local.env_key="OPENAI_API_KEY"')
    }
  }

  return args
}

function getThreadId(result: unknown): string {
  const thread = getRecordValue(result, "thread")
  const threadId = getStringValue(thread, "id")

  if (!threadId) {
    throw new Error("Codex App Server did not return a thread id.")
  }

  return threadId
}

function getCodexToolStatus(value: unknown): ToolCallResult["status"] {
  if (value === "failed" || value === "declined" || value === "error") {
    return "error"
  }

  if (value === "inProgress" || value === "running") {
    return "running"
  }

  return "success"
}

function summarizeFileChanges(changes: unknown): { paths: string; output: string } {
  if (!Array.isArray(changes)) {
    return { paths: "workspace files", output: stringifyForUi(changes) }
  }

  const paths = changes
    .map((change) => getStringValue(change, "path"))
    .filter((path): path is string => Boolean(path))
  const output = changes
    .map((change) => {
      const path = getStringValue(change, "path") ?? "workspace file"
      const kind = getStringValue(change, "kind") ?? "updated"
      const diff = getStringValue(change, "diff")
      return diff ? `${kind} ${path}\n${diff}` : `${kind} ${path}`
    })
    .join("\n\n")

  return {
    paths: paths.join(", ") || "workspace files",
    output: output || "Workspace files changed.",
  }
}

function codexItemToToolCall(item: unknown): ToolCallResult | null {
  const type = getStringValue(item, "type")
  const itemId = getStringValue(item, "id")

  switch (type) {
    case "plan": {
      const text = getStringValue(item, "text")

      return text
        ? createToolCall("codex_app_server.plan", "success", text, undefined, itemId)
        : null
    }
    case "reasoning": {
      const summary = asStringList(getRecordValue(item, "summary"))
      const content = asStringList(getRecordValue(item, "content"))
      const output = [...summary, ...content].join("\n")

      return output
        ? createToolCall("codex_app_server.reasoning", "success", output, undefined, itemId)
        : null
    }
    case "commandExecution": {
      const command = getStringValue(item, "command") ?? "shell command"
      const cwd = getStringValue(item, "cwd")
      const status = getCodexToolStatus(getRecordValue(item, "status"))
      const exitCode = getNumberValue(item, "exitCode")
      const durationMs = getNumberValue(item, "durationMs")
      const aggregatedOutput = getStringValue(item, "aggregatedOutput")
      const metadata = [
        cwd ? `cwd: ${cwd}` : null,
        exitCode !== undefined ? `exit: ${exitCode}` : null,
        durationMs !== undefined ? `duration: ${durationMs}ms` : null,
      ]
        .filter(Boolean)
        .join("\n")
      const output = [metadata, aggregatedOutput].filter(Boolean).join("\n\n")

      return createToolCall(
        "command_execution",
        status,
        output || "Command completed.",
        command,
        itemId,
      )
    }
    case "fileChange": {
      const status = getCodexToolStatus(getRecordValue(item, "status"))
      const { paths, output } = summarizeFileChanges(getRecordValue(item, "changes"))

      return createToolCall("file_change", status, output, paths, itemId)
    }
    case "mcpToolCall": {
      const server = getStringValue(item, "server") ?? "mcp"
      const tool = getStringValue(item, "tool") ?? "tool"
      const status = getCodexToolStatus(getRecordValue(item, "status"))
      const result = getRecordValue(item, "result")
      const error = getRecordValue(item, "error")
      const output = error ? stringifyForUi(error) : stringifyForUi(result)
      const toolInput = stringifyForUi(getRecordValue(item, "arguments"))

      return createToolCall(`mcp_tool_call.${server}.${tool}`, status, output, toolInput, itemId)
    }
    case "dynamicToolCall": {
      const namespace = getStringValue(item, "namespace")
      const tool = getStringValue(item, "tool") ?? "tool"
      const status = getCodexToolStatus(getRecordValue(item, "status"))
      const output = stringifyForUi(getRecordValue(item, "contentItems"))
      const toolInput = stringifyForUi(getRecordValue(item, "arguments"))
      const name = namespace
        ? `dynamic_tool_call.${namespace}.${tool}`
        : `dynamic_tool_call.${tool}`

      return createToolCall(name, status, output, toolInput, itemId)
    }
    default:
      return null
  }
}

function createAgentSessionId(): string {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function createAgentTurnId(): string {
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function createAgentMessageFallbackId(session: AgentRuntimeSession): string {
  if (session.activeAssistantMessageId) {
    return session.activeAssistantMessageId
  }

  const messageId = `${session.activeTurnId ?? createAgentTurnId()}-assistant-${
    session.assistantMessageOrder.length + 1
  }`
  session.activeAssistantMessageId = messageId
  return messageId
}

function getAgentMessageIdFromParams(params: unknown, session: AgentRuntimeSession): string {
  const item = getRecordValue(params, "item")
  const messageId =
    getStringValue(params, "itemId") ??
    getStringValue(params, "messageId") ??
    getStringValue(params, "id") ??
    getStringValue(item, "id")

  if (messageId) {
    session.activeAssistantMessageId = messageId
    return messageId
  }

  return createAgentMessageFallbackId(session)
}

function getAgentMessageIdFromItem(item: unknown, session: AgentRuntimeSession): string {
  const itemId = getStringValue(item, "id")

  if (!itemId) {
    return createAgentMessageFallbackId(session)
  }

  const fallbackId = session.activeAssistantMessageId

  if (
    fallbackId &&
    fallbackId !== itemId &&
    session.assistantMessages.has(fallbackId) &&
    !session.assistantMessages.has(itemId)
  ) {
    const fallbackContent = session.assistantMessages.get(fallbackId) ?? ""
    session.assistantMessages.delete(fallbackId)
    session.assistantMessages.set(itemId, fallbackContent)
    session.assistantMessageOrder = session.assistantMessageOrder.map((id) =>
      id === fallbackId ? itemId : id,
    )
  }

  session.activeAssistantMessageId = itemId
  return itemId
}

function setAssistantMessage(
  session: AgentRuntimeSession,
  messageId: string,
  content: string,
): void {
  if (!session.assistantMessages.has(messageId)) {
    session.assistantMessageOrder.push(messageId)
  }

  session.assistantMessages.set(messageId, content)
}

function appendAssistantDelta(
  session: AgentRuntimeSession,
  messageId: string,
  delta: string,
): string {
  const nextContent = `${session.assistantMessages.get(messageId) ?? ""}${delta}`
  setAssistantMessage(session, messageId, nextContent)
  return nextContent
}

function getAssistantTranscript(session: AgentRuntimeSession): string {
  return session.assistantMessageOrder
    .map((messageId) => session.assistantMessages.get(messageId)?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n")
}

function closeActiveAssistantMessage(session: AgentRuntimeSession): void {
  session.activeAssistantMessageId = null
}

function getTurnId(result: unknown, fallback: string): string {
  const turn = getRecordValue(result, "turn")
  return getStringValue(turn, "id") ?? fallback
}

function createAgentConfigKey(input: {
  baseUrl: string
  apiKey: string
  model: string
  actorId?: string
  viewId?: string
}): string {
  return JSON.stringify({
    baseUrl: input.baseUrl.trim().replace(/\/$/, ""),
    hasApiKey: input.apiKey.trim().length > 0,
    model: input.model.trim(),
    actorId: input.actorId?.trim() || null,
    viewId: input.viewId?.trim() || null,
  })
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function createAgentEnvironment(
  apiKey: string,
  controlContext: AgentControlContext,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ENSEMBLE_CLI: ensembleCliPath,
    ENSEMBLE_CONTROL_URL: ENSEMBLE_CONTROL_DEFAULT_URL,
    ...(controlContext.actorId?.trim() ? { ENSEMBLE_ACTOR: controlContext.actorId.trim() } : {}),
    ...(controlContext.viewId?.trim() ? { ENSEMBLE_VIEW: controlContext.viewId.trim() } : {}),
    ...(apiKey.trim() ? { OPENAI_API_KEY: apiKey.trim() } : {}),
  }
}

function createAgentBaseInstructions(): string {
  return [
    "You are the coding agent inside a workspace-shell prototype. Work only inside the provided workspace root. Keep responses concise and surface meaningful tool activity.",
    createAgentEnsembleCliInstructions({
      command: '"$ENSEMBLE_CLI"',
      fallbackCommand: shellQuote(ensembleCliPath),
    }),
  ].join("\n\n")
}

function emitAgentEvent(session: AgentRuntimeSession, event: AgentStreamEventInput): void {
  const turnId = event.turnId ?? session.activeTurnId ?? "session"
  const payload = {
    ...event,
    sessionId: session.id,
    turnId,
    sequence: session.sequence + 1,
    createdAt: Date.now(),
  } as AgentStreamEvent
  session.sequence = payload.sequence
  const backlog = agentEventBacklogs.get(session.id) ?? []
  backlog.push(payload)

  if (backlog.length > 400) {
    backlog.splice(0, backlog.length - 400)
  }

  agentEventBacklogs.set(session.id, backlog)

  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("agent:event", payload)
  }

  for (const subscriber of agentEventSubscribers.get(session.id) ?? []) {
    writeServerSentEvent(subscriber, payload)
  }
}

function writeAgentMessage(session: AgentRuntimeSession, message: unknown): void {
  if (!session.child.stdin) {
    throw new Error("Codex App Server stdin is unavailable.")
  }

  session.child.stdin.write(`${JSON.stringify(message)}\n`)
}

function upsertAgentTool(session: AgentRuntimeSession, toolCall: ToolCallResult): void {
  const index = session.toolCalls.findIndex((entry) => entry.id === toolCall.id)

  if (index >= 0) {
    session.toolCalls[index] = { ...session.toolCalls[index], ...toolCall }
    return
  }

  session.toolCalls.push(toolCall)
}

function requestKindFromCodexMethod(
  method: string,
): "command" | "file-read" | "file-change" | "unknown" {
  if (method.includes("commandExecution")) {
    return "command"
  }

  if (method.includes("fileRead")) {
    return "file-read"
  }

  if (method.includes("fileChange") || method.includes("permissions")) {
    return "file-change"
  }

  return "unknown"
}

function sendAgentServerResponse(
  session: AgentRuntimeSession,
  id: number | string,
  result: unknown,
): void {
  writeAgentMessage(session, { id, result })
}

function sendAgentServerError(
  session: AgentRuntimeSession,
  id: number | string,
  message: string,
): void {
  writeAgentMessage(session, { id, error: { code: -32603, message } })
}

function rejectAgentPendingRequests(session: AgentRuntimeSession, error: Error): void {
  for (const pending of session.pendingRequests.values()) {
    pending.reject(error)
  }

  session.pendingRequests.clear()
}

function closeAgentSession(session: AgentRuntimeSession): void {
  if (session.isClosed) {
    return
  }

  session.isClosed = true
  rejectAgentPendingRequests(session, new Error("Codex App Server session closed."))
  session.pendingServerRequests.clear()
  session.stdout.close()
  session.child.kill("SIGTERM")
  agentSessions.delete(session.id)
}

function handleAgentServerRequest(session: AgentRuntimeSession, message: JsonRpcMessage): void {
  if (message.id === undefined || !message.method) {
    return
  }

  if (
    message.method === "item/commandExecution/requestApproval" ||
    message.method === "item/fileChange/requestApproval" ||
    message.method === "item/permissions/requestApproval"
  ) {
    const requestId = String(message.id)
    session.pendingServerRequests.set(requestId, {
      id: message.id,
      method: message.method,
      params: message.params,
    })
    emitAgentEvent(session, {
      type: "approval.requested",
      requestId,
      requestKind: requestKindFromCodexMethod(message.method),
      summary:
        requestKindFromCodexMethod(message.method) === "command"
          ? "Command approval requested"
          : "Workspace approval requested",
      detail: stringifyForUi(message.params),
      payload: message.params,
    })
    return
  }

  if (message.method === "item/tool/requestUserInput") {
    const requestId = String(message.id)
    session.pendingServerRequests.set(requestId, {
      id: message.id,
      method: message.method,
      params: message.params,
    })
    emitAgentEvent(session, {
      type: "user-input.requested",
      requestId,
      summary: "Agent requested input",
      payload: message.params,
    })
    return
  }

  sendAgentServerError(
    session,
    message.id,
    `The prototype client does not implement ${message.method}.`,
  )
}

async function persistAgentTurnResult(session: AgentRuntimeSession): Promise<void> {
  const assistantMessage = getAssistantTranscript(session)
  const result: AgentTurnResult = {
    assistantMessage:
      assistantMessage || "Codex App Server completed without an assistant message.",
    toolCalls: session.toolCalls,
  }
  lastAgentTurns.set(session.cwd, result)
  await writeFile(resolve(session.cwd, ".last-agent-turn.json"), JSON.stringify(result, null, 2))
}

function handleAgentNotification(session: AgentRuntimeSession, message: JsonRpcMessage): void {
  switch (message.method) {
    case "item/agentMessage/delta": {
      const delta = getStringValue(message.params, "delta") ?? ""
      if (!delta) {
        break
      }

      const messageId = getAgentMessageIdFromParams(message.params, session)
      appendAssistantDelta(session, messageId, delta)
      emitAgentEvent(session, {
        type: "assistant.delta",
        messageId,
        delta,
      })
      break
    }
    case "item/started":
    case "item/updated": {
      const item = getRecordValue(message.params, "item")
      const toolCall = codexItemToToolCall(item)

      if (toolCall) {
        const eventType = message.method === "item/started" ? "tool.started" : "tool.updated"
        upsertAgentTool(session, toolCall)
        closeActiveAssistantMessage(session)
        emitAgentEvent(session, {
          type: eventType,
          tool: toolCall,
        })
      }
      break
    }
    case "item/completed": {
      const item = getRecordValue(message.params, "item")
      const itemType = getStringValue(item, "type")

      if (itemType === "agentMessage") {
        const messageId = getAgentMessageIdFromItem(item, session)
        const content =
          getStringValue(item, "text") ?? session.assistantMessages.get(messageId) ?? ""
        setAssistantMessage(session, messageId, content)
        emitAgentEvent(session, {
          type: "assistant.completed",
          messageId,
          content,
        })
        closeActiveAssistantMessage(session)
        break
      }

      const toolCall = codexItemToToolCall(item)

      if (toolCall) {
        upsertAgentTool(session, toolCall)
        closeActiveAssistantMessage(session)
        emitAgentEvent(session, {
          type: "tool.completed",
          tool: toolCall,
        })
      }
      break
    }
    case "turn/diff/updated": {
      session.latestDiff = getStringValue(message.params, "diff") ?? session.latestDiff
      closeActiveAssistantMessage(session)
      emitAgentEvent(session, {
        type: "turn.diff.updated",
        diff: session.latestDiff,
      })
      break
    }
    case "warning":
    case "guardianWarning":
    case "configWarning": {
      const warning = stringifyForUi(message.params)
      if (warning) {
        const toolCall = createToolCall("codex_app_server.warning", "error", warning)
        upsertAgentTool(session, toolCall)
        closeActiveAssistantMessage(session)
        emitAgentEvent(session, {
          type: "tool.completed",
          tool: toolCall,
        })
      }
      break
    }
    case "error": {
      const error = stringifyForUi(message.params)
      const toolCall = createToolCall("codex_app_server.error", "error", error)
      upsertAgentTool(session, toolCall)
      closeActiveAssistantMessage(session)
      emitAgentEvent(session, {
        type: "runtime.error",
        message: "Codex App Server error",
        detail: error,
      })
      break
    }
    case "turn/completed": {
      if (session.latestDiff.trim()) {
        const diffTool = createToolCall("codex_app_server.diff", "success", session.latestDiff)
        upsertAgentTool(session, diffTool)
        closeActiveAssistantMessage(session)
        emitAgentEvent(session, {
          type: "tool.completed",
          tool: diffTool,
        })
      }

      if (session.assistantMessageOrder.length === 0) {
        const messageId = createAgentMessageFallbackId(session)
        emitAgentEvent(session, {
          type: "assistant.completed",
          messageId,
          content: "Codex App Server completed without an assistant message.",
        })
      }

      const assistantMessage = getAssistantTranscript(session)
      emitAgentEvent(session, {
        type: "turn.completed",
        assistantMessage:
          assistantMessage || "Codex App Server completed without an assistant message.",
        toolCalls: session.toolCalls,
      })
      void persistAgentTurnResult(session).catch((error) => {
        emitAgentEvent(session, {
          type: "runtime.error",
          message: "Failed to persist agent turn",
          detail: error instanceof Error ? error.message : String(error),
        })
      })
      session.activeTurnId = null
      session.activeProviderTurnId = null
      session.activeAssistantMessageId = null
      session.assistantMessages.clear()
      session.assistantMessageOrder = []
      session.latestDiff = ""
      session.toolCalls = []
      break
    }
  }
}

function handleAgentLine(session: AgentRuntimeSession, line: string): void {
  if (!line.trim()) {
    return
  }

  let message: JsonRpcMessage

  try {
    message = JSON.parse(line) as JsonRpcMessage
  } catch (error) {
    emitAgentEvent(session, {
      type: "runtime.error",
      message: "Failed to parse Codex App Server output",
      detail: error instanceof Error ? error.message : line,
    })
    return
  }

  if (message.id !== undefined && message.method) {
    handleAgentServerRequest(session, message)
    return
  }

  if (message.id !== undefined) {
    const pending = session.pendingRequests.get(message.id)

    if (!pending) {
      return
    }

    session.pendingRequests.delete(message.id)

    if (message.error) {
      pending.reject(new Error(message.error.message ?? "Codex App Server request failed."))
    } else {
      pending.resolve(message.result)
    }
    return
  }

  handleAgentNotification(session, message)
}

function createAgentRuntimeSession(input: {
  sessionId: string
  cwd: string
  configKey: string
  baseUrl: string
  apiKey: string
  model: string
  actorId?: string
  viewId?: string
}): AgentRuntimeSession {
  const child = spawnChild("codex", buildCodexAppServerArgs(input), {
    cwd: input.cwd,
    env: createAgentEnvironment(input.apiKey, input),
    stdio: ["pipe", "pipe", "pipe"],
  })
  const stdout = createInterface({ input: child.stdout })
  const session: AgentRuntimeSession = {
    id: input.sessionId,
    cwd: input.cwd,
    configKey: input.configKey,
    child,
    stdout,
    pendingRequests: new Map(),
    pendingServerRequests: new Map(),
    nextRequestId: 1,
    sequence: 0,
    providerThreadId: null,
    activeTurnId: null,
    activeProviderTurnId: null,
    activeAssistantMessageId: null,
    assistantMessages: new Map(),
    assistantMessageOrder: [],
    latestDiff: "",
    toolCalls: [],
    stderr: "",
    isClosed: false,
  }

  stdout.on("line", (line) => handleAgentLine(session, line))
  child.stderr.on("data", (chunk) => {
    session.stderr += String(chunk)
  })
  child.on("error", (error) => {
    emitAgentEvent(session, {
      type: "runtime.error",
      message: "Failed to start Codex App Server",
      detail: error.message,
    })
  })
  child.on("close", (exitCode) => {
    if (session.isClosed) {
      return
    }

    session.isClosed = true
    rejectAgentPendingRequests(
      session,
      new Error(`Codex App Server exited${exitCode === null ? "" : ` with code ${exitCode}`}.`),
    )
    agentSessions.delete(session.id)
    emitAgentEvent(session, {
      type: "runtime.error",
      message: "Codex App Server session closed",
      detail: limitOutput(session.stderr, 4_000),
    })
  })

  agentSessions.set(session.id, session)
  return session
}

function sendAgentRequest(
  session: AgentRuntimeSession,
  method: string,
  params: unknown,
): Promise<unknown> {
  const id = session.nextRequestId
  session.nextRequestId += 1

  return new Promise((resolveRequest, rejectRequest) => {
    const stdin = session.child.stdin

    if (!stdin) {
      rejectRequest(new Error("Codex App Server stdin is unavailable."))
      return
    }

    session.pendingRequests.set(id, { resolve: resolveRequest, reject: rejectRequest })
    stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
      if (!error) {
        return
      }

      session.pendingRequests.delete(id)
      rejectRequest(error)
    })
  })
}

function notifyAgent(session: AgentRuntimeSession, method: string, params: unknown): void {
  writeAgentMessage(session, { method, params })
}

async function ensureAgentSession(input: {
  sessionId?: string
  workspaceDirectory: string
  baseUrl: string
  apiKey: string
  model: string
  actorId?: string
  viewId?: string
}): Promise<AgentRuntimeSession> {
  const cwd = await resolveWorkspaceDirectory(input.workspaceDirectory)
  const configKey = createAgentConfigKey(input)
  const requestedSessionId = input.sessionId?.trim() || createAgentSessionId()
  const existing = agentSessions.get(requestedSessionId)

  if (existing && existing.cwd === cwd && existing.configKey === configKey && !existing.isClosed) {
    return existing
  }

  if (existing) {
    closeAgentSession(existing)
  }

  const session = createAgentRuntimeSession({
    sessionId: requestedSessionId,
    cwd,
    configKey,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    model: input.model,
    actorId: input.actorId,
    viewId: input.viewId,
  })

  await sendAgentRequest(session, "initialize", {
    clientInfo: {
      name: "ensemble",
      title: "Ensemble",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  })
  notifyAgent(session, "initialized", {})

  const threadStartResult = await sendAgentRequest(session, "thread/start", {
    model: input.model,
    modelProvider: input.baseUrl.trim() ? "superapp_local" : undefined,
    cwd,
    runtimeWorkspaceRoots: [cwd],
    approvalPolicy: "never",
    sandbox: "workspace-write",
    baseInstructions: createAgentBaseInstructions(),
  })
  session.providerThreadId = getThreadId(threadStartResult)
  return session
}

async function startAgentTurn(input: {
  sessionId?: string
  workspaceDirectory: string
  baseUrl: string
  apiKey: string
  model: string
  message: string
  actorId?: string
  viewId?: string
}): Promise<AgentTurnStartResult> {
  const session = await ensureAgentSession(input)
  const turnId = session.activeTurnId ?? createAgentTurnId()
  session.activeTurnId = turnId
  session.activeAssistantMessageId = null
  session.assistantMessages.clear()
  session.assistantMessageOrder = []

  if (!session.providerThreadId) {
    throw new Error("Codex App Server thread is not initialized.")
  }

  emitAgentEvent(session, {
    type: "session.started",
    turnId,
    cwd: session.cwd,
    providerThreadId: session.providerThreadId,
  })
  emitAgentEvent(session, {
    type: "turn.started",
    turnId,
    message: input.message,
  })

  try {
    const turnStartResult = await sendAgentRequest(session, "turn/start", {
      threadId: session.providerThreadId,
      cwd: session.cwd,
      runtimeWorkspaceRoots: [session.cwd],
      approvalPolicy: "never",
      model: input.model,
      input: [
        {
          type: "text",
          text: input.message,
          text_elements: [],
        },
      ],
    })
    session.activeProviderTurnId = getTurnId(turnStartResult, turnId)
    return {
      sessionId: session.id,
      turnId,
      providerThreadId: session.providerThreadId,
    }
  } catch (error) {
    emitAgentEvent(session, {
      type: "runtime.error",
      turnId,
      message: "Failed to start agent turn",
      detail: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

async function interruptAgentTurn(input: { sessionId: string }): Promise<void> {
  const session = agentSessions.get(input.sessionId)

  if (!session?.providerThreadId) {
    return
  }

  await sendAgentRequest(session, "turn/interrupt", {
    threadId: session.providerThreadId,
    ...(session.activeProviderTurnId ? { turnId: session.activeProviderTurnId } : {}),
  })
}

async function respondAgentApproval(input: {
  sessionId: string
  requestId: string
  decision: AgentApprovalDecision
}): Promise<void> {
  const session = agentSessions.get(input.sessionId)
  const request = session?.pendingServerRequests.get(input.requestId)

  if (!session || !request) {
    throw new Error("Approval request is no longer pending.")
  }

  session.pendingServerRequests.delete(input.requestId)
  sendAgentServerResponse(session, request.id, { decision: input.decision })
  emitAgentEvent(session, {
    type: "approval.resolved",
    requestId: input.requestId,
    decision: input.decision,
  })
}

async function respondAgentUserInput(input: {
  sessionId: string
  requestId: string
  answers: Record<string, string | string[]>
}): Promise<void> {
  const session = agentSessions.get(input.sessionId)
  const request = session?.pendingServerRequests.get(input.requestId)

  if (!session || !request) {
    throw new Error("User-input request is no longer pending.")
  }

  session.pendingServerRequests.delete(input.requestId)
  sendAgentServerResponse(session, request.id, { answers: input.answers })
  emitAgentEvent(session, {
    type: "user-input.resolved",
    requestId: input.requestId,
  })
}

async function sendAgentTurn(input: {
  workspaceDirectory: string
  baseUrl: string
  apiKey: string
  model: string
  message: string
  actorId?: string
  viewId?: string
}): Promise<AgentTurnResult> {
  const cwd = await resolveWorkspaceDirectory(input.workspaceDirectory)
  const toolCalls: ToolCallResult[] = []
  let assistantMessage = ""
  let latestDiff = ""
  let stderr = ""
  let nextId = 1
  let isFinished = false
  let threadId: string | null = null
  const pendingRequests = new Map<number | string, PendingJsonRpcRequest>()
  const child = spawnChild("codex", buildCodexAppServerArgs(input), {
    cwd,
    env: createAgentEnvironment(input.apiKey, input),
    stdio: ["pipe", "pipe", "pipe"],
  })
  const stdout = createInterface({ input: child.stdout })

  const turnCompleted = new Promise<AgentTurnResult>((resolveTurn, rejectTurn) => {
    let timeout: ReturnType<typeof setTimeout> | undefined

    function rejectPendingRequests(error: Error): void {
      for (const pending of pendingRequests.values()) {
        pending.reject(error)
      }

      pendingRequests.clear()
    }

    function finish(result: AgentTurnResult): void {
      if (isFinished) {
        return
      }

      isFinished = true
      if (timeout) {
        clearTimeout(timeout)
      }
      pendingRequests.clear()
      stdout.close()
      child.kill("SIGTERM")
      resolveTurn(result)
    }

    function fail(error: Error): void {
      if (isFinished) {
        return
      }

      isFinished = true
      if (timeout) {
        clearTimeout(timeout)
      }
      rejectPendingRequests(error)
      stdout.close()
      child.kill("SIGTERM")
      rejectTurn(error)
    }

    timeout = setTimeout(() => {
      fail(new Error("Codex App Server turn timed out."))
    }, 180_000)

    function sendServerResponse(id: number | string, result: unknown): void {
      child.stdin.write(`${JSON.stringify({ id, result })}\n`)
    }

    function sendServerError(id: number | string, message: string): void {
      child.stdin.write(`${JSON.stringify({ id, error: { code: -32603, message } })}\n`)
    }

    function handleServerRequest(message: JsonRpcMessage): void {
      if (message.id === undefined || !message.method) {
        return
      }

      if (
        message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval" ||
        message.method === "item/permissions/requestApproval"
      ) {
        sendServerResponse(message.id, { decision: "decline" })
        return
      }

      sendServerError(message.id, `The prototype client does not implement ${message.method}.`)
    }

    function handleNotification(message: JsonRpcMessage): void {
      switch (message.method) {
        case "item/agentMessage/delta": {
          assistantMessage += getStringValue(message.params, "delta") ?? ""
          break
        }
        case "item/completed": {
          const item = getRecordValue(message.params, "item")
          const itemType = getStringValue(item, "type")

          if (itemType === "agentMessage") {
            assistantMessage = getStringValue(item, "text") ?? assistantMessage
            break
          }

          const toolCall = codexItemToToolCall(item)

          if (toolCall) {
            toolCalls.push(toolCall)
          }
          break
        }
        case "turn/diff/updated": {
          latestDiff = getStringValue(message.params, "diff") ?? latestDiff
          break
        }
        case "warning":
        case "guardianWarning":
        case "configWarning": {
          const warning = stringifyForUi(message.params)
          if (warning) {
            toolCalls.push(createToolCall("codex_app_server.warning", "error", warning))
          }
          break
        }
        case "error": {
          const error = stringifyForUi(message.params)
          toolCalls.push(createToolCall("codex_app_server.error", "error", error))
          break
        }
        case "turn/completed": {
          if (latestDiff.trim()) {
            toolCalls.push(createToolCall("codex_app_server.diff", "success", latestDiff))
          }

          finish({
            assistantMessage:
              assistantMessage.trim() || "Codex App Server completed without an assistant message.",
            toolCalls,
          })
          break
        }
      }
    }

    stdout.on("line", (line) => {
      if (!line.trim()) {
        return
      }

      let message: JsonRpcMessage

      try {
        message = JSON.parse(line) as JsonRpcMessage
      } catch (error) {
        toolCalls.push(
          createToolCall(
            "codex_app_server.protocol",
            "error",
            error instanceof Error ? error.message : "Failed to parse Codex App Server output.",
            line,
          ),
        )
        return
      }

      if (message.id !== undefined && message.method) {
        handleServerRequest(message)
        return
      }

      if (message.id !== undefined) {
        const pending = pendingRequests.get(message.id)

        if (!pending) {
          return
        }

        pendingRequests.delete(message.id)

        if (message.error) {
          pending.reject(new Error(message.error.message ?? "Codex App Server request failed."))
        } else {
          pending.resolve(message.result)
        }
        return
      }

      handleNotification(message)
    })

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", (error) => {
      fail(error)
    })
    child.on("close", (exitCode) => {
      if (isFinished) {
        return
      }

      fail(
        new Error(
          `Codex App Server exited before completing the turn${
            exitCode === null ? "" : ` with code ${exitCode}`
          }.\n${limitOutput(stderr, 4_000)}`,
        ),
      )
    })
  })

  function send(method: string, params: unknown): Promise<unknown> {
    const id = nextId
    nextId += 1

    return new Promise((resolveRequest, rejectRequest) => {
      pendingRequests.set(id, { resolve: resolveRequest, reject: rejectRequest })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) {
          return
        }

        pendingRequests.delete(id)
        rejectRequest(error)
      })
    })
  }

  function notify(method: string, params: unknown): void {
    child.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  try {
    await send("initialize", {
      clientInfo: {
        name: "ensemble",
        title: "Ensemble",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    })
    notify("initialized", {})

    const threadStartResult = await send("thread/start", {
      model: input.model,
      modelProvider: input.baseUrl.trim() ? "superapp_local" : undefined,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: "never",
      sandbox: "workspace-write",
      baseInstructions: createAgentBaseInstructions(),
    })
    threadId = getThreadId(threadStartResult)
    toolCalls.push(
      createToolCall(
        "codex_app_server.thread",
        "success",
        `Started thread ${threadId}`,
        cwd,
        `codex-thread-${threadId}`,
      ),
    )

    await send("turn/start", {
      threadId,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: "never",
      model: input.model,
      input: [
        {
          type: "text",
          text: input.message,
          text_elements: [],
        },
      ],
    })
  } catch (error) {
    child.kill("SIGTERM")
    void turnCompleted.catch(() => {})
    throw error
  }

  const result = await turnCompleted
  lastAgentTurns.set(input.workspaceDirectory, result)
  await writeFile(resolve(cwd, ".last-agent-turn.json"), JSON.stringify(result, null, 2))
  return result
}

async function listFiles(input: { workspaceDirectory: string; path?: string }): Promise<{
  directory: string
  entries: FileTreeEntry[]
}> {
  const workspaceRoot = await resolveWorkspaceDirectory(input.workspaceDirectory)
  const directory = await resolveWorkspacePath(input.workspaceDirectory, input.path ?? "")
  const entries = await readdir(directory, { withFileTypes: true })

  return {
    directory: asWorkspaceRelativePath(workspaceRoot, directory),
    entries: entries
      .filter((entry) => shouldShowFileTreeEntry(entry.name))
      .map((entry) => {
        const path = asWorkspaceRelativePath(workspaceRoot, resolve(directory, entry.name))
        return {
          name: entry.name,
          path,
          type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        }
      })
      .sort(sortFileTreeEntries),
  }
}

async function buildFileTreeNode(
  workspaceRoot: string,
  absolutePath: string,
): Promise<FileTreeNode> {
  const stats = await stat(absolutePath)
  const path = asWorkspaceRelativePath(workspaceRoot, absolutePath)
  const name = path ? (absolutePath.split(sep).at(-1) ?? path) : "."
  const type = stats.isDirectory() ? ("directory" as const) : ("file" as const)
  const node: FileTreeNode = {
    id: path || ".",
    name,
    path,
    type,
  }

  if (type === "directory") {
    const entries = await readdir(absolutePath, { withFileTypes: true })
    const children = await Promise.all(
      entries
        .filter((entry) => shouldShowFileTreeEntry(entry.name))
        .map((entry) => buildFileTreeNode(workspaceRoot, resolve(absolutePath, entry.name))),
    )
    node.children = children.sort(sortFileTreeEntries)
  }

  return node
}

async function getFileTree(input: {
  workspaceDirectory: string
}): Promise<{ entries: FileTreeNode[] }> {
  const workspaceRoot = await resolveWorkspaceDirectory(input.workspaceDirectory)
  const rootNode = await buildFileTreeNode(workspaceRoot, workspaceRoot)

  return {
    entries: rootNode.children ?? [],
  }
}

async function readWorkspaceFile(input: {
  workspaceDirectory: string
  path: string
}): Promise<FileReadResult> {
  const path = await resolveWorkspacePath(input.workspaceDirectory, input.path)
  const stats = await stat(path)

  if (!stats.isFile()) {
    throw new Error("Selected path is not a file.")
  }

  return {
    path: input.path,
    content: limitOutput(await readFile(path, "utf8"), 80_000),
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  }
}

async function writeWorkspaceFile(input: {
  workspaceDirectory: string
  path: string
  content: string
}): Promise<FileReadResult> {
  const path = await resolveWorkspacePath(input.workspaceDirectory, input.path)

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, input.content, "utf8")
  return readWorkspaceFile(input)
}

async function runWorkspaceTerminal(input: {
  workspaceDirectory: string
  command: string
}): Promise<TerminalRunResult> {
  const cwd = await resolveWorkspaceDirectory(input.workspaceDirectory)
  return runCommand(input.command, cwd)
}

async function getReview(input: { workspaceDirectory: string }): Promise<{
  cwd: string
  status: string
  diffStat: string
  diff: string
  lastAgentTurn: AgentTurnResult | null
}> {
  const cwd = await resolveWorkspaceDirectory(input.workspaceDirectory)
  const status = await runCommand("git status --short", cwd, 8_000)
  const diffStat = await runCommand("git diff --stat main --", cwd, 8_000)
  const diff = await runCommand("git diff main --", cwd, 8_000)
  let lastAgentTurn = lastAgentTurns.get(input.workspaceDirectory) ?? null

  if (!lastAgentTurn) {
    try {
      lastAgentTurn = JSON.parse(
        await readFile(resolve(cwd, ".last-agent-turn.json"), "utf8"),
      ) as AgentTurnResult
    } catch {
      lastAgentTurn = null
    }
  }

  return {
    cwd,
    status: status.stdout || status.stderr,
    diffStat: diffStat.stdout || diffStat.stderr,
    diff: diff.stdout || diff.stderr,
    lastAgentTurn,
  }
}

function findTabLocationById(
  tabId: string,
  expectedTypeId: string,
  label: string,
): {
  paneId: string
  tab: WorkspaceTab
} {
  const snapshot = getEnsembleSnapshot()

  for (const workspace of snapshot.state.workspaces) {
    for (const pane of collectPanes(workspace.root)) {
      const tab = pane.tabs.find((candidate) => candidate.id === tabId)

      if (!tab) {
        continue
      }

      if (tab.typeId !== expectedTypeId) {
        throw new Error(`Tab is ${tab.typeId}, not ${expectedTypeId}.`)
      }

      return {
        paneId: pane.id,
        tab,
      }
    }
  }

  throw new Error(`${label} tab not found: ${tabId}`)
}

function findTabById(tabId: string, expectedTypeId: string, label: string): WorkspaceTab {
  return findTabLocationById(tabId, expectedTypeId, label).tab
}

function findTerminalTab(tabId: string): WorkspaceTab {
  return findTabById(tabId, "core.terminal", "Terminal")
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout)
    }
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function findBrowserGuest(tab: WorkspaceTab): WebContents | undefined {
  const webContentsId = tab.state.webContentsId

  if (typeof webContentsId === "number") {
    const guest = webContents.fromId(webContentsId)

    if (guest && !guest.isDestroyed()) {
      return guest
    }
  }

  const tabSession = session.fromPartition(`persist:${tab.id}`)

  return webContents
    .getAllWebContents()
    .find(
      (candidate) =>
        !candidate.isDestroyed() &&
        candidate.getType() === "webview" &&
        candidate.session === tabSession,
    )
}

function normalizeBrowserUrl(url: string): string {
  if (/^https?:\/\//.test(url)) {
    return url
  }

  return `https://${url}`
}

async function createBackgroundBrowserGuest(tab: WorkspaceTab): Promise<WebContents> {
  const existingWindow = backgroundBrowserWindows.get(tab.id)

  if (existingWindow && !existingWindow.isDestroyed()) {
    return existingWindow.webContents
  }

  const window = new BrowserWindow({
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: `persist:${tab.id}`,
      sandbox: true,
    },
    width: 1280,
  })

  backgroundBrowserWindows.set(tab.id, window)
  window.on("closed", () => {
    if (backgroundBrowserWindows.get(tab.id) === window) {
      backgroundBrowserWindows.delete(tab.id)
    }
  })

  const url = typeof tab.state.url === "string" ? tab.state.url : "https://example.com"
  await withTimeout(
    window.webContents.loadURL(normalizeBrowserUrl(url)),
    15_000,
    "Background browser load timed out.",
  )

  return window.webContents
}

async function getBrowserGuest(
  tabId: string,
  timeoutMs: number,
): Promise<{
  guest: WebContents
  tab: WorkspaceTab
  paneId: string
}> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const { paneId, tab } = findTabLocationById(tabId, "core.browser", "Browser")
    const guest = findBrowserGuest(tab)

    if (guest) {
      return { guest, paneId, tab }
    }

    await delay(50)
  }

  const { paneId, tab } = findTabLocationById(tabId, "core.browser", "Browser")

  return {
    guest: await createBackgroundBrowserGuest(tab),
    paneId,
    tab,
  }
}

async function runBrowserScript(input: {
  tabId: string
  code: string
  timeoutMs?: number
  actorId?: string
  viewId?: string
}): Promise<BrowserRunResult> {
  const code = input.code.trim()

  if (!code) {
    throw new Error("Usage: ensemble browser run [tab] <javascript>")
  }

  const { guest, paneId, tab } = await getBrowserGuest(input.tabId, 5_000)

  const result = await withTimeout(
    guest.executeJavaScript(code, true),
    input.timeoutMs ?? 10_000,
    "Browser script timed out.",
  )
  const url = guest.getURL()

  if (input.actorId && input.viewId) {
    await dispatchEnsembleCommand({
      command: {
        actorId: input.actorId,
        viewId: input.viewId,
        type: "tab.updateState",
        paneId,
        tabId: tab.id,
        state: { url },
      },
    })
  }

  return {
    tabId: tab.id,
    url,
    result,
  }
}

async function runTerminalTabCommand(input: {
  tabId: string
  command: string
  enter?: boolean
}): Promise<TerminalTabRunResult> {
  const tab = findTerminalTab(input.tabId)
  const sessionId = tab.state.terminalSessionId
  const command = input.command.trim()

  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new Error("Terminal tab is not ready. Activate the tab, then retry terminal run.")
  }

  if (!command) {
    throw new Error("Usage: ensemble terminal run <command> --tab <terminal-tab>")
  }

  const session = terminalSessions.get(sessionId)

  if (!session) {
    throw new Error("Terminal session is no longer available. Activate the terminal tab.")
  }

  session.pty.write(`${input.command}${input.enter === false ? "" : "\r"}`)

  return {
    tabId: tab.id,
    sessionId,
    command: input.command,
    cwd: session.cwd,
  }
}

async function runTerminal(input: {
  workspaceDirectory?: string
  command: string
  tabId?: string
  enter?: boolean
}): Promise<TerminalRunResult | TerminalTabRunResult> {
  if (typeof input.tabId === "string" && input.tabId.trim().length > 0) {
    return runTerminalTabCommand({
      tabId: input.tabId,
      command: input.command,
      enter: input.enter,
    })
  }

  if (typeof input.workspaceDirectory === "string" && input.workspaceDirectory.trim().length > 0) {
    return runWorkspaceTerminal({
      workspaceDirectory: input.workspaceDirectory,
      command: input.command,
    })
  }

  throw new Error("Usage: ensemble terminal run <command> --tab <terminal-tab>")
}

const routeHandlers = {
  "/ensemble/command": (input: EnsembleCommandRequest) => dispatchEnsembleCommand(input),
  "/chat/complete": chatComplete,
  "/agent/send": sendAgentTurn,
  "/agent/turn/start": startAgentTurn,
  "/agent/turn/interrupt": interruptAgentTurn,
  "/agent/approval/respond": respondAgentApproval,
  "/agent/user-input/respond": respondAgentUserInput,
  "/files/tree": getFileTree,
  "/files/list": listFiles,
  "/files/read": readWorkspaceFile,
  "/files/write": writeWorkspaceFile,
  "/terminal/run": runTerminal,
  "/terminal/session/create": createTerminalSession,
  "/terminal/session/input": inputTerminalSession,
  "/terminal/session/resize": resizeTerminalSession,
  "/terminal/session/close": closeTerminalSession,
  "/browser/run": runBrowserScript,
  "/review/get": getReview,
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk))
  }

  const body = Buffer.concat(chunks).toString("utf8")
  return body ? JSON.parse(body) : {}
}

async function writeJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): Promise<void> {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  })
  response.end(JSON.stringify(value))
}

function writeServerSentEvent(
  response: ServerResponse,
  event: TerminalSessionEvent | AgentStreamEvent | unknown,
): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

function subscribeEnsembleEvents(response: ServerResponse): void {
  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
  })
  response.write(": connected\n\n")
  writeServerSentEvent(response, {
    type: "state.snapshot",
    snapshot: getEnsembleSnapshot(),
  })

  const unsubscribe = subscribeEnsembleState((event) => {
    writeServerSentEvent(response, event)
  })
  response.on("close", unsubscribe)
}

function subscribeAgentEvents(sessionId: string, response: ServerResponse): void {
  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
  })
  response.write(": connected\n\n")

  for (const event of agentEventBacklogs.get(sessionId) ?? []) {
    writeServerSentEvent(response, event)
  }

  const subscribers = agentEventSubscribers.get(sessionId) ?? new Set<ServerResponse>()
  subscribers.add(response)
  agentEventSubscribers.set(sessionId, subscribers)
  response.on("close", () => {
    subscribers.delete(response)
    if (subscribers.size === 0) {
      agentEventSubscribers.delete(sessionId)
    }
  })
}

function subscribeTerminalSession(sessionId: string, response: ServerResponse): void {
  const session = terminalSessions.get(sessionId)

  if (!session) {
    response.writeHead(404, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "text/plain",
    })
    response.end("Terminal session not found")
    return
  }

  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
  })
  response.write(": connected\n\n")

  for (const event of session.backlog) {
    writeServerSentEvent(response, event)
  }

  session.subscribers.add(response)
  response.on("close", () => {
    session.subscribers.delete(response)
  })
}

export function startRuntimeHttpServer(): void {
  const server = createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      await writeJson(response, 204, {})
      return
    }

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1")

    if (request.method === "GET" && requestUrl.pathname === "/ensemble/state") {
      await writeJson(response, 200, getEnsembleSnapshot())
      return
    }

    if (request.method === "GET" && requestUrl.pathname === "/ensemble/events") {
      subscribeEnsembleEvents(response)
      return
    }

    if (request.method === "GET" && requestUrl.pathname === "/terminal/session/events") {
      subscribeTerminalSession(requestUrl.searchParams.get("sessionId") ?? "", response)
      return
    }

    if (request.method === "GET" && requestUrl.pathname === "/agent/events") {
      subscribeAgentEvents(requestUrl.searchParams.get("sessionId") ?? "", response)
      return
    }

    const handler = routeHandlers[requestUrl.pathname as keyof typeof routeHandlers]

    if (request.method !== "POST" || !handler) {
      await writeJson(response, 404, { error: "Not found" })
      return
    }

    try {
      await writeJson(response, 200, await handler((await readRequestJson(request)) as never))
    } catch (error) {
      response.writeHead(500, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/plain",
      })
      response.end(error instanceof Error ? error.message : "Request failed")
    }
  })

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE") {
      console.error("Runtime HTTP server failed", error)
    }
  })
  server.listen(runtimePort, "127.0.0.1")
}

export function registerRuntimeIpc(): void {
  ipcMain.handle("ensemble:state", () => getEnsembleSnapshot())
  ipcMain.handle("ensemble:dispatch", (_event, input: EnsembleCommandRequest) =>
    dispatchEnsembleCommand(input),
  )
  if (!ensembleIpcEventsRegistered) {
    subscribeEnsembleState((event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("ensemble:event", event)
      }
    })
    ensembleIpcEventsRegistered = true
  }

  ipcMain.handle("workspace:choose-directory", () => chooseWorkspaceDirectory())
  ipcMain.handle("chat:complete", (_event, input) => chatComplete(input))
  ipcMain.handle("agent:send", (_event, input) => sendAgentTurn(input))
  ipcMain.handle("agent:turn:start", (_event, input) => startAgentTurn(input))
  ipcMain.handle("agent:turn:interrupt", (_event, input) => interruptAgentTurn(input))
  ipcMain.handle("agent:approval:respond", (_event, input) => respondAgentApproval(input))
  ipcMain.handle("agent:user-input:respond", (_event, input) => respondAgentUserInput(input))
  ipcMain.handle("files:tree", (_event, input) => getFileTree(input))
  ipcMain.handle("files:list", (_event, input) => listFiles(input))
  ipcMain.handle("files:read", (_event, input) => readWorkspaceFile(input))
  ipcMain.handle("files:write", (_event, input) => writeWorkspaceFile(input))
  ipcMain.handle("terminal:run", (_event, input) => runWorkspaceTerminal(input))
  ipcMain.handle("terminal:session:create", (_event, input) => createTerminalSession(input))
  ipcMain.on("terminal:session:input", (_event, input) => {
    inputTerminalSession(input)
  })
  ipcMain.on("terminal:session:resize", (_event, input) => {
    resizeTerminalSession(input)
  })
  ipcMain.on("terminal:session:close", (_event, input) => {
    closeTerminalSession(input)
  })
  ipcMain.handle("review:get", (_event, input) => getReview(input))
}

export const runtimeMetadata = {
  testWorkspaceRoot,
}
