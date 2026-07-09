import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { app } from "electron"
import {
  ENSEMBLE_CONTROL_VERSION,
  type EnsembleCommandRequest,
  type EnsembleCommandResponse,
  type EnsembleControlFile,
  type EnsembleSnapshot,
  type EnsembleStateEvent,
} from "../shared/ensembleControl"
import {
  collectPanes,
  initialShellState,
  type ShellCommand,
  type ShellState,
  shellReducer,
} from "../shared/shellModel"

type EnsembleStateListener = (event: EnsembleStateEvent) => void

let state: ShellState = initialShellState
let version = 0
let statePath = ""
let commandLogPath = ""
let controlFilePath = ""
const listeners = new Set<EnsembleStateListener>()

function nowIso(): string {
  return new Date().toISOString()
}

function createCommandId(): string {
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isShellState(value: unknown): value is ShellState {
  if (!isObject(value)) {
    return false
  }

  return (
    Array.isArray(value.actors) &&
    Array.isArray(value.views) &&
    Array.isArray(value.workspaces) &&
    typeof value.activeActorId === "string" &&
    typeof value.activeViewId === "string"
  )
}

function getSnapshot(): EnsembleSnapshot {
  return {
    state,
    version,
    updatedAt: nowIso(),
  }
}

async function persistSnapshot(snapshot: EnsembleSnapshot): Promise<void> {
  if (!statePath) {
    return
  }

  await writeFile(statePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
}

async function appendCommandLog(
  commandId: string,
  command: ShellCommand,
  snapshot: EnsembleSnapshot,
): Promise<void> {
  if (!commandLogPath) {
    return
  }

  await appendFile(
    commandLogPath,
    `${JSON.stringify({
      commandId,
      command,
      version: snapshot.version,
      createdAt: snapshot.updatedAt,
    })}\n`,
    "utf8",
  )
}

async function readPersistedSnapshot(): Promise<void> {
  if (!statePath) {
    return
  }

  try {
    const snapshot = JSON.parse(await readFile(statePath, "utf8")) as Partial<EnsembleSnapshot>

    if (isShellState(snapshot.state)) {
      state = snapshot.state
      version = typeof snapshot.version === "number" ? snapshot.version : 0
    }
  } catch {
    const snapshot = getSnapshot()
    await persistSnapshot(snapshot)
  }
}

async function writeControlFile(url: string): Promise<void> {
  if (!controlFilePath) {
    return
  }

  const controlFile: EnsembleControlFile = {
    version: ENSEMBLE_CONTROL_VERSION,
    appName: "Ensemble",
    pid: process.pid,
    url,
    statePath,
    commandLogPath,
    updatedAt: nowIso(),
  }

  await writeFile(controlFilePath, `${JSON.stringify(controlFile, null, 2)}\n`, "utf8")
}

export async function initializeEnsembleCore(input: { controlUrl: string }): Promise<void> {
  const userDataPath = app.getPath("userData")

  await mkdir(userDataPath, { recursive: true })
  statePath = join(userDataPath, "ensemble-state.json")
  commandLogPath = join(userDataPath, "ensemble-commands.jsonl")
  controlFilePath = join(userDataPath, "control.json")
  await readPersistedSnapshot()
  await writeControlFile(input.controlUrl)
}

export function getEnsembleSnapshot(): EnsembleSnapshot {
  return getSnapshot()
}

export async function dispatchEnsembleCommand(
  request: EnsembleCommandRequest,
): Promise<EnsembleCommandResponse> {
  const commandId = request.commandId ?? createCommandId()
  const nextState = shellReducer(state, request.command)
  const didChange = nextState !== state

  if (didChange) {
    state = nextState
    version += 1
  }

  const snapshot = getSnapshot()

  await persistSnapshot(snapshot)
  await appendCommandLog(commandId, request.command, snapshot)

  if (didChange) {
    const event: EnsembleStateEvent = {
      type: "state.changed",
      commandId,
      command: request.command,
      snapshot,
    }

    for (const listener of listeners) {
      listener(event)
    }
  }

  return { commandId, snapshot }
}

export function subscribeEnsembleState(listener: EnsembleStateListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getEnsembleControlFilePath(): string {
  return controlFilePath
}

export function assertHealthyShellState(): void {
  for (const workspace of state.workspaces) {
    for (const pane of collectPanes(workspace.root)) {
      if (pane.tabs.length === 0) {
        throw new Error(`Workspace ${workspace.id} has an empty pane ${pane.id}.`)
      }
    }
  }
}
