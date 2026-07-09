/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import {
  collectPanes,
  getActiveView,
  getActiveWorkspace,
  getWorkspaceViewState,
  initialShellState,
  type ShellCommand,
  type ShellState,
  shellReducer,
} from "./shellModel"

type ShellCommandWithoutContext = ShellCommand extends infer Command
  ? Command extends ShellCommand
    ? Omit<Command, "actorId" | "viewId">
    : never
  : never

function dispatch(state: ShellState, command: ShellCommandWithoutContext): ShellState {
  const view = getActiveView(state)

  return shellReducer(state, {
    ...command,
    actorId: view.actorId,
    viewId: view.id,
  } as ShellCommand)
}

function createFiveLeftOneRight(): ShellState {
  let state = initialShellState
  const workspace = getActiveWorkspace(state, getActiveView(state))
  const leftPane = collectPanes(workspace.root)[0]

  for (let index = 0; index < 4; index += 1) {
    state = dispatch(state, { type: "tab.create", paneId: leftPane.id })
  }

  state = dispatch(state, { type: "pane.split", paneId: leftPane.id, direction: "horizontal" })

  return state
}

function createSinglePaneTabs(count: number): ShellState {
  let state = initialShellState
  const workspace = getActiveWorkspace(state, getActiveView(state))
  const pane = collectPanes(workspace.root)[0]

  for (let index = 1; index < count; index += 1) {
    state = dispatch(state, { type: "tab.create", paneId: pane.id })
  }

  return state
}

