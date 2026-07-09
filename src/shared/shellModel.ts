export type SplitDirection = "horizontal" | "vertical"
export type SplitPlacement = "before" | "after"

export type Actor = {
  id: string
  name: string
}

export type WorkspaceTab = {
  id: string
  title: string
  typeId: string
  state: Record<string, unknown>
  createdAt: number
}

export type PaneNode = {
  kind: "pane"
  id: string
  tabs: WorkspaceTab[]
}

export type SplitNode = {
  kind: "split"
  id: string
  direction: SplitDirection
  children: LayoutNode[]
}

export type LayoutNode = PaneNode | SplitNode

export type Workspace = {
  id: string
  name: string
  directory: string
  root: LayoutNode
}

export type WorkspaceViewState = {
  focusedPaneId: string | null
  activeTabByPaneId: Record<string, string | null>
}

export type ShellView = {
  id: string
  actorId: string
  activeWorkspaceId: string
  workspaceState: Record<string, WorkspaceViewState>
}

export type ShellState = {
  actors: Actor[]
  views: ShellView[]
  activeActorId: string
  activeViewId: string
  workspaces: Workspace[]
}

type ShellCommandBase = {
  actorId: string
  viewId: string
}

export type ShellCommand =
  | (ShellCommandBase & { type: "actor.create"; name?: string; workspaceId?: string })
  | (ShellCommandBase & {
      type: "actor.ensure"
      targetActorId: string
      targetViewId: string
      name?: string
      workspaceId?: string
      focusedPaneId?: string
      activeTabId?: string
    })
  | (ShellCommandBase & { type: "view.activate" })
  | (ShellCommandBase & { type: "workspace.create"; name?: string; directory?: string })
  | (ShellCommandBase & { type: "workspace.select"; workspaceId: string })
  | (ShellCommandBase & { type: "workspace.rename"; workspaceId: string; name: string })
  | (ShellCommandBase & { type: "workspace.delete"; workspaceId: string })
  | (ShellCommandBase & {
      type: "workspace.reorder"
      workspaceId: string
      targetWorkspaceId: string
    })
  | (ShellCommandBase & { type: "view.focusPane"; paneId: string })
  | (ShellCommandBase & { type: "tab.create"; paneId: string })
  | (ShellCommandBase & {
      type: "tab.open"
      paneId: string
      tabTypeId: string
      title: string
      state?: Record<string, unknown>
    })
  | (ShellCommandBase & { type: "tab.activate"; paneId: string; tabId: string })
  | (ShellCommandBase & { type: "tab.close"; paneId: string; tabId: string })
  | (ShellCommandBase & {
      type: "tab.setType"
      paneId: string
      tabId: string
      tabTypeId: string
      title: string
      state?: Record<string, unknown>
    })
  | (ShellCommandBase & {
      type: "tab.updateState"
      paneId: string
      tabId: string
      state: Record<string, unknown>
    })
  | (ShellCommandBase & { type: "pane.split"; paneId: string; direction: SplitDirection })
  | (ShellCommandBase & {
      type: "tab.split"
      tabId: string
      sourcePaneId: string
      targetPaneId: string
      direction: SplitDirection
      placement: SplitPlacement
    })
  | (ShellCommandBase & {
      type: "tab.move"
      tabId: string
      sourcePaneId: string
      targetPaneId: string
      targetIndex: number
    })

export type ShellCommandContext = {
  actorId: string
  viewId: string
}

export const EMPTY_TAB_TYPE_ID = "shell.empty"
const AI_AGENT_CHAT_TYPE_ID = "ai-agent.chat"
const AI_AGENT_ACTOR_ID_PREFIX = "agent-actor-"
const AI_AGENT_VIEW_ID_PREFIX = "agent-view-"

let idCounter = 0

