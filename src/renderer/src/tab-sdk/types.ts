import type { Dispatch } from "react"
import type { ShellCommand, ShellCommandContext, Workspace, WorkspaceTab } from "../shellModel"

export type TabExtensionId = string
export type TabTypeId = string

export type TabRuntimeApi = AppShellApi

export type TabRenderContext = {
  tab: WorkspaceTab
  workspace: Workspace
  paneId: string
  commandContext: ShellCommandContext
  dispatch: Dispatch<ShellCommand>
  api: TabRuntimeApi
}

export type TabTypeDefinition = {
  id: TabTypeId
  extensionId: TabExtensionId
  title: string
  description: string
  state?: Record<string, unknown>
  render: (context: TabRenderContext) => React.JSX.Element
}

export type TabExtensionDefinition = {
  id: TabExtensionId
  title: string
  description: string
  tabs: TabTypeDefinition[]
}
