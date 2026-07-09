/// <reference types="vite/client" />

type ChatRole = "user" | "assistant" | "system"

type ChatMessage = {
  role: ChatRole
  content: string
}

type ToolCallResult = {
  id: string
  name: string
  status: "running" | "success" | "error"
  input?: string
  output?: string
}

type AgentTurnResult = {
  assistantMessage: string
  toolCalls: ToolCallResult[]
}

type AgentStreamEvent = import("../../shared/agentEvents").AgentStreamEvent
type AgentTurnStartResult = import("../../shared/agentEvents").AgentTurnStartResult
type AgentApprovalDecision = import("../../shared/agentEvents").AgentApprovalDecision
type EnsembleSnapshot = import("../../shared/ensembleControl").EnsembleSnapshot
type EnsembleCommandRequest = import("../../shared/ensembleControl").EnsembleCommandRequest
type EnsembleCommandResponse = import("../../shared/ensembleControl").EnsembleCommandResponse
type EnsembleStateEvent = import("../../shared/ensembleControl").EnsembleStateEvent
type EnsembleSnapshotEvent = {
  type: "state.snapshot"
  snapshot: EnsembleSnapshot
}

type AppShortcut =
  | { type: "tab.close" }
  | { type: "tab.new" }
  | { type: "tab.next" }
  | { type: "tab.previous" }
  | { type: "tab.select"; index: number }

type FileTreeEntry = {
  name: string
  path: string
  type: "file" | "directory"
}

type FileTreeNode = FileTreeEntry & {
  id: string
  children?: FileTreeNode[]
}

type FileTreeResult = {
  directory: string
  entries: FileTreeEntry[]
}

type FileReadResult = {
  path: string
  content: string
  size: number
  modifiedAt: string
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

type TerminalSessionInfo = {
  sessionId: string
  cwd: string
  shell: string
}

type ReviewResult = {
  cwd: string
  status: string
  diffStat: string
  diff: string
  lastAgentTurn: AgentTurnResult | null
}

type WorkspaceDirectorySelection = {
  path: string
  name: string
}

type AppShellApi = {
  platform: string
  testWorkspaceRoot: string
  shortcuts?: {
    onShortcut(callback: (shortcut: AppShortcut) => void): () => void
  }
  ensemble: {
    getState(): Promise<EnsembleSnapshot>
    dispatch(input: EnsembleCommandRequest): Promise<EnsembleCommandResponse>
    onEvent(callback: (event: EnsembleStateEvent | EnsembleSnapshotEvent) => void): () => void
  }
  workspace?: {
    chooseDirectory(): Promise<WorkspaceDirectorySelection | null>
  }
  chat: {
    complete(input: {
      baseUrl: string
      apiKey: string
      model: string
      messages: ChatMessage[]
    }): Promise<{ content: string }>
  }
  agent: {
    send(input: {
      workspaceDirectory: string
      baseUrl: string
      apiKey: string
      model: string
      message: string
    }): Promise<AgentTurnResult>
    startTurn(input: {
      sessionId?: string
      workspaceDirectory: string
      actorId?: string
      viewId?: string
      baseUrl: string
      apiKey: string
      model: string
      message: string
    }): Promise<AgentTurnStartResult>
    interrupt(input: { sessionId: string }): Promise<void>
    respondApproval(input: {
      sessionId: string
      requestId: string
      decision: AgentApprovalDecision
    }): Promise<void>
    respondUserInput(input: {
      sessionId: string
      requestId: string
      answers: Record<string, string | string[]>
    }): Promise<void>
    onEvent(sessionId: string, callback: (event: AgentStreamEvent) => void): () => void
  }
  files: {
    tree(input: { workspaceDirectory: string }): Promise<{ entries: FileTreeNode[] }>
    list(input: { workspaceDirectory: string; path?: string }): Promise<FileTreeResult>
    read(input: { workspaceDirectory: string; path: string }): Promise<FileReadResult>
    write(input: {
      workspaceDirectory: string
      path: string
      content: string
    }): Promise<FileReadResult>
  }
  terminal: {
    run(input: { workspaceDirectory: string; command: string }): Promise<TerminalRunResult>
    create(input: {
      workspaceDirectory: string
      cols?: number
      rows?: number
    }): Promise<TerminalSessionInfo>
    input(input: { sessionId: string; data: string }): void
    resize(input: { sessionId: string; cols: number; rows: number }): void
    close(input: { sessionId: string }): void
    onEvent(sessionId: string, callback: (event: TerminalSessionEvent) => void): () => void
  }
  review: {
    get(input: { workspaceDirectory: string }): Promise<ReviewResult>
  }
}

interface Window {
  appShell?: AppShellApi
}
