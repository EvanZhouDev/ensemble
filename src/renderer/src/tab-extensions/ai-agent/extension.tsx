import {
  Bot,
  ChevronDown,
  FilePenLine,
  GitCompareArrows,
  Send,
  Settings2,
  Square,
  Terminal,
  Wrench,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { TabExtensionDefinition, TabRenderContext } from "../../tab-sdk"

const DEFAULT_BASE_URL = "http://127.0.0.1:10531/v1"
const DEFAULT_MODEL = "gpt-5.5"

type ChatThreadItem =
  | {
      id: string
      type: "message"
      role: Exclude<ChatRole, "system">
      content: string
      streaming?: boolean
      turnId?: string
    }
  | {
      id: string
      type: "tool"
      toolCall: ToolCallResult
      turnId?: string
    }
  | {
      id: string
      type: "approval"
      requestId: string
      requestKind: "command" | "file-read" | "file-change" | "unknown"
      summary: string
      detail?: string
      status: "pending" | "approved" | "declined"
      turnId?: string
    }
  | {
      id: string
      type: "working"
      turnId: string
      label: string
    }

type ChatTabState = {
  sessionId?: string
  agentActorId?: string
  agentViewId?: string
  activeTurnId?: string
  sessionStatus?: "idle" | "running" | "error"
  baseUrl?: string
  apiKey?: string
  model?: string
  messages?: ChatMessage[]
  toolCalls?: ToolCallResult[]
  thread?: ChatThreadItem[]
  processedEventIds?: string[]
}

type NormalizedChatState = {
  sessionId: string
  agentActorId?: string
  agentViewId?: string
  activeTurnId?: string
  sessionStatus: "idle" | "running" | "error"
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  toolCalls: ToolCallResult[]
  thread: ChatThreadItem[]
  processedEventIds: string[]
}

function createThreadItemId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function isUserVisibleRole(role: ChatRole): role is Exclude<ChatRole, "system"> {
  return role === "user" || role === "assistant"
}

function migrateMessagesToThread(
  messages: ChatMessage[],
  toolCalls: ToolCallResult[],
): ChatThreadItem[] {
  const thread: ChatThreadItem[] = []
  let finalAssistantIndex = -1

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      finalAssistantIndex = index
      break
    }
  }

  messages.forEach((message, index) => {
    if (index === finalAssistantIndex) {
      thread.push(
        ...toolCalls.map((toolCall, toolIndex) => ({
          id: `legacy-tool-${toolCall.id || toolCall.name}-${toolIndex}`,
          type: "tool" as const,
          toolCall,
        })),
      )
    }

    if (isUserVisibleRole(message.role)) {
      thread.push({
        id: `legacy-message-${index}`,
        type: "message",
        role: message.role,
        content: message.content,
      })
    }
  })

  if (finalAssistantIndex === -1) {
    thread.push(
      ...toolCalls.map((toolCall, toolIndex) => ({
        id: `legacy-tool-${toolCall.id || toolCall.name}-${toolIndex}`,
        type: "tool" as const,
        toolCall,
      })),
    )
  }

  return thread
}

function getChatState(context: TabRenderContext): NormalizedChatState {
  const state = context.tab.state as ChatTabState
  const messages = state.messages ?? []
  const toolCalls = state.toolCalls ?? []

  return {
    sessionId: state.sessionId ?? context.tab.id,
    agentActorId: state.agentActorId,
    agentViewId: state.agentViewId,
    activeTurnId: state.activeTurnId,
    sessionStatus: state.sessionStatus ?? "idle",
    baseUrl: state.baseUrl ?? DEFAULT_BASE_URL,
    apiKey: state.apiKey ?? "",
    model: state.model ?? DEFAULT_MODEL,
    messages,
    toolCalls,
    thread: state.thread ?? migrateMessagesToThread(messages, toolCalls),
    processedEventIds: state.processedEventIds ?? [],
  }
}

function createChatAgentActorId(tabId: string): string {
  return `agent-actor-${tabId}`
}

function createChatAgentViewId(tabId: string): string {
  return `agent-view-${tabId}`
}

function getChatAgentIdentity(
  context: TabRenderContext,
  state: NormalizedChatState,
): { actorId: string; viewId: string; name: string } {
  return {
    actorId: state.agentActorId ?? createChatAgentActorId(context.tab.id),
    viewId: state.agentViewId ?? createChatAgentViewId(context.tab.id),
    name: `${context.tab.title} Agent`,
  }
}

