import { describe, expect, test } from "bun:test"
import type { AgentStreamEvent } from "../../../../shared/agentEvents"
import { reduceAgentEvent } from "./extension"

type ChatState = Parameters<typeof reduceAgentEvent>[0]

function createState(): ChatState {
  return {
    sessionId: "session-test",
    activeTurnId: undefined,
    sessionStatus: "idle",
    baseUrl: "http://127.0.0.1:10531/v1",
    apiKey: "",
    model: "gpt-5.5",
    messages: [],
    toolCalls: [],
    thread: [],
    processedEventIds: [],
  }
}

function createEvent(
  sequence: number,
  event: Record<string, unknown> & { type: AgentStreamEvent["type"] },
): AgentStreamEvent {
  return {
    ...event,
    sessionId: "session-test",
    turnId: "turn-test",
    sequence,
    createdAt: sequence,
  } as AgentStreamEvent
}

describe("AI agent chat event reducer", () => {
  test("preserves effect order while updating existing tool and assistant items in place", () => {
    const events = [
      createEvent(1, { type: "turn.started", message: "Run a command." }),
      createEvent(2, {
        type: "assistant.completed",
        messageId: "assistant-before-tool",
        content: "I will inspect that.",
      }),
      createEvent(3, {
        type: "tool.started",
        tool: {
          id: "tool-pwd",
          name: "command_execution",
          status: "running",
          input: "pwd",
        },
      }),
      createEvent(4, {
        type: "assistant.completed",
        messageId: "assistant-after-tool",
        content: "The command is running.",
      }),
      createEvent(5, {
        type: "tool.completed",
        tool: {
          id: "tool-pwd",
          name: "command_execution",
          status: "success",
          input: "pwd",
          output: "/tmp/workspace",
        },
      }),
      createEvent(6, {
        type: "turn.completed",
        assistantMessage: "I will inspect that.\n\nThe command is running.",
        toolCalls: [],
      }),
    ]

    const state = events.reduce(reduceAgentEvent, createState())

    expect(
      state.thread.map((item) =>
        item.type === "message"
          ? `${item.type}:${item.role}:${item.id}`
          : `${item.type}:${item.id}`,
      ),
    ).toEqual([
      "message:user:user-turn-test",
      "message:assistant:assistant-before-tool",
      "tool:tool-tool-pwd",
      "message:assistant:assistant-after-tool",
    ])
    expect(state.thread[2]).toMatchObject({
      type: "tool",
      toolCall: {
        id: "tool-pwd",
        status: "success",
        output: "/tmp/workspace",
      },
    })
    expect(state.messages.map((message) => message.content)).toEqual([
      "Run a command.",
      "I will inspect that.",
      "The command is running.",
    ])
  })

  test("does not let stale terminal events clear a newer running turn", () => {
    const runningNewTurn: ChatState = {
      ...createState(),
      activeTurnId: "turn-new",
      sessionStatus: "running",
    }

    const completedOldTurn = reduceAgentEvent(runningNewTurn, {
      ...createEvent(1, {
        type: "turn.completed",
        assistantMessage: "Older turn finished.",
        toolCalls: [],
      }),
      turnId: "turn-old",
    })

    expect(completedOldTurn.activeTurnId).toBe("turn-new")
    expect(completedOldTurn.sessionStatus).toBe("running")

    const erroredOldTurn = reduceAgentEvent(runningNewTurn, {
      ...createEvent(2, {
        type: "runtime.error",
        message: "Older turn failed after it was no longer active.",
      }),
      turnId: "turn-old",
    })

    expect(erroredOldTurn.activeTurnId).toBe("turn-new")
    expect(erroredOldTurn.sessionStatus).toBe("running")
  })

  test("late assistant deltas do not resurrect working state after a turn is idle", () => {
    const idleState = {
      ...createState(),
      activeTurnId: undefined,
      sessionStatus: "idle" as const,
    }

    const state = reduceAgentEvent(
      idleState,
      createEvent(1, {
        type: "assistant.delta",
        messageId: "assistant-late",
        delta: "late text",
      }),
    )

    expect(state.activeTurnId).toBeUndefined()
    expect(state.sessionStatus).toBe("idle")
    expect(state.thread).toContainEqual(
      expect.objectContaining({
        type: "message",
        id: "assistant-late",
        content: "late text",
      }),
    )
  })
})