describe("shell layout model", () => {
  test("creates a workspace with a chosen directory", () => {
    const nextState = dispatch(initialShellState, {
      type: "workspace.create",
      name: "Project Repo",
      directory: "/tmp/project-repo",
    })
    const workspace = getActiveWorkspace(nextState, getActiveView(nextState))

    expect(workspace.name).toBe("Project Repo")
    expect(workspace.directory).toBe("/tmp/project-repo")
  })

  test("renames a workspace", () => {
    const workspace = getActiveWorkspace(initialShellState, getActiveView(initialShellState))

    const nextState = dispatch(initialShellState, {
      type: "workspace.rename",
      workspaceId: workspace.id,
      name: "Renamed Workspace",
    })

    expect(getActiveWorkspace(nextState, getActiveView(nextState)).name).toBe("Renamed Workspace")
  })

  test("deletes the active workspace and selects the nearest remaining workspace", () => {
    let state = dispatch(initialShellState, {
      type: "workspace.create",
      name: "Second",
      directory: "workspace-2",
    })
    state = dispatch(state, {
      type: "workspace.create",
      name: "Third",
      directory: "workspace-3",
    })

    const activeWorkspace = getActiveWorkspace(state, getActiveView(state))
    const expectedFallback = state.workspaces[1]

    const nextState = dispatch(state, {
      type: "workspace.delete",
      workspaceId: activeWorkspace.id,
    })

    expect(nextState.workspaces.map((workspace) => workspace.name)).toEqual([
      "Workspace 1",
      "Second",
    ])
    expect(getActiveWorkspace(nextState, getActiveView(nextState)).id).toBe(expectedFallback.id)
  })

  test("does not delete the final workspace", () => {
    const workspace = getActiveWorkspace(initialShellState, getActiveView(initialShellState))

    const nextState = dispatch(initialShellState, {
      type: "workspace.delete",
      workspaceId: workspace.id,
    })

    expect(nextState.workspaces).toHaveLength(1)
    expect(getActiveWorkspace(nextState, getActiveView(nextState)).id).toBe(workspace.id)
  })

  test("creates an actor without stealing the active view", () => {
    const activeActorId = initialShellState.activeActorId
    const activeViewId = initialShellState.activeViewId
    const nextState = dispatch(initialShellState, {
      type: "actor.create",
      name: "CLI Actor",
    })
    const actor = nextState.actors.find((item) => item.name === "CLI Actor")

    expect(actor).toBeDefined()
    expect(nextState.views.some((view) => view.actorId === actor?.id)).toBe(true)
    expect(nextState.activeActorId).toBe(activeActorId)
    expect(nextState.activeViewId).toBe(activeViewId)
  })

  test("ensures an actor view on a tab without stealing the active view", () => {
    const workspace = getActiveWorkspace(initialShellState, getActiveView(initialShellState))
    const pane = collectPanes(workspace.root)[0]
    const tab = pane.tabs[0]
    const nextState = dispatch(initialShellState, {
      type: "actor.ensure",
      targetActorId: "agent-actor-test",
      targetViewId: "agent-view-test",
      name: "Test Agent",
      workspaceId: workspace.id,
      focusedPaneId: pane.id,
      activeTabId: tab.id,
    })
    const actor = nextState.actors.find((item) => item.id === "agent-actor-test")
    const view = nextState.views.find((item) => item.id === "agent-view-test")

    expect(actor?.name).toBe("Test Agent")
    expect(view?.actorId).toBe(actor?.id)
    expect(nextState.activeActorId).toBe(initialShellState.activeActorId)
    expect(nextState.activeViewId).toBe(initialShellState.activeViewId)

    const viewState = view ? getWorkspaceViewState(view, workspace) : null

    expect(viewState?.focusedPaneId).toBe(pane.id)
    expect(viewState?.activeTabByPaneId[pane.id]).toBe(tab.id)
  })

  test("closing an agent chat removes its actor and clears controlled tab ownership", () => {
    let state = initialShellState
    let workspace = getActiveWorkspace(state, getActiveView(state))
    let pane = collectPanes(workspace.root)[0]
    const chatTab = pane.tabs[0]
    const agentActorId = `agent-actor-${chatTab.id}`
    const agentViewId = `agent-view-${chatTab.id}`

    state = dispatch(state, {
      type: "tab.setType",
      paneId: pane.id,
      tabId: chatTab.id,
      tabTypeId: "ai-agent.chat",
      title: "Chat",
      state: {
        agentActorId,
        agentViewId,
      },
    })
    state = dispatch(state, {
      type: "actor.ensure",
      targetActorId: agentActorId,
      targetViewId: agentViewId,
      name: "Chat Agent",
      workspaceId: workspace.id,
      focusedPaneId: pane.id,
      activeTabId: chatTab.id,
    })
    state = dispatch(state, {
      type: "tab.open",
      paneId: pane.id,
      tabTypeId: "core.browser",
      title: "Browser",
      state: {
        agentActorId,
        agentViewId,
        url: "https://example.com",
      },
    })

    workspace = getActiveWorkspace(state, getActiveView(state))
    pane = collectPanes(workspace.root)[0]
    state = dispatch(state, {
      type: "tab.close",
      paneId: pane.id,
      tabId: chatTab.id,
    })

    workspace = getActiveWorkspace(state, getActiveView(state))
    const remainingTabs = collectPanes(workspace.root).flatMap((currentPane) => currentPane.tabs)
    const browserTab = remainingTabs.find((tab) => tab.title === "Browser")

    expect(state.actors.some((actor) => actor.id === agentActorId)).toBe(false)
    expect(
      state.views.some((view) => view.id === agentViewId || view.actorId === agentActorId),
    ).toBe(false)
    expect(remainingTabs.some((tab) => tab.id === chatTab.id)).toBe(false)
    expect(browserTab?.state.agentActorId).toBeUndefined()
    expect(browserTab?.state.agentViewId).toBeUndefined()
  })

  test("actor-scoped workspace commands do not steal the active view", () => {
    const activeActorId = initialShellState.activeActorId
    const activeViewId = initialShellState.activeViewId
    const withActor = dispatch(initialShellState, {
      type: "actor.create",
      name: "CLI Actor",
    })
    const actor = withActor.actors.find((item) => item.name === "CLI Actor")
    const actorView = withActor.views.find((view) => view.actorId === actor?.id)

    expect(actor).toBeDefined()
    expect(actorView).toBeDefined()

    const nextState = shellReducer(withActor, {
      actorId: actor?.id ?? "",
      viewId: actorView?.id ?? "",
      type: "workspace.create",
      name: "CLI Workspace",
      directory: "cli-workspace",
    })
    const nextActorView = nextState.views.find((view) => view.id === actorView?.id)
    const cliWorkspace = nextState.workspaces.find(
      (workspace) => workspace.name === "CLI Workspace",
    )

    expect(cliWorkspace).toBeDefined()
    expect(nextActorView?.activeWorkspaceId).toBe(cliWorkspace?.id)
    expect(nextState.activeActorId).toBe(activeActorId)
    expect(nextState.activeViewId).toBe(activeViewId)
  })

  test("activates a view explicitly", () => {
    const withActor = dispatch(initialShellState, {
      type: "actor.create",
      name: "CLI Actor",
    })
    const actor = withActor.actors.find((item) => item.name === "CLI Actor")
    const actorView = withActor.views.find((view) => view.actorId === actor?.id)
    const actorId = actor?.id ?? ""
    const viewId = actorView?.id ?? ""

    const nextState = shellReducer(withActor, {
      actorId,
      viewId,
      type: "view.activate",
    })

    expect(nextState.activeActorId).toBe(actorId)
    expect(nextState.activeViewId).toBe(viewId)
  })

  test("reorders workspaces without changing the active workspace", () => {
    let state = dispatch(initialShellState, {
      type: "workspace.create",
      name: "Second",
      directory: "workspace-2",
    })
    state = dispatch(state, {
      type: "workspace.create",
      name: "Third",
      directory: "workspace-3",
    })

    const activeWorkspaceBefore = getActiveWorkspace(state, getActiveView(state))
    const [firstWorkspace, secondWorkspace, thirdWorkspace] = state.workspaces

    const nextState = dispatch(state, {
      type: "workspace.reorder",
      workspaceId: thirdWorkspace.id,
      targetWorkspaceId: firstWorkspace.id,
    })

    expect(nextState.workspaces.map((workspace) => workspace.id)).toEqual([
      thirdWorkspace.id,
      firstWorkspace.id,
      secondWorkspace.id,
    ])
    expect(getActiveWorkspace(nextState, getActiveView(nextState)).id).toBe(
      activeWorkspaceBefore.id,
    )
  })

  test("assigns an extension tab type to an empty tab", () => {
    const workspace = getActiveWorkspace(initialShellState, getActiveView(initialShellState))
    const pane = collectPanes(workspace.root)[0]
    const tab = pane.tabs[0]

    const nextState = dispatch(initialShellState, {
      type: "tab.setType",
      paneId: pane.id,
      tabId: tab.id,
      tabTypeId: "core.terminal",
      title: "Terminal",
      state: { shell: "zsh" },
    })
    const nextWorkspace = getActiveWorkspace(nextState, getActiveView(nextState))
    const nextTab = collectPanes(nextWorkspace.root)[0].tabs[0]

    expect(nextTab.title).toBe("Terminal")
    expect(nextTab.typeId).toBe("core.terminal")
    expect(nextTab.state).toEqual({ shell: "zsh" })
  })

  test("opens a typed tab with state in the target pane", () => {
    const workspace = getActiveWorkspace(initialShellState, getActiveView(initialShellState))
    const pane = collectPanes(workspace.root)[0]

    const nextState = dispatch(initialShellState, {
      type: "tab.open",
      paneId: pane.id,
      tabTypeId: "core.filePreview",
      title: "README.md",
      state: { path: "README.md" },
    })
    const nextWorkspace = getActiveWorkspace(nextState, getActiveView(nextState))
    const nextPane = collectPanes(nextWorkspace.root)[0]
    const openedTab = nextPane.tabs[1]
    const viewState = getActiveView(nextState).workspaceState[nextWorkspace.id]

    expect(nextPane.tabs).toHaveLength(2)
    expect(openedTab.title).toBe("README.md")
    expect(openedTab.typeId).toBe("core.filePreview")
    expect(openedTab.state).toEqual({ path: "README.md" })
    expect(viewState.focusedPaneId).toBe(pane.id)
    expect(viewState.activeTabByPaneId[pane.id]).toBe(openedTab.id)
  })

  test("splits a one-tab source pane relative to a different target pane", () => {
    const state = createFiveLeftOneRight()
    const workspace = getActiveWorkspace(state, getActiveView(state))
    const [leftPane, rightPane] = collectPanes(workspace.root)
    const movingTab = rightPane.tabs[0]

    const nextState = dispatch(state, {
      type: "tab.split",
      tabId: movingTab.id,
      sourcePaneId: rightPane.id,
      targetPaneId: leftPane.id,
      direction: "horizontal",
      placement: "before",
    })
    const nextWorkspace = getActiveWorkspace(nextState, getActiveView(nextState))
    const panes = collectPanes(nextWorkspace.root)

    expect(panes).toHaveLength(2)
    expect(panes.map((pane) => pane.tabs.length)).toEqual([1, 5])
    expect(panes[0].tabs[0].id).toBe(movingTab.id)
  })

  test("moves a one-tab source pane into another tab strip and collapses the source pane", () => {
    const state = createFiveLeftOneRight()
    const workspace = getActiveWorkspace(state, getActiveView(state))
    const [leftPane, rightPane] = collectPanes(workspace.root)
    const movingTab = rightPane.tabs[0]

    const nextState = dispatch(state, {
      type: "tab.move",
      tabId: movingTab.id,
      sourcePaneId: rightPane.id,
      targetPaneId: leftPane.id,
      targetIndex: 2,
    })
    const nextWorkspace = getActiveWorkspace(nextState, getActiveView(nextState))
    const panes = collectPanes(nextWorkspace.root)

    expect(panes).toHaveLength(1)
    expect(panes[0].tabs).toHaveLength(6)
    expect(panes[0].tabs[2].id).toBe(movingTab.id)
  })

  test("reorders a tab inside its own pane without duplicating it", () => {
    const state = createSinglePaneTabs(3)
    const workspace = getActiveWorkspace(state, getActiveView(state))
    const pane = collectPanes(workspace.root)[0]
    const [firstTab, secondTab, thirdTab] = pane.tabs

    const nextState = dispatch(state, {
      type: "tab.move",
      tabId: firstTab.id,
      sourcePaneId: pane.id,
      targetPaneId: pane.id,
      targetIndex: 2,
    })
    const nextWorkspace = getActiveWorkspace(nextState, getActiveView(nextState))
    const tabs = collectPanes(nextWorkspace.root)[0].tabs

    expect(tabs.map((tab) => tab.id)).toEqual([secondTab.id, thirdTab.id, firstTab.id])
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(3)
  })

  test("keeps same-pane no-op moves stable", () => {
    const state = createSinglePaneTabs(3)
    const workspace = getActiveWorkspace(state, getActiveView(state))
    const pane = collectPanes(workspace.root)[0]
    const originalTabIds = pane.tabs.map((tab) => tab.id)
    const middleTab = pane.tabs[1]

    const nextState = dispatch(state, {
      type: "tab.move",
      tabId: middleTab.id,
      sourcePaneId: pane.id,
      targetPaneId: pane.id,
      targetIndex: 1,
    })
    const nextWorkspace = getActiveWorkspace(nextState, getActiveView(nextState))
    const tabs = collectPanes(nextWorkspace.root)[0].tabs

    expect(tabs.map((tab) => tab.id)).toEqual(originalTabIds)
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(originalTabIds.length)
  })

  test("keeps single-tab same-pane content drops stable", () => {
    const workspace = getActiveWorkspace(initialShellState, getActiveView(initialShellState))
    const pane = collectPanes(workspace.root)[0]
    const tab = pane.tabs[0]

    const nextState = dispatch(initialShellState, {
      type: "tab.move",
      tabId: tab.id,
      sourcePaneId: pane.id,
      targetPaneId: pane.id,
      targetIndex: pane.tabs.length,
    })
    const nextWorkspace = getActiveWorkspace(nextState, getActiveView(nextState))
    const panes = collectPanes(nextWorkspace.root)

    expect(panes).toHaveLength(1)
    expect(panes[0].tabs).toHaveLength(1)
    expect(panes[0].tabs[0].id).toBe(tab.id)
  })

  test("does not split the only tab in a pane against itself", () => {
    const workspace = getActiveWorkspace(initialShellState, getActiveView(initialShellState))
    const pane = collectPanes(workspace.root)[0]
    const tab = pane.tabs[0]

    const nextState = dispatch(initialShellState, {
      type: "tab.split",
      tabId: tab.id,
      sourcePaneId: pane.id,
      targetPaneId: pane.id,
      direction: "horizontal",
      placement: "after",
    })
    const nextWorkspace = getActiveWorkspace(nextState, getActiveView(nextState))
    const panes = collectPanes(nextWorkspace.root)

    expect(panes).toHaveLength(1)
    expect(panes[0].tabs).toHaveLength(1)
    expect(panes[0].tabs[0].id).toBe(tab.id)
  })
})