async function ensureChatAgentActor(
  context: TabRenderContext,
  identity: { actorId: string; viewId: string; name: string },
): Promise<void> {
  await context.api.ensemble.dispatch({
    command: {
      ...context.commandContext,
      type: "actor.ensure",
      targetActorId: identity.actorId,
      targetViewId: identity.viewId,
      name: identity.name,
      workspaceId: context.workspace.id,
      focusedPaneId: context.paneId,
      activeTabId: context.tab.id,
    },
  })
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

function messagesFromThread(thread: ChatThreadItem[]): ChatMessage[] {
  return thread
    .filter((item): item is Extract<ChatThreadItem, { type: "message" }> => item.type === "message")
    .map((item) => ({ role: item.role, content: item.content }))
}

function toolCallsFromThread(thread: ChatThreadItem[]): ToolCallResult[] {
  return thread
    .filter((item): item is Extract<ChatThreadItem, { type: "tool" }> => item.type === "tool")
    .map((item) => item.toolCall)
}

function withDerivedChatState(
  state: Omit<NormalizedChatState, "messages" | "toolCalls">,
): NormalizedChatState {
  return {
    ...state,
    messages: messagesFromThread(state.thread),
    toolCalls: toolCallsFromThread(state.thread),
  }
}

function markEventProcessed(
  state: NormalizedChatState,
  event: AgentStreamEvent,
  nextState: NormalizedChatState,
): NormalizedChatState {
  const eventId = `${event.sessionId}:${event.sequence}`
  const processedEventIds = [...state.processedEventIds, eventId].slice(-500)

  return {
    ...nextState,
    processedEventIds,
  }
}

function hasProcessedEvent(state: NormalizedChatState, event: AgentStreamEvent): boolean {
  return state.processedEventIds.includes(`${event.sessionId}:${event.sequence}`)
}

function upsertThreadMessage(
  thread: ChatThreadItem[],
  message: Extract<ChatThreadItem, { type: "message" }>,
): ChatThreadItem[] {
  const index = thread.findIndex((item) => item.type === "message" && item.id === message.id)

  if (index < 0) {
    return [...thread, message]
  }

  return thread.map((item, itemIndex) =>
    itemIndex === index && item.type === "message" ? { ...item, ...message } : item,
  )
}

function upsertThreadTool(
  thread: ChatThreadItem[],
  tool: ToolCallResult,
  turnId?: string,
): ChatThreadItem[] {
  const index = thread.findIndex((item) => item.type === "tool" && item.toolCall.id === tool.id)

  if (index < 0) {
    return [
      ...thread,
      {
        id: `tool-${tool.id}`,
        type: "tool",
        toolCall: tool,
        turnId,
      },
    ]
  }

  return thread.map((item, itemIndex) =>
    itemIndex === index && item.type === "tool"
      ? { ...item, toolCall: { ...item.toolCall, ...tool }, turnId: turnId ?? item.turnId }
      : item,
  )
}

function removeWorkingItem(thread: ChatThreadItem[], turnId: string): ChatThreadItem[] {
  return thread.filter((item) => !(item.type === "working" && item.turnId === turnId))
}

function upsertTurnUserMessage(
  thread: ChatThreadItem[],
  turnId: string,
  content: string,
): ChatThreadItem[] {
  const existingTurnUser = thread.some(
    (item) => item.type === "message" && item.role === "user" && item.turnId === turnId,
  )

  if (existingTurnUser) {
    return thread
  }

  for (let index = thread.length - 1; index >= 0; index -= 1) {
    const item = thread[index]

    if (
      item?.type === "message" &&
      item.role === "user" &&
      !item.turnId &&
      item.content === content
    ) {
      return thread.map((candidate, candidateIndex) =>
        candidateIndex === index && candidate.type === "message"
          ? { ...candidate, turnId }
          : candidate,
      )
    }
  }

  return upsertThreadMessage(thread, {
    id: `user-${turnId}`,
    type: "message",
    role: "user",
    content,
    turnId,
  })
}

function upsertAssistantMessage(
  thread: ChatThreadItem[],
  turnId: string,
  content: string,
  streaming: boolean,
  messageId: string,
): ChatThreadItem[] {
  return upsertThreadMessage(thread, {
    id: messageId,
    type: "message",
    role: "assistant",
    content,
    streaming,
    turnId,
  })
}

function isEventForActiveTurn(state: NormalizedChatState, turnId: string): boolean {
  return !state.activeTurnId || state.activeTurnId === turnId
}

function runningStateForEvent(
  state: NormalizedChatState,
  turnId: string,
): Pick<NormalizedChatState, "activeTurnId" | "sessionStatus"> {
  if (!isEventForActiveTurn(state, turnId)) {
    return {
      activeTurnId: state.activeTurnId,
      sessionStatus: state.sessionStatus,
    }
  }

  return {
    activeTurnId: turnId,
    sessionStatus: "running",
  }
}

function idleStateForEvent(
  state: NormalizedChatState,
  turnId: string,
): Pick<NormalizedChatState, "activeTurnId" | "sessionStatus"> {
  if (!isEventForActiveTurn(state, turnId)) {
    return {
      activeTurnId: state.activeTurnId,
      sessionStatus: state.sessionStatus,
    }
  }

  return {
    activeTurnId: undefined,
    sessionStatus: "idle",
  }
}

function applyAgentEvent(state: NormalizedChatState, event: AgentStreamEvent): NormalizedChatState {
  switch (event.type) {
    case "session.started":
      return {
        ...state,
        sessionId: event.sessionId,
        activeTurnId: event.turnId,
        sessionStatus: "running",
      }
    case "turn.started": {
      return withDerivedChatState({
        ...state,
        ...runningStateForEvent(state, event.turnId),
        thread: upsertTurnUserMessage(state.thread, event.turnId, event.message),
      })
    }
    case "assistant.delta": {
      const existing = state.thread.find(
        (item) => item.type === "message" && item.id === event.messageId,
      )
      const nextContent =
        existing?.type === "message" ? `${existing.content}${event.delta}` : event.delta
      return withDerivedChatState({
        ...state,
        thread: upsertAssistantMessage(
          state.thread,
          event.turnId,
          nextContent,
          true,
          event.messageId,
        ),
      })
    }
    case "assistant.completed":
      return withDerivedChatState({
        ...state,
        thread: upsertAssistantMessage(
          state.thread,
          event.turnId,
          event.content,
          false,
          event.messageId,
        ),
      })
    case "tool.started":
    case "tool.updated":
    case "tool.completed":
      return withDerivedChatState({
        ...state,
        thread: upsertThreadTool(state.thread, event.tool, event.turnId),
      })
    case "approval.requested":
      return withDerivedChatState({
        ...state,
        thread: [
          ...state.thread,
          {
            id: `approval-${event.requestId}`,
            type: "approval",
            requestId: event.requestId,
            requestKind: event.requestKind,
            summary: event.summary,
            detail: event.detail,
            status: "pending",
            turnId: event.turnId,
          },
        ],
      })
    case "approval.resolved":
      return withDerivedChatState({
        ...state,
        thread: state.thread.map((item) =>
          item.type === "approval" && item.requestId === event.requestId
            ? { ...item, status: event.decision === "approve" ? "approved" : "declined" }
            : item,
        ),
      })
    case "user-input.requested":
      return withDerivedChatState({
        ...state,
        thread: upsertThreadTool(
          state.thread,
          {
            id: `user-input-${event.requestId}`,
            name: "codex_app_server.user_input",
            status: "running",
            output: event.summary,
            input: JSON.stringify(event.payload, null, 2),
          },
          event.turnId,
        ),
      })
    case "user-input.resolved":
      return withDerivedChatState({
        ...state,
        thread: upsertThreadTool(
          state.thread,
          {
            id: `user-input-${event.requestId}`,
            name: "codex_app_server.user_input",
            status: "success",
            output: "User input sent.",
          },
          event.turnId,
        ),
      })
    case "turn.diff.updated":
      return withDerivedChatState({
        ...state,
        thread: upsertThreadTool(
          state.thread,
          {
            id: `diff-${event.turnId}`,
            name: "codex_app_server.diff",
            status: "running",
            output: event.diff,
          },
          event.turnId,
        ),
      })
    case "turn.completed": {
      const thread = removeWorkingItem(state.thread, event.turnId)
      const assistantMessage = event.assistantMessage.trim()
      const hasAssistantMessage = thread.some(
        (item) =>
          item.type === "message" && item.role === "assistant" && item.turnId === event.turnId,
      )

      return withDerivedChatState({
        ...state,
        ...idleStateForEvent(state, event.turnId),
        thread:
          assistantMessage && !hasAssistantMessage
            ? upsertAssistantMessage(
                thread,
                event.turnId,
                assistantMessage,
                false,
                `${event.turnId}-assistant-summary`,
              )
            : thread,
      })
    }
    case "runtime.error":
      return withDerivedChatState({
        ...state,
        activeTurnId: isEventForActiveTurn(state, event.turnId) ? undefined : state.activeTurnId,
        sessionStatus: isEventForActiveTurn(state, event.turnId) ? "error" : state.sessionStatus,
        thread: upsertThreadTool(
          removeWorkingItem(state.thread, event.turnId),
          {
            id: `runtime-error-${event.sequence}`,
            name: "codex_app_server.error",
            status: "error",
            input: event.message,
            output: event.detail ?? event.message,
          },
          event.turnId,
        ),
      })
  }
}

export function reduceAgentEvent(
  state: NormalizedChatState,
  event: AgentStreamEvent,
): NormalizedChatState {
  if (hasProcessedEvent(state, event)) {
    return state
  }

  return markEventProcessed(state, event, applyAgentEvent(state, event))
}

function renderInlineText(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let offset = 0

  for (const part of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
    const key = `${offset}-${part}`

    if (part.startsWith("`") && part.endsWith("`")) {
      nodes.push(<code key={key}>{part.slice(1, -1)}</code>)
    } else if (part.startsWith("**") && part.endsWith("**")) {
      nodes.push(<strong key={key}>{part.slice(2, -2)}</strong>)
    } else {
      nodes.push(<span key={key}>{part}</span>)
    }

    offset += part.length
  }

  return nodes
}

function renderAssistantContent(content: string): React.ReactNode {
  const blocks = content.trim().split(/\n{2,}/)
  const nodes: React.ReactNode[] = []
  let blockOffset = 0

  for (const block of blocks) {
    const lines = block.split("\n")
    const listLines = lines.filter((line) => line.trim().startsWith("- "))
    const blockKey = `${blockOffset}-${block}`

    if (listLines.length === lines.length) {
      let lineOffset = 0
      nodes.push(
        <ul key={blockKey}>
          {lines.map((line) => {
            const key = `${lineOffset}-${line}`
            lineOffset += line.length
            return <li key={key}>{renderInlineText(line.trim().slice(2))}</li>
          })}
        </ul>,
      )
      blockOffset += block.length
      continue
    }

    let lineOffset = 0
    nodes.push(
      <p key={blockKey}>
        {lines.map((line) => {
          const key = `${lineOffset}-${line}`
          const lineIndex = lineOffset
          lineOffset += line.length
          return (
            <span key={key}>
              {renderInlineText(line)}
              {lineIndex < block.length - line.length ? <br /> : null}
            </span>
          )
        })}
      </p>,
    )
    blockOffset += block.length
  }

  return nodes
}

function formatToolName(name: string): string {
  return name
    .split(/[._-]/g)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ")
}

function findNextDiffStat(thread: ChatThreadItem[], index: number): string | undefined {
  for (const item of thread.slice(index + 1)) {
    if (item.type === "tool" && item.toolCall.name === "git.diff_stat") {
      return item.toolCall.output
    }
  }

  return undefined
}

function parseChangeCounts(diffStat?: string): { additions?: number; deletions?: number } {
  if (!diffStat) {
    return {}
  }

  const additions = diffStat.match(/(\d+) insertions?\(\+\)/)?.[1]
  const deletions = diffStat.match(/(\d+) deletions?\(-\)/)?.[1]

  return {
    additions: additions ? Number(additions) : undefined,
    deletions: deletions ? Number(deletions) : undefined,
  }
}

function getToolSummary(toolCall: ToolCallResult): {
  icon: React.ReactNode
  title: string
  detail?: string
} {
  if (toolCall.name === "write_file" || toolCall.name === "file_change") {
    return {
      icon: <FilePenLine size={14} />,
      title: "Edited a file",
      detail: toolCall.input || "agent-notes.md",
    }
  }

  if (toolCall.name === "git.diff_stat") {
    return {
      icon: <GitCompareArrows size={14} />,
      title: "Checked diff",
      detail: toolCall.output?.trim() || "No workspace diff.",
    }
  }

  if (toolCall.name === "command_execution") {
    return {
      icon: <Terminal size={14} />,
      title: "Ran command",
      detail: toolCall.input?.trim() || toolCall.output?.trim(),
    }
  }

  if (toolCall.name.startsWith("mcp_tool_call") || toolCall.name.startsWith("dynamic_tool_call")) {
    return {
      icon: <Wrench size={14} />,
      title: formatToolName(toolCall.name),
      detail: toolCall.output?.trim() || toolCall.input,
    }
  }

  if (toolCall.name.includes("app_server") || toolCall.name.includes("daemon")) {
    return {
      icon: <Terminal size={14} />,
      title: toolCall.name.endsWith(".thread")
        ? "Started Codex App Server thread"
        : "Codex App Server",
      detail: toolCall.output?.trim() || toolCall.input,
    }
  }

  return {
    icon: <Wrench size={14} />,
    title: formatToolName(toolCall.name),
    detail: toolCall.output?.trim() || toolCall.input,
  }
}

function getCommandOutput(toolCall: ToolCallResult): string | undefined {
  if (toolCall.name !== "command_execution") {
    return undefined
  }

  const output = toolCall.output?.trim()

  if (!output || output === toolCall.input?.trim()) {
    return undefined
  }

  return output
}

function shouldOpenToolCall(toolCall: ToolCallResult): boolean {
  return (
    toolCall.status === "error" || toolCall.name === "write_file" || toolCall.name === "file_change"
  )
}

function ThreadToolItem({
  index,
  item,
  thread,
}: {
  index: number
  item: Extract<ChatThreadItem, { type: "tool" }>
  thread: ChatThreadItem[]
}): React.JSX.Element {
  const { toolCall } = item
  const summary = getToolSummary(toolCall)
  const diffStat = findNextDiffStat(thread, index)
  const counts = parseChangeCounts(diffStat)
  const isFileEdit = toolCall.name === "write_file" || toolCall.name === "file_change"
  const commandOutput = getCommandOutput(toolCall)
  const filePath = summary.detail ?? "workspace file"
  const shouldAutoOpen = shouldOpenToolCall(toolCall)
  const [isOpen, setIsOpen] = useState(shouldAutoOpen)

  useEffect(() => {
    if (shouldAutoOpen) {
      setIsOpen(true)
    }
  }, [shouldAutoOpen])

  return (
    <details
      className={`thread-activity activity-${toolCall.status}`}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
      open={isOpen}
    >
      <summary>
        <span className="activity-icon">{summary.icon}</span>
        <span>{summary.title}</span>
        <ChevronDown className="activity-caret" size={14} />
      </summary>
      <div className="activity-body">
        {isFileEdit ? (
          <div className="change-row">
            <span>
              Edited <strong>{filePath}</strong>
            </span>
            {counts.additions !== undefined ? (
              <span className="additions">+{counts.additions}</span>
            ) : null}
            {counts.deletions !== undefined ? (
              <span className="deletions">-{counts.deletions}</span>
            ) : null}
          </div>
        ) : summary.detail ? (
          <div className="activity-field">
            <span>{toolCall.name === "command_execution" ? "Command" : "Detail"}</span>
            <pre>{summary.detail}</pre>
          </div>
        ) : null}
        {commandOutput ? (
          <div className="activity-field">
            <span>Output</span>
            <pre>{commandOutput}</pre>
          </div>
        ) : null}
        {toolCall.input && !isFileEdit && toolCall.name !== "command_execution" ? (
          <div className="activity-field">
            <span>Input</span>
            <pre>{toolCall.input}</pre>
          </div>
        ) : null}
      </div>
    </details>
  )
}

function ReviewToolCall({ toolCall }: { toolCall: ToolCallResult }): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(true)

  return (
    <details
      className={`tool-call tool-call-${toolCall.status}`}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
      open={isOpen}
    >
      <summary>{toolCall.name}</summary>
      {toolCall.output ? <pre>{toolCall.output}</pre> : null}
    </details>
  )
}