function createId(prefix: string): string {
  idCounter += 1
  const randomSuffix =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10)
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${randomSuffix}`
}

function createEmptyTab(title: string): WorkspaceTab {
  return {
    id: createId("tab"),
    title,
    typeId: EMPTY_TAB_TYPE_ID,
    state: {},
    createdAt: Date.now(),
  }
}

function createTypedTab(
  title: string,
  typeId: string,
  state: Record<string, unknown> = {},
): WorkspaceTab {
  return {
    id: createId("tab"),
    title,
    typeId,
    state,
    createdAt: Date.now(),
  }
}

function getOptionalStringState(tab: WorkspaceTab, key: string): string | null {
  const value = tab.state[key]

  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function getChatOwnedActorIds(tab: WorkspaceTab): string[] {
  if (tab.typeId !== AI_AGENT_CHAT_TYPE_ID) {
    return []
  }

  const actorIds = new Set<string>()
  const explicitActorId = getOptionalStringState(tab, "agentActorId")

  if (explicitActorId) {
    actorIds.add(explicitActorId)
  }

  actorIds.add(`${AI_AGENT_ACTOR_ID_PREFIX}${tab.id}`)

  return [...actorIds]
}

function getChatOwnedViewIds(tab: WorkspaceTab): string[] {
  if (tab.typeId !== AI_AGENT_CHAT_TYPE_ID) {
    return []
  }

  const viewIds = new Set<string>()
  const explicitViewId = getOptionalStringState(tab, "agentViewId")

  if (explicitViewId) {
    viewIds.add(explicitViewId)
  }

  viewIds.add(`${AI_AGENT_VIEW_ID_PREFIX}${tab.id}`)

  return [...viewIds]
}

function createPane(tab: WorkspaceTab): PaneNode {
  return createPaneWithTabs([tab])
}

function createPaneWithTabs(tabs: WorkspaceTab[]): PaneNode {
  return {
    kind: "pane",
    id: createId("pane"),
    tabs,
  }
}

function createWorkspace(
  index: number,
  input: { name?: string; directory?: string } = {},
): Workspace {
  return {
    id: createId("workspace"),
    name: input.name?.trim() || `Workspace ${index}`,
    directory: input.directory?.trim() || `workspace-${index}`,
    root: createPane(createEmptyTab("New Tab 1")),
  }
}

function createWorkspaceViewState(workspace: Workspace): WorkspaceViewState {
  const panes = collectPanes(workspace.root)

  return {
    focusedPaneId: panes[0]?.id ?? null,
    activeTabByPaneId: Object.fromEntries(panes.map((pane) => [pane.id, pane.tabs[0]?.id ?? null])),
  }
}

function createView(actorId: string, workspace: Workspace): ShellView {
  return createViewWithId(actorId, workspace, createId("view"))
}

function createViewWithId(actorId: string, workspace: Workspace, viewId: string): ShellView {
  return {
    id: viewId,
    actorId,
    activeWorkspaceId: workspace.id,
    workspaceState: {
      [workspace.id]: createWorkspaceViewState(workspace),
    },
  }
}

export function collectPanes(node: LayoutNode): PaneNode[] {
  if (node.kind === "pane") {
    return [node]
  }

  return node.children.flatMap((child) => collectPanes(child))
}

export function findFirstPane(node: LayoutNode): PaneNode | null {
  return collectPanes(node)[0] ?? null
}

export function findPane(node: LayoutNode, paneId: string): PaneNode | null {
  if (node.kind === "pane") {
    return node.id === paneId ? node : null
  }

  for (const child of node.children) {
    const pane = findPane(child, paneId)
    if (pane) {
      return pane
    }
  }

  return null
}

export function countTabs(node: LayoutNode): number {
  if (node.kind === "pane") {
    return node.tabs.length
  }

  return node.children.reduce((total, child) => total + countTabs(child), 0)
}

export function getActiveView(state: ShellState): ShellView {
  return state.views.find((view) => view.id === state.activeViewId) ?? state.views[0]
}

export function getActor(state: ShellState, actorId: string): Actor {
  return state.actors.find((actor) => actor.id === actorId) ?? state.actors[0]
}

export function getWorkspace(state: ShellState, workspaceId: string): Workspace {
  return state.workspaces.find((workspace) => workspace.id === workspaceId) ?? state.workspaces[0]
}

export function getActiveWorkspace(state: ShellState, view: ShellView): Workspace {
  return getWorkspace(state, view.activeWorkspaceId)
}

export function getWorkspaceViewState(view: ShellView, workspace: Workspace): WorkspaceViewState {
  return view.workspaceState[workspace.id] ?? createWorkspaceViewState(workspace)
}

export function getActiveTabId(pane: PaneNode, viewState: WorkspaceViewState): string | null {
  const activeTabId = viewState.activeTabByPaneId[pane.id]

  if (activeTabId && pane.tabs.some((tab) => tab.id === activeTabId)) {
    return activeTabId
  }

  return pane.tabs[0]?.id ?? null
}

function paneHasTab(root: LayoutNode, paneId: string, tabId: string): boolean {
  return findPane(root, paneId)?.tabs.some((tab) => tab.id === tabId) ?? false
}

function findTab(root: LayoutNode, paneId: string, tabId: string): WorkspaceTab | null {
  return findPane(root, paneId)?.tabs.find((tab) => tab.id === tabId) ?? null
}

function commandMatchesView(state: ShellState, command: ShellCommandBase): boolean {
  return state.views.some((view) => view.id === command.viewId && view.actorId === command.actorId)
}

function updatePane(
  node: LayoutNode,
  paneId: string,
  updater: (pane: PaneNode) => PaneNode,
): LayoutNode {
  if (node.kind === "pane") {
    return node.id === paneId ? updater(node) : node
  }

  return {
    ...node,
    children: node.children.map((child) => updatePane(child, paneId, updater)),
  }
}

function splitPane(
  node: LayoutNode,
  paneId: string,
  direction: SplitDirection,
  newPane: PaneNode,
  placement: SplitPlacement,
): LayoutNode {
  if (node.kind === "pane") {
    if (node.id !== paneId) {
      return node
    }

    return {
      kind: "split",
      id: createId("split"),
      direction,
      children: placement === "before" ? [newPane, node] : [node, newPane],
    }
  }

  return {
    ...node,
    children: node.children.map((child) => splitPane(child, paneId, direction, newPane, placement)),
  }
}

function addTabToPane(root: LayoutNode, paneId: string, tab: WorkspaceTab): LayoutNode {
  return updatePane(root, paneId, (pane) => ({
    ...pane,
    tabs: [...pane.tabs, tab],
  }))
}

function updateTab(
  root: LayoutNode,
  paneId: string,
  tabId: string,
  updater: (tab: WorkspaceTab) => WorkspaceTab,
): LayoutNode {
  return updatePane(root, paneId, (pane) => ({
    ...pane,
    tabs: pane.tabs.map((tab) => (tab.id === tabId ? updater(tab) : tab)),
  }))
}

function clearAgentOwnershipFromTabs(
  node: LayoutNode,
  actorIds: Set<string>,
  viewIds: Set<string>,
): LayoutNode {
  if (node.kind === "pane") {
    return {
      ...node,
      tabs: node.tabs.map((tab) => {
        const tabAgentActorId = getOptionalStringState(tab, "agentActorId")
        const tabAgentViewId = getOptionalStringState(tab, "agentViewId")
        const shouldClearOwnership =
          (tabAgentActorId !== null && actorIds.has(tabAgentActorId)) ||
          (tabAgentViewId !== null && viewIds.has(tabAgentViewId))

        if (!shouldClearOwnership) {
          return tab
        }

        const { agentActorId: _agentActorId, agentViewId: _agentViewId, ...state } = tab.state

        return {
          ...tab,
          state,
        }
      }),
    }
  }

  return {
    ...node,
    children: node.children.map((child) => clearAgentOwnershipFromTabs(child, actorIds, viewIds)),
  }
}

function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.kind === "pane") {
    return node.id === paneId ? null : node
  }

  const children = node.children.flatMap((child) => {
    const nextChild = removePane(child, paneId)
    return nextChild ? [nextChild] : []
  })

  if (children.length === 0) {
    return null
  }

  if (children.length === 1) {
    return children[0]
  }

  return {
    ...node,
    children,
  }
}

function removeClosedChatAgent(state: ShellState, tab: WorkspaceTab | null): ShellState {
  if (!tab || tab.typeId !== AI_AGENT_CHAT_TYPE_ID) {
    return state
  }

  const localActorId = state.actors[0]?.id
  const actorIds = new Set(getChatOwnedActorIds(tab).filter((actorId) => actorId !== localActorId))

  if (actorIds.size === 0) {
    return state
  }

  const viewIds = new Set(getChatOwnedViewIds(tab))

  for (const view of state.views) {
    if (actorIds.has(view.actorId)) {
      viewIds.add(view.id)
    }
  }

  const actors = state.actors.filter((actor) => !actorIds.has(actor.id))
  const views = state.views.filter((view) => !actorIds.has(view.actorId) && !viewIds.has(view.id))
  const fallbackView = views[0]

  return {
    ...state,
    actors: actors.length > 0 ? actors : state.actors,
    views: views.length > 0 ? views : state.views,
    activeActorId:
      actorIds.has(state.activeActorId) && fallbackView
        ? fallbackView.actorId
        : state.activeActorId,
    activeViewId:
      viewIds.has(state.activeViewId) && fallbackView ? fallbackView.id : state.activeViewId,
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      root: clearAgentOwnershipFromTabs(workspace.root, actorIds, viewIds),
    })),
  }
}

function closeTab(root: LayoutNode, paneId: string, tabId: string): LayoutNode {
  const pane = findPane(root, paneId)

  if (!pane?.tabs.some((tab) => tab.id === tabId)) {
    return root
  }

  if (pane.tabs.length > 1) {
    return updatePane(root, paneId, (currentPane) => ({
      ...currentPane,
      tabs: currentPane.tabs.filter((tab) => tab.id !== tabId),
    }))
  }

  if (collectPanes(root).length <= 1) {
    return root
  }

  return removePane(root, paneId) ?? root
}

function moveTab(
  root: LayoutNode,
  tabId: string,
  sourcePaneId: string,
  targetPaneId: string,
  targetIndex: number,
): LayoutNode {
  const sourcePane = findPane(root, sourcePaneId)
  const movingTab = sourcePane?.tabs.find((tab) => tab.id === tabId)

  if (!sourcePane || !movingTab) {
    return root
  }

  if (sourcePaneId === targetPaneId && sourcePane.tabs.length <= 1) {
    return root
  }

  const withoutTab =
    sourcePane.tabs.length > 1
      ? updatePane(root, sourcePaneId, (pane) => ({
          ...pane,
          tabs: pane.tabs.filter((tab) => tab.id !== tabId),
        }))
      : (removePane(root, sourcePaneId) ?? root)
  const targetPane = findPane(withoutTab, targetPaneId)

  if (!targetPane) {
    return root
  }

  const boundedIndex = Math.max(0, Math.min(targetIndex, targetPane.tabs.length))

  return updatePane(withoutTab, targetPaneId, (pane) => {
    const nextTabs = [...pane.tabs]
    nextTabs.splice(boundedIndex, 0, movingTab)

    return {
      ...pane,
      tabs: nextTabs,
    }
  })
}

function splitTab(
  root: LayoutNode,
  tabId: string,
  sourcePaneId: string,
  targetPaneId: string,
  direction: SplitDirection,
  placement: SplitPlacement,
): { root: LayoutNode; paneId: string | null } {
  const sourcePane = findPane(root, sourcePaneId)
  const movingTab = sourcePane?.tabs.find((tab) => tab.id === tabId)

  if (!sourcePane || !movingTab) {
    return { root, paneId: null }
  }

  if (sourcePaneId === targetPaneId && sourcePane.tabs.length <= 1) {
    return { root, paneId: null }
  }

  const withoutTab =
    sourcePane.tabs.length > 1
      ? updatePane(root, sourcePaneId, (pane) => ({
          ...pane,
          tabs: pane.tabs.filter((tab) => tab.id !== tabId),
        }))
      : (removePane(root, sourcePaneId) ?? root)
  const targetPane = findPane(withoutTab, targetPaneId)

  if (!targetPane) {
    return { root, paneId: null }
  }

  const newPane = createPaneWithTabs([movingTab])

  return {
    root: splitPane(withoutTab, targetPaneId, direction, newPane, placement),
    paneId: newPane.id,
  }
}

function updateWorkspace(
  state: ShellState,
  workspaceId: string,
  updater: (workspace: Workspace) => Workspace,
): ShellState {
  return {
    ...state,
    workspaces: state.workspaces.map((workspace) =>
      workspace.id === workspaceId ? updater(workspace) : workspace,
    ),
  }
}

function updateView(
  state: ShellState,
  viewId: string,
  updater: (view: ShellView) => ShellView,
): ShellState {
  return {
    ...state,
    views: state.views.map((view) => (view.id === viewId ? updater(view) : view)),
  }
}

function updateWorkspaceViewState(
  state: ShellState,
  viewId: string,
  workspace: Workspace,
  updater: (viewState: WorkspaceViewState) => WorkspaceViewState,
): ShellState {
  return updateView(state, viewId, (view) => {
    const current = getWorkspaceViewState(view, workspace)

    return {
      ...view,
      workspaceState: {
        ...view.workspaceState,
        [workspace.id]: updater(current),
      },
    }
  })
}

function normalizeWorkspaceViewState(
  workspace: Workspace,
  viewState: WorkspaceViewState,
): WorkspaceViewState {
  const panes = collectPanes(workspace.root)
  const paneIds = new Set(panes.map((pane) => pane.id))
  const focusedPaneId =
    viewState.focusedPaneId && paneIds.has(viewState.focusedPaneId)
      ? viewState.focusedPaneId
      : (panes[0]?.id ?? null)
  const activeTabByPaneId = Object.fromEntries(
    panes.map((pane) => {
      const activeTabId = viewState.activeTabByPaneId[pane.id]
      const nextActiveTabId =
        activeTabId && pane.tabs.some((tab) => tab.id === activeTabId)
          ? activeTabId
          : (pane.tabs[0]?.id ?? null)

      return [pane.id, nextActiveTabId]
    }),
  )

  return {
    focusedPaneId,
    activeTabByPaneId,
  }
}

function normalizeViewsForWorkspace(state: ShellState, workspace: Workspace): ShellState {
  return {
    ...state,
    views: state.views.map((view) => {
      const currentViewState = view.workspaceState[workspace.id]

      if (!currentViewState) {
        return view
      }

      return {
        ...view,
        workspaceState: {
          ...view.workspaceState,
          [workspace.id]: normalizeWorkspaceViewState(workspace, currentViewState),
        },
      }
    }),
  }
}

function reorderWorkspaces(
  workspaces: Workspace[],
  workspaceId: string,
  targetWorkspaceId: string,
): Workspace[] {
  const sourceIndex = workspaces.findIndex((workspace) => workspace.id === workspaceId)
  const targetIndex = workspaces.findIndex((workspace) => workspace.id === targetWorkspaceId)

  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
    return workspaces
  }

  const nextWorkspaces = [...workspaces]
  const [workspace] = nextWorkspaces.splice(sourceIndex, 1)
  nextWorkspaces.splice(targetIndex, 0, workspace)

  return nextWorkspaces
}

function deleteWorkspace(state: ShellState, workspaceId: string): ShellState {
  if (state.workspaces.length <= 1) {
    return state
  }

  const deletedIndex = state.workspaces.findIndex((workspace) => workspace.id === workspaceId)

  if (deletedIndex === -1) {
    return state
  }

  const workspaces = state.workspaces.filter((workspace) => workspace.id !== workspaceId)
  const fallbackWorkspace = workspaces[Math.min(deletedIndex, workspaces.length - 1)]

  return {
    ...state,
    workspaces,
    views: state.views.map((view) => {
      const workspaceState = Object.fromEntries(
        Object.entries(view.workspaceState).filter(([currentWorkspaceId]) => {
          return currentWorkspaceId !== workspaceId
        }),
      )

      if (view.activeWorkspaceId !== workspaceId) {
        return {
          ...view,
          workspaceState,
        }
      }

      return {
        ...view,
        activeWorkspaceId: fallbackWorkspace.id,
        workspaceState: {
          ...workspaceState,
          [fallbackWorkspace.id]:
            workspaceState[fallbackWorkspace.id] ?? createWorkspaceViewState(fallbackWorkspace),
        },
      }
    }),
  }
}

function updateCallerFocus(
  state: ShellState,
  command: ShellCommandBase,
  workspace: Workspace,
  paneId: string,
  tabId: string | null,
): ShellState {
  return updateWorkspaceViewState(state, command.viewId, workspace, (viewState) => ({
    focusedPaneId: paneId,
    activeTabByPaneId: {
      ...viewState.activeTabByPaneId,
      [paneId]: tabId,
    },
  }))
}

function ensureActorView(
  state: ShellState,
  command: Extract<ShellCommand, { type: "actor.ensure" }>,
  workspace: Workspace,
): ShellState {
  const actorName = command.name?.trim() || `Actor ${state.actors.length + 1}`
  const actors = state.actors.some((actor) => actor.id === command.targetActorId)
    ? state.actors
    : [
        ...state.actors,
        {
          id: command.targetActorId,
          name: actorName,
        },
      ]
  const existingView = state.views.find((view) => view.id === command.targetViewId)
  const views = existingView
    ? state.views
    : [...state.views, createViewWithId(command.targetActorId, workspace, command.targetViewId)]
  const withActorAndView = {
    ...state,
    actors,
    views,
  }

  if (!command.focusedPaneId || !command.activeTabId) {
    return withActorAndView
  }

  if (!paneHasTab(workspace.root, command.focusedPaneId, command.activeTabId)) {
    return withActorAndView
  }

  return updateWorkspaceViewState(
    updateView(withActorAndView, command.targetViewId, (view) => ({
      ...view,
      activeWorkspaceId: workspace.id,
    })),
    command.targetViewId,
    workspace,
    (viewState) => ({
      focusedPaneId: command.focusedPaneId ?? viewState.focusedPaneId,
      activeTabByPaneId: {
        ...viewState.activeTabByPaneId,
        [command.focusedPaneId as string]: command.activeTabId ?? null,
      },
    }),
  )
}

const localActor: Actor = {
  id: createId("actor"),
  name: "Local Actor",
}
const firstWorkspace = createWorkspace(1)
const firstView = createView(localActor.id, firstWorkspace)

export const initialShellState: ShellState = {
  actors: [localActor],
  views: [firstView],
  activeActorId: localActor.id,
  activeViewId: firstView.id,
  workspaces: [firstWorkspace],
}

export function shellReducer(state: ShellState, command: ShellCommand): ShellState {
  if (!commandMatchesView(state, command)) {
    return state
  }

  const view = state.views.find((item) => item.id === command.viewId)

  if (!view) {
    return state
  }

  const activeWorkspace = getActiveWorkspace(state, view)

  switch (command.type) {
    case "view.activate":
      if (state.activeActorId === command.actorId && state.activeViewId === command.viewId) {
        return state
      }

      return {
        ...state,
        activeActorId: command.actorId,
        activeViewId: command.viewId,
      }

    case "actor.create": {
      const workspace = command.workspaceId
        ? state.workspaces.find((item) => item.id === command.workspaceId)
        : activeWorkspace

      if (!workspace) {
        return state
      }

      const actorName = command.name?.trim() || `Actor ${state.actors.length + 1}`
      const actor: Actor = {
        id: createId("actor"),
        name: actorName,
      }
      const actorView = createView(actor.id, workspace)

      return {
        ...state,
        actors: [...state.actors, actor],
        views: [...state.views, actorView],
      }
    }

    case "actor.ensure": {
      const workspace = command.workspaceId
        ? state.workspaces.find((item) => item.id === command.workspaceId)
        : activeWorkspace

      if (!workspace) {
        return state
      }

      return ensureActorView(state, command, workspace)
    }

    case "workspace.create": {
      const workspace = createWorkspace(state.workspaces.length + 1, {
        name: command.name,
        directory: command.directory,
      })

      return updateView(
        {
          ...state,
          workspaces: [...state.workspaces, workspace],
        },
        command.viewId,
        (currentView) => ({
          ...currentView,
          activeWorkspaceId: workspace.id,
          workspaceState: {
            ...currentView.workspaceState,
            [workspace.id]: createWorkspaceViewState(workspace),
          },
        }),
      )
    }

    case "workspace.select": {
      const workspace = state.workspaces.find((item) => item.id === command.workspaceId)

      if (!workspace) {
        return state
      }

      return updateView(state, command.viewId, (currentView) => ({
        ...currentView,
        activeWorkspaceId: workspace.id,
        workspaceState: {
          ...currentView.workspaceState,
          [workspace.id]: getWorkspaceViewState(currentView, workspace),
        },
      }))
    }

    case "workspace.rename": {
      const name = command.name.trim()

      if (!name || !state.workspaces.some((workspace) => workspace.id === command.workspaceId)) {
        return state
      }

      return {
        ...state,
        workspaces: state.workspaces.map((workspace) =>
          workspace.id === command.workspaceId ? { ...workspace, name } : workspace,
        ),
      }
    }

    case "workspace.delete":
      return deleteWorkspace(state, command.workspaceId)

    case "workspace.reorder":
      return {
        ...state,
        workspaces: reorderWorkspaces(
          state.workspaces,
          command.workspaceId,
          command.targetWorkspaceId,
        ),
      }

    case "view.focusPane":
      if (!findPane(activeWorkspace.root, command.paneId)) {
        return state
      }

      if (getWorkspaceViewState(view, activeWorkspace).focusedPaneId === command.paneId) {
        return state
      }

      return updateWorkspaceViewState(state, command.viewId, activeWorkspace, (viewState) => ({
        ...viewState,
        focusedPaneId: command.paneId,
      }))

    case "tab.create": {
      if (!findPane(activeWorkspace.root, command.paneId)) {
        return state
      }

      const tab = createEmptyTab(`New Tab ${countTabs(activeWorkspace.root) + 1}`)
      const nextState = updateWorkspace(state, activeWorkspace.id, (workspace) => ({
        ...workspace,
        root: addTabToPane(workspace.root, command.paneId, tab),
      }))
      const nextWorkspace = getWorkspace(nextState, activeWorkspace.id)

      return updateCallerFocus(
        normalizeViewsForWorkspace(nextState, nextWorkspace),
        command,
        nextWorkspace,
        command.paneId,
        tab.id,
      )
    }

    case "tab.open": {
      if (!findPane(activeWorkspace.root, command.paneId)) {
        return state
      }

      const tab = createTypedTab(command.title, command.tabTypeId, command.state ?? {})
      const nextState = updateWorkspace(state, activeWorkspace.id, (workspace) => ({
        ...workspace,
        root: addTabToPane(workspace.root, command.paneId, tab),
      }))
      const nextWorkspace = getWorkspace(nextState, activeWorkspace.id)

      return updateCallerFocus(
        normalizeViewsForWorkspace(nextState, nextWorkspace),
        command,
        nextWorkspace,
        command.paneId,
        tab.id,
      )
    }

    case "tab.activate": {
      if (!paneHasTab(activeWorkspace.root, command.paneId, command.tabId)) {
        return state
      }

      const viewState = getWorkspaceViewState(view, activeWorkspace)

      if (
        viewState.focusedPaneId === command.paneId &&
        getActiveTabId(findPane(activeWorkspace.root, command.paneId) as PaneNode, viewState) ===
          command.tabId
      ) {
        return state
      }

      return updateCallerFocus(state, command, activeWorkspace, command.paneId, command.tabId)
    }

    case "tab.setType": {
      if (!paneHasTab(activeWorkspace.root, command.paneId, command.tabId)) {
        return state
      }

      const nextState = updateWorkspace(state, activeWorkspace.id, (workspace) => ({
        ...workspace,
        root: updateTab(workspace.root, command.paneId, command.tabId, (tab) => ({
          ...tab,
          title: command.title,
          typeId: command.tabTypeId,
          state: command.state ?? {},
        })),
      }))
      const nextWorkspace = getWorkspace(nextState, activeWorkspace.id)

      return updateCallerFocus(
        normalizeViewsForWorkspace(nextState, nextWorkspace),
        command,
        nextWorkspace,
        command.paneId,
        command.tabId,
      )
    }

    case "tab.updateState": {
      if (!paneHasTab(activeWorkspace.root, command.paneId, command.tabId)) {
        return state
      }

      const nextState = updateWorkspace(state, activeWorkspace.id, (workspace) => ({
        ...workspace,
        root: updateTab(workspace.root, command.paneId, command.tabId, (tab) => ({
          ...tab,
          state: {
            ...tab.state,
            ...command.state,
          },
        })),
      }))
      const nextWorkspace = getWorkspace(nextState, activeWorkspace.id)

      return normalizeViewsForWorkspace(nextState, nextWorkspace)
    }

    case "tab.close": {
      const closingTab = findTab(activeWorkspace.root, command.paneId, command.tabId)

      if (!closingTab) {
        return state
      }

      let didClose = false
      const nextState = updateWorkspace(state, activeWorkspace.id, (workspace) => {
        const root = closeTab(workspace.root, command.paneId, command.tabId)
        didClose = root !== workspace.root

        return {
          ...workspace,
          root,
        }
      })

      if (!didClose) {
        return state
      }

      const nextWorkspace = getWorkspace(nextState, activeWorkspace.id)

      return removeClosedChatAgent(normalizeViewsForWorkspace(nextState, nextWorkspace), closingTab)
    }

    case "pane.split": {
      if (!findPane(activeWorkspace.root, command.paneId)) {
        return state
      }

      const tab = createEmptyTab(`New Tab ${countTabs(activeWorkspace.root) + 1}`)
      const pane = createPane(tab)
      const nextState = updateWorkspace(state, activeWorkspace.id, (workspace) => ({
        ...workspace,
        root: splitPane(workspace.root, command.paneId, command.direction, pane, "after"),
      }))
      const nextWorkspace = getWorkspace(nextState, activeWorkspace.id)

      return updateCallerFocus(
        normalizeViewsForWorkspace(nextState, nextWorkspace),
        command,
        nextWorkspace,
        pane.id,
        tab.id,
      )
    }

    case "tab.split": {
      let splitPaneId: string | null = null
      let didSplit = false
      const nextState = updateWorkspace(state, activeWorkspace.id, (workspace) => {
        const result = splitTab(
          workspace.root,
          command.tabId,
          command.sourcePaneId,
          command.targetPaneId,
          command.direction,
          command.placement,
        )
        splitPaneId = result.paneId
        didSplit = result.root !== workspace.root

        return {
          ...workspace,
          root: result.root,
        }
      })

      if (!didSplit) {
        return state
      }

      const nextWorkspace = getWorkspace(nextState, activeWorkspace.id)

      return updateCallerFocus(
        normalizeViewsForWorkspace(nextState, nextWorkspace),
        command,
        nextWorkspace,
        splitPaneId ?? command.targetPaneId,
        command.tabId,
      )
    }

    case "tab.move": {
      let didMove = false
      const nextState = updateWorkspace(state, activeWorkspace.id, (workspace) => {
        const root = moveTab(
          workspace.root,
          command.tabId,
          command.sourcePaneId,
          command.targetPaneId,
          command.targetIndex,
        )
        didMove = root !== workspace.root

        return {
          ...workspace,
          root,
        }
      })

      if (!didMove) {
        return state
      }

      const nextWorkspace = getWorkspace(nextState, activeWorkspace.id)

      return updateCallerFocus(
        normalizeViewsForWorkspace(nextState, nextWorkspace),
        command,
        nextWorkspace,
        command.targetPaneId,
        command.tabId,
      )
    }

    default:
      return state
  }
}
