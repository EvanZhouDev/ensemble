export type AgentToolStatus = "running" | "success" | "error"

export type AgentToolItem = {
  id: string
  name: string
  status: AgentToolStatus
  input?: string
  output?: string
}

export type AgentApprovalDecision = "approve" | "decline"

export type AgentUserInputAnswer = {
  requestId: string
  answers: Record<string, string | string[]>
}

export type AgentStreamEventBase = {
  sessionId: string
  turnId: string
  sequence: number
  createdAt: number
}

export type AgentStreamEvent =
  | (AgentStreamEventBase & {
      type: "session.started"
      cwd: string
      providerThreadId: string
    })
  | (AgentStreamEventBase & {
      type: "turn.started"
      message: string
    })
  | (AgentStreamEventBase & {
      type: "assistant.delta"
      messageId: string
      delta: string
    })
  | (AgentStreamEventBase & {
      type: "assistant.completed"
      messageId: string
      content: string
    })
  | (AgentStreamEventBase & {
      type: "tool.started" | "tool.updated" | "tool.completed"
      tool: AgentToolItem
    })
  | (AgentStreamEventBase & {
      type: "approval.requested"
      requestId: string
      requestKind: "command" | "file-read" | "file-change" | "unknown"
      summary: string
      detail?: string
      payload?: unknown
    })
  | (AgentStreamEventBase & {
      type: "approval.resolved"
      requestId: string
      decision: AgentApprovalDecision
    })
  | (AgentStreamEventBase & {
      type: "user-input.requested"
      requestId: string
      summary: string
      payload?: unknown
    })
  | (AgentStreamEventBase & {
      type: "user-input.resolved"
      requestId: string
    })
  | (AgentStreamEventBase & {
      type: "turn.diff.updated"
      diff: string
    })
  | (AgentStreamEventBase & {
      type: "turn.completed"
      assistantMessage: string
      toolCalls: AgentToolItem[]
    })
  | (AgentStreamEventBase & {
      type: "runtime.error"
      message: string
      detail?: string
    })

export type AgentTurnStartResult = {
  sessionId: string
  turnId: string
  providerThreadId: string
}