function ThreadMessageItem({
  item,
}: {
  item: Extract<ChatThreadItem, { type: "message" }>
}): React.JSX.Element {
  if (item.role === "user") {
    return (
      <article className="thread-message thread-message-user">
        <div className="user-bubble">{item.content}</div>
      </article>
    )
  }

  return (
    <article className="thread-message thread-message-assistant">
      <div className="assistant-message">
        {renderAssistantContent(item.content)}
        {item.streaming ? <span className="streaming-cursor" aria-hidden="true" /> : null}
      </div>
    </article>
  )
}

function ThreadWorkingItem({
  item,
}: {
  item: Extract<ChatThreadItem, { type: "working" }>
}): React.JSX.Element {
  return (
    <div className="thread-activity activity-running" aria-live="polite">
      <div className="working-row">
        <span className="working-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span>{item.label}</span>
      </div>
    </div>
  )
}

function ThreadApprovalItem({
  context,
  item,
}: {
  context: TabRenderContext
  item: Extract<ChatThreadItem, { type: "approval" }>
}): React.JSX.Element {
  const isPending = item.status === "pending"

  async function respond(decision: AgentApprovalDecision): Promise<void> {
    await context.api.agent.respondApproval({
      sessionId: getChatState(context).sessionId,
      requestId: item.requestId,
      decision,
    })
  }

  return (
    <section className={`thread-activity approval-row approval-${item.status}`}>
      <div className="approval-heading">
        <Wrench size={14} />
        <span>{item.summary}</span>
        <span className="approval-status">{item.status}</span>
      </div>
      {item.detail ? <pre>{item.detail}</pre> : null}
      {isPending ? (
        <div className="approval-actions">
          <button onClick={() => void respond("approve")} type="button">
            Approve
          </button>
          <button onClick={() => void respond("decline")} type="button">
            Decline
          </button>
        </div>
      ) : null}
    </section>
  )
}

