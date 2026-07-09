import type { ShellCommand, ShellState } from "./shellModel"

export const ENSEMBLE_CONTROL_VERSION = 1
export const ENSEMBLE_CONTROL_DEFAULT_URL = "http://127.0.0.1:10532"

export type EnsembleSnapshot = {
  state: ShellState
  version: number
  updatedAt: string
}

export type EnsembleCommandRequest = {
  commandId?: string
  command: ShellCommand
}

export type EnsembleCommandResponse = {
  commandId: string
  snapshot: EnsembleSnapshot
}

export type EnsembleStateEvent = {
  type: "state.changed"
  commandId: string
  command: ShellCommand
  snapshot: EnsembleSnapshot
}

export type EnsembleControlFile = {
  version: typeof ENSEMBLE_CONTROL_VERSION
  appName: "Ensemble"
  pid: number
  url: string
  statePath: string
  commandLogPath: string
  updatedAt: string
}
