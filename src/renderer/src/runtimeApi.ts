const DEV_API_BASE_URL = "http://127.0.0.1:10532"
let browserFallbackApi: AppShellApi | null = null

async function getJson<TResult>(path: string): Promise<TResult> {
  const response = await fetch(`${DEV_API_BASE_URL}${path}`)

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Request failed with ${response.status}`)
  }

  return response.json() as Promise<TResult>
}

async function postJson<TResult>(path: string, body: unknown): Promise<TResult> {
  const response = await fetch(`${DEV_API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Request failed with ${response.status}`)
  }

  return response.json() as Promise<TResult>
}

export function getRuntimeApi(): AppShellApi {
  if (window.appShell) {
    return window.appShell
  }

  if (!browserFallbackApi) {
    browserFallbackApi = {
      platform: "browser",
      testWorkspaceRoot: ".superapp-test-workspace",
      ensemble: {
        getState: () => getJson("/ensemble/state"),
        dispatch: (input) => postJson("/ensemble/command", input),
        onEvent: (callback) => {
          const source = new EventSource(`${DEV_API_BASE_URL}/ensemble/events`)

          source.onmessage = (message) => {
            callback(JSON.parse(message.data) as EnsembleStateEvent | EnsembleSnapshotEvent)
          }

          return () => source.close()
        },
      },
      chat: {
        complete: (input) => postJson("/chat/complete", input),
      },
      agent: {
        send: (input) => postJson("/agent/send", input),
        startTurn: (input) => postJson("/agent/turn/start", input),
        interrupt: (input) => postJson("/agent/turn/interrupt", input),
        respondApproval: (input) => postJson("/agent/approval/respond", input),
        respondUserInput: (input) => postJson("/agent/user-input/respond", input),
        onEvent: (sessionId, callback) => {
          const source = new EventSource(
            `${DEV_API_BASE_URL}/agent/events?sessionId=${encodeURIComponent(sessionId)}`,
          )

          source.onmessage = (message) => {
            callback(JSON.parse(message.data) as AgentStreamEvent)
          }

          return () => source.close()
        },
      },
      files: {
        tree: (input) => postJson("/files/tree", input),
        list: (input) => postJson("/files/list", input),
        read: (input) => postJson("/files/read", input),
        write: (input) => postJson("/files/write", input),
      },
      terminal: {
        run: (input) => postJson("/terminal/run", input),
        create: (input) => postJson("/terminal/session/create", input),
        input: (input) => {
          void postJson("/terminal/session/input", input)
        },
        resize: (input) => {
          void postJson("/terminal/session/resize", input)
        },
        close: (input) => {
          void postJson("/terminal/session/close", input)
        },
        onEvent: (sessionId, callback) => {
          const source = new EventSource(
            `${DEV_API_BASE_URL}/terminal/session/events?sessionId=${encodeURIComponent(sessionId)}`,
          )

          source.onmessage = (message) => {
            callback(JSON.parse(message.data) as TerminalSessionEvent)
          }

          return () => source.close()
        },
      },
      review: {
        get: (input) => postJson("/review/get", input),
      },
    }
  }

  return browserFallbackApi
}