function ChatTab(context: TabRenderContext): React.JSX.Element {
  const initialState = getChatState(context)
  const [chatState, setChatState] = useState(initialState)
  const contextRef = useRef(context)
  const chatStateRef = useRef(chatState)
  const commitChatStateRef = useRef<(nextState: NormalizedChatState) => void>(() => undefined)
  const commandQueueRef = useRef<Promise<void>>(Promise.resolve())
  const threadEndRef = useRef<HTMLDivElement | null>(null)
  const threadLength = chatState.thread.length
  const [baseUrl, setBaseUrl] = useState(initialState.baseUrl)
  const [apiKey, setApiKey] = useState(initialState.apiKey)
  const [model, setModel] = useState(initialState.model)
  const [input, setInput] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [isInterrupting, setIsInterrupting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isRunning = chatState.sessionStatus === "running"
  const visibleThread = chatState.thread.filter((item) => item.type !== "working")
  const workingItem: Extract<ChatThreadItem, { type: "working" }> = {
    id: `working-${chatState.activeTurnId ?? chatState.sessionId}`,
    type: "working",
    turnId: chatState.activeTurnId ?? chatState.sessionId,
    label: "Working...",
  }
  const agentApi = context.api.agent
  contextRef.current = context

  function commitChatState(nextState: NormalizedChatState): void {
    chatStateRef.current = nextState
    setChatState(nextState)
    updateTabState(contextRef.current, {
      sessionId: nextState.sessionId,
      activeTurnId: nextState.activeTurnId,
      sessionStatus: nextState.sessionStatus,
      baseUrl: nextState.baseUrl,
      apiKey: nextState.apiKey,
      model: nextState.model,
      agentActorId: nextState.agentActorId,
      agentViewId: nextState.agentViewId,
      messages: nextState.messages,
      toolCalls: nextState.toolCalls,
      thread: nextState.thread,
      processedEventIds: nextState.processedEventIds,
    })
  }
  commitChatStateRef.current = commitChatState

  function enqueueAgentCommand(operation: () => Promise<void>): Promise<void> {
    const next = commandQueueRef.current.catch(() => undefined).then(operation)
    commandQueueRef.current = next.catch(() => undefined)
    return next
  }

  useEffect(() => {
    const latestState = getChatState(contextRef.current)
    chatStateRef.current = latestState
    setChatState(latestState)
    setBaseUrl(latestState.baseUrl)
    setApiKey(latestState.apiKey)
    setModel(latestState.model)
  }, [])

  useEffect(() => {
    return agentApi.onEvent(chatState.sessionId, (event) => {
      const nextState = reduceAgentEvent(chatStateRef.current, event)
      commitChatStateRef.current(nextState)
    })
  }, [agentApi, chatState.sessionId])

  useEffect(() => {
    if (threadLength > 0) {
      threadEndRef.current?.scrollIntoView({ block: "end" })
    }
  }, [threadLength])

  async function sendMessage(): Promise<void> {
    const message = input.trim()

    if (!message || isSending) {
      return
    }

    setInput("")
    setIsSending(true)
    setError(null)

    const nextState = withDerivedChatState({
      ...chatStateRef.current,
      baseUrl,
      apiKey,
      model,
      sessionStatus: "running",
      thread: [
        ...chatStateRef.current.thread,
        {
          id: createThreadItemId("user"),
          type: "message",
          role: "user",
          content: message,
        },
      ],
    })
    const agentIdentity = getChatAgentIdentity(contextRef.current, nextState)
    const ownedNextState = {
      ...nextState,
      agentActorId: agentIdentity.actorId,
      agentViewId: agentIdentity.viewId,
    }
    commitChatState(ownedNextState)

    try {
      await enqueueAgentCommand(async () => {
        await ensureChatAgentActor(contextRef.current, agentIdentity)
        const result = await context.api.agent.startTurn({
          sessionId: chatStateRef.current.sessionId,
          workspaceDirectory: context.workspace.directory,
          actorId: agentIdentity.actorId,
          viewId: agentIdentity.viewId,
          baseUrl,
          apiKey,
          model,
          message,
        })
        const currentState = chatStateRef.current
        commitChatState({
          ...currentState,
          sessionId: result.sessionId,
          activeTurnId:
            currentState.sessionStatus === "running"
              ? (currentState.activeTurnId ?? result.turnId)
              : currentState.activeTurnId,
        })
      })
    } catch (caughtError) {
      const messageText =
        caughtError instanceof Error ? caughtError.message : "Agent request failed."
      setError(messageText)
      commitChatState(
        withDerivedChatState({
          ...chatStateRef.current,
          sessionStatus: "error",
          thread: upsertThreadTool(chatStateRef.current.thread, {
            id: createThreadItemId("agent-error"),
            name: "codex_app_server.error",
            status: "error",
            input: "Agent request failed",
            output: messageText,
          }),
        }),
      )
    } finally {
      setIsSending(false)
    }
  }

  async function interruptTurn(): Promise<void> {
    const interruptedTurnId = chatStateRef.current.activeTurnId

    if (chatStateRef.current.sessionStatus !== "running") {
      return
    }

    setError(null)
    setIsInterrupting(true)
    commitChatState(
      withDerivedChatState({
        ...chatStateRef.current,
        activeTurnId: undefined,
        sessionStatus: "idle",
        thread: interruptedTurnId
          ? removeWorkingItem(chatStateRef.current.thread, interruptedTurnId)
          : chatStateRef.current.thread,
      }),
    )

    try {
      if (interruptedTurnId) {
        await enqueueAgentCommand(async () => {
          await context.api.agent.interrupt({ sessionId: chatStateRef.current.sessionId })
        })
      }
    } catch (caughtError) {
      const latestState = chatStateRef.current

      if (
        latestState.sessionStatus === "running" &&
        latestState.activeTurnId === interruptedTurnId
      ) {
        setError(caughtError instanceof Error ? caughtError.message : "Interrupt failed.")
      }
    } finally {
      setIsInterrupting(false)
    }
  }

  function persistConfig(): void {
    commitChatState({
      ...chatStateRef.current,
      baseUrl,
      apiKey,
      model,
    })
  }

  function renderThreadItem(
    item: ChatThreadItem,
    index: number,
    thread: ChatThreadItem[],
  ): React.JSX.Element {
    if (item.type === "message") {
      return <ThreadMessageItem item={item} key={item.id} />
    }

    if (item.type === "tool") {
      return <ThreadToolItem index={index} item={item} key={item.id} thread={thread} />
    }

    if (item.type === "approval") {
      return <ThreadApprovalItem context={context} item={item} key={item.id} />
    }

    return <ThreadWorkingItem item={item} key={item.id} />
  }

  return (
    <div className="tab-surface agent-tab">
      <details className="agent-config-details">
        <summary>
          <Settings2 size={14} />
          <span className="settings-label">Settings</span>
          <span className="settings-meta">
            {model} · {baseUrl}
          </span>
          <span className={`agent-session-status status-${chatState.sessionStatus}`}>
            {chatState.sessionStatus}
          </span>
          <ChevronDown className="activity-caret" size={14} />
        </summary>
        <section className="config-grid" aria-label="Agent configuration">
          <label>
            <span>Base URL</span>
            <input
              onBlur={persistConfig}
              onChange={(event) => setBaseUrl(event.target.value)}
              value={baseUrl}
            />
          </label>
          <label>
            <span>Model</span>
            <input
              onBlur={persistConfig}
              onChange={(event) => setModel(event.target.value)}
              value={model}
            />
          </label>
          <label>
            <span>API Key</span>
            <input
              onBlur={persistConfig}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Optional"
              type="password"
              value={apiKey}
            />
          </label>
        </section>
      </details>

      <section className="codex-thread" aria-label="Thread">
        {visibleThread.length === 0 && !isRunning ? (
          <div className="codex-empty">
            <div className="empty-tab-mark">
              <Bot size={28} />
            </div>
            <span>New Codex thread</span>
          </div>
        ) : (
          <>
            {visibleThread.map((item, index) => renderThreadItem(item, index, visibleThread))}
            {isRunning ? <ThreadWorkingItem item={workingItem} /> : null}
          </>
        )}
        <div ref={threadEndRef} />
      </section>

      <footer className="composer">
        <textarea
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void sendMessage()
            }
          }}
          placeholder={
            isRunning
              ? "Steer the running agent with another instruction"
              : "Ask the agent to inspect files or make a small workspace change"
          }
          value={input}
        />
        <div className="composer-actions">
          {isRunning ? (
            <button
              className="stop-button"
              disabled={isInterrupting}
              onClick={() => void interruptTurn()}
              type="button"
            >
              <Square size={13} />
              {isInterrupting ? "Stopping" : "Stop"}
            </button>
          ) : null}
          <button
            disabled={isSending || input.trim().length === 0}
            onClick={() => void sendMessage()}
            type="button"
          >
            <Send size={15} />
            {isSending ? "Sending" : isRunning ? "Steer" : "Send"}
          </button>
        </div>
      </footer>
      {error ? <p className="inline-error">{error}</p> : null}
    </div>
  )
}

function ReviewTab(context: TabRenderContext): React.JSX.Element {
  const [review, setReview] = useState<ReviewResult | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadReview = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    setError(null)

    try {
      setReview(await context.api.review.get({ workspaceDirectory: context.workspace.directory }))
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Review failed.")
    } finally {
      setIsLoading(false)
    }
  }, [context.api.review, context.workspace.directory])

  useEffect(() => {
    void loadReview()
  }, [loadReview])

  return (
    <div className="tab-surface review-tab">
      <header className="tab-surface-header">
        <div>
          <span className="eyebrow">AI Agent</span>
          <h2>Review</h2>
        </div>
        <button onClick={() => void loadReview()} type="button">
          <GitCompareArrows size={15} />
          Refresh
        </button>
      </header>

      {isLoading ? <p className="muted-copy">Loading workspace changes...</p> : null}
      {error ? <p className="inline-error">{error}</p> : null}
      {review ? (
        <div className="review-layout">
          <section>
            <h3>Status</h3>
            <pre>{review.status || "Clean"}</pre>
          </section>
          <section>
            <h3>Diff Stat Against Main</h3>
            <pre>{review.diffStat || "No diff against main."}</pre>
          </section>
          <section>
            <h3>Last Agent Turn</h3>
            {review.lastAgentTurn ? (
              <div className="tool-trace embedded">
                {review.lastAgentTurn.toolCalls.map((toolCall) => (
                  <ReviewToolCall key={toolCall.id} toolCall={toolCall} />
                ))}
              </div>
            ) : (
              <p className="muted-copy">No agent turn recorded.</p>
            )}
          </section>
          <section className="diff-section">
            <h3>Diff</h3>
            <pre>{review.diff || "No tracked changes."}</pre>
          </section>
        </div>
      ) : null}
    </div>
  )
}

export const aiAgentExtension: TabExtensionDefinition = {
  id: "ai-agent",
  title: "AI Agent",
  description: "Workspace-aware agent tabs.",
  tabs: [
    {
      id: "ai-agent.chat",
      extensionId: "ai-agent",
      title: "Chat",
      description: "Endpoint-backed workspace agent with tool trace.",
      state: {
        baseUrl: DEFAULT_BASE_URL,
        apiKey: "",
        model: DEFAULT_MODEL,
        messages: [],
        toolCalls: [],
      },
      render: ChatTab,
    },
    {
      id: "ai-agent.review",
      extensionId: "ai-agent",
      title: "Review",
      description: "Review agent changes and diffs against main.",
      render: ReviewTab,
    },
  ],
}
