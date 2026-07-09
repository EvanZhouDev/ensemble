import {
  type Collision,
  type CollisionDetection,
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { FolderOpen, MoreHorizontal, MousePointer2, Plus, Square, User, X } from "lucide-react"
import {
  type CSSProperties,
  type Dispatch,
  type FormEvent,
  Fragment,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Group, Panel, Separator } from "react-resizable-panels"
import ensembleLogoUrl from "../../../assets/ensemble.svg?url"
import {
  collectPanes,
  EMPTY_TAB_TYPE_ID,
  findPane,
  getActiveTabId,
  getActiveView,
  getActiveWorkspace,
  getWorkspaceViewState,
  initialShellState,
  type LayoutNode,
  type PaneNode,
  type ShellCommand,
  type ShellCommandContext,
  type ShellState,
  type SplitDirection,
  type SplitPlacement,
  type Workspace,
  type WorkspaceTab,
  type WorkspaceViewState,
} from "./shellModel"
import "./styles.css"
import { getRuntimeApi } from "./runtimeApi"
import { tabRegistry } from "./tab-extensions/registry"

type TabDragData = {
  type: "tab"
  paneId: string
  tab: WorkspaceTab
}

type PaneDropData = {
  type: "pane"
  paneId: string
}

type WorkspaceDragData = {
  type: "workspace"
  workspaceId: string
}

type DragData = TabDragData | PaneDropData | WorkspaceDragData
type SplitEdge = "left" | "right" | "top" | "bottom"
type SplitPreview = {
  paneId: string
  edge: SplitEdge
  direction: SplitDirection
  placement: SplitPlacement
}
type TabDropTarget = {
  paneId: string
  index: number
  isNoop: boolean
}
type ActorTabMark = {
  actorId: string
  actorName: string
  color: string
  isActive: boolean
  kind: "user" | "agent"
}
type ActorTabMarksByTabId = Record<string, ActorTabMark[]>

const AGENT_ACTOR_COLORS = [
  "#74d99f",
  "#c792ea",
  "#f7b955",
  "#64d2ff",
  "#ff8f70",
  "#9db0ff",
  "#e879f9",
  "#5eead4",
]

const splitAwareCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = withoutActiveCollision(pointerWithin(args), args.active.id)

  if (pointerCollisions.length > 0) {
    return pointerCollisions
  }

  return withoutActiveCollision(closestCorners(args), args.active.id)
}

const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 360

function withoutActiveCollision(collisions: Collision[], activeId: string | number): Collision[] {
  return collisions.filter((collision) => collision.id !== activeId)
}

function getDragPoint(event: Pick<DragMoveEvent, "activatorEvent" | "delta">): {
  x: number
  y: number
} | null {
  if (!("clientX" in event.activatorEvent) || !("clientY" in event.activatorEvent)) {
    return null
  }

  const clientX = event.activatorEvent.clientX
  const clientY = event.activatorEvent.clientY

  if (typeof clientX !== "number" || typeof clientY !== "number") {
    return null
  }

  return {
    x: clientX + event.delta.x,
    y: clientY + event.delta.y,
  }
}

function getNearestSplitEdge(xRatio: number, yRatio: number): SplitEdge {
  const distances: Record<SplitEdge, number> = {
    left: xRatio,
    right: 1 - xRatio,
    top: yRatio,
    bottom: 1 - yRatio,
  }

  return (Object.entries(distances) as Array<[SplitEdge, number]>).reduce((nearest, current) =>
    current[1] < nearest[1] ? current : nearest,
  )[0]
}

function looksAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
}

function normalizeWorkspaceDirectoryInput(path: string, testWorkspaceRoot: string): string {
  const trimmedPath = path.trim()
  const normalizedRoot = testWorkspaceRoot.replace(/\/+$/, "")

  if (trimmedPath === normalizedRoot) {
    return "."
  }

  if (trimmedPath.startsWith(`${normalizedRoot}/`)) {
    return trimmedPath.slice(normalizedRoot.length + 1)
  }

  return trimmedPath
}

function formatWorkspaceDirectory(directory: string, testWorkspaceRoot: string): string {
  if (looksAbsolutePath(directory)) {
    return directory
  }

  if (directory === ".") {
    return testWorkspaceRoot
  }

  return `${testWorkspaceRoot.replace(/\/+$/, "")}/${directory}`
}

function actorColor(actorIndex: number, kind: ActorTabMark["kind"]): string {
  if (kind === "user") {
    return "#5b8cff"
  }

  return AGENT_ACTOR_COLORS[Math.max(0, actorIndex - 1) % AGENT_ACTOR_COLORS.length]
}

function getLiveAgentActorIds(state: ShellState): Set<string> {
  const actorIds = new Set<string>()

  for (const workspace of state.workspaces) {
    for (const pane of collectPanes(workspace.root)) {
      for (const tab of pane.tabs) {
        if (tab.typeId !== "ai-agent.chat") {
          continue
        }

        const explicitActorId = tab.state.agentActorId

        if (typeof explicitActorId === "string" && explicitActorId.trim().length > 0) {
          actorIds.add(explicitActorId)
        }

        actorIds.add(`agent-actor-${tab.id}`)
      }
    }
  }

  return actorIds
}

function getActorTabMarksByTabId(state: ShellState, workspace: Workspace): ActorTabMarksByTabId {
  const humanActorId = state.actors[0]?.id
  const liveAgentActorIds = getLiveAgentActorIds(state)
  const marksByTabId: ActorTabMarksByTabId = {}

  function createActorMark(actorId: string, isActive: boolean): ActorTabMark | null {
    if (actorId !== humanActorId && !liveAgentActorIds.has(actorId)) {
      return null
    }

    const actor = state.actors.find((candidate) => candidate.id === actorId)

    if (!actor) {
      return null
    }

    const kind = actor.id === humanActorId ? "user" : "agent"
    const actorIndex = state.actors.findIndex((candidate) => candidate.id === actor.id)

    return {
      actorId: actor.id,
      actorName: actor.name,
      color: actorColor(actorIndex, kind),
      isActive,
      kind,
    }
  }

  function addMark(tabId: string, mark: ActorTabMark): void {
    const existingMarks = marksByTabId[tabId] ?? []
    const existingMark = existingMarks.find((candidate) => candidate.actorId === mark.actorId)

    if (existingMark) {
      existingMark.isActive = existingMark.isActive || mark.isActive
      return
    }

    marksByTabId[tabId] = [...existingMarks, mark]
  }

  state.views.forEach((view) => {
    if (view.activeWorkspaceId !== workspace.id) {
      return
    }

    const viewState = getWorkspaceViewState(view, workspace)
    const focusedPane = viewState.focusedPaneId
      ? findPane(workspace.root, viewState.focusedPaneId)
      : null

    if (!focusedPane) {
      return
    }

    const activeTabId = getActiveTabId(focusedPane, viewState)

    if (!activeTabId) {
      return
    }

    const mark = createActorMark(view.actorId, true)

    if (mark) {
      addMark(activeTabId, mark)
    }
  })

  for (const pane of collectPanes(workspace.root)) {
    for (const tab of pane.tabs) {
      const agentActorId = tab.state.agentActorId

      if (typeof agentActorId !== "string" || agentActorId.trim().length === 0) {
        continue
      }

      const mark = createActorMark(agentActorId, false)

      if (mark) {
        addMark(tab.id, mark)
      }
    }
  }

  return marksByTabId
}

function getDefaultWorkspaceDirectory(runtimeApi: AppShellApi, workspaceIndex: number): string {
  return `${runtimeApi.testWorkspaceRoot.replace(/\/+$/, "")}/workspace-${workspaceIndex}`
}

function workspaceNameFromDirectory(directory: string, fallbackIndex: number): string {
  const trimmedDirectory = directory.trim().replace(/[\\/]+$/, "")
  const name = trimmedDirectory.split(/[\\/]/).filter(Boolean).at(-1)

  return name || `Workspace ${fallbackIndex}`
}

function isAppShortcut(value: unknown): value is AppShortcut {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false
  }

  const shortcut = value as Partial<AppShortcut>

  if (
    shortcut.type === "tab.close" ||
    shortcut.type === "tab.new" ||
    shortcut.type === "tab.next" ||
    shortcut.type === "tab.previous"
  ) {
    return true
  }

  return shortcut.type === "tab.select" && typeof shortcut.index === "number"
}

function shortcutFromKeyboardEvent(event: KeyboardEvent): AppShortcut | null {
  if (event.isComposing) {
    return null
  }

  const key = event.key.toLowerCase()
  const isApplePlatform =
    typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(navigator.platform)
  const hasPrimaryModifier = isApplePlatform ? event.metaKey : event.ctrlKey
  const hasOnlyPrimaryModifier =
    hasPrimaryModifier &&
    !event.altKey &&
    !event.shiftKey &&
    (isApplePlatform ? !event.ctrlKey : !event.metaKey)
  const hasPrimaryShift =
    hasPrimaryModifier &&
    event.shiftKey &&
    !event.altKey &&
    (isApplePlatform ? !event.ctrlKey : !event.metaKey)

  if (hasOnlyPrimaryModifier && key === "w") {
    return { type: "tab.close" }
  }

  if (hasOnlyPrimaryModifier && key === "t") {
    return { type: "tab.new" }
  }

  if (hasPrimaryShift && (key === "]" || key === "}")) {
    return { type: "tab.next" }
  }

  if (hasPrimaryShift && (key === "[" || key === "{")) {
    return { type: "tab.previous" }
  }

  if (hasOnlyPrimaryModifier && /^[1-9]$/.test(key)) {
    return { type: "tab.select", index: Number(key) - 1 }
  }

  if (!event.metaKey && event.ctrlKey && !event.altKey && key === "tab") {
    return { type: event.shiftKey ? "tab.previous" : "tab.next" }
  }

  return null
}

export function App(): React.JSX.Element {
  const runtimeApi = useMemo(() => getRuntimeApi(), [])
  const [state, setState] = useState<ShellState>(initialShellState)
  const [draggingTabData, setDraggingTabData] = useState<TabDragData | null>(null)
  const [splitPreview, setSplitPreview] = useState<SplitPreview | null>(null)
  const [tabDropTarget, setTabDropTarget] = useState<TabDropTarget | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(220)
  const [controlError, setControlError] = useState<string | null>(null)
  const activeView = getActiveView(state)
  const activeWorkspace = getActiveWorkspace(state, activeView)
  const activeWorkspaceViewState = getWorkspaceViewState(activeView, activeWorkspace)
  const actorMarksByTabId = useMemo(
    () => getActorTabMarksByTabId(state, activeWorkspace),
    [state, activeWorkspace],
  )
  const commandContext = useMemo<ShellCommandContext>(
    () => ({
      actorId: activeView.actorId,
      viewId: activeView.id,
    }),
    [activeView.actorId, activeView.id],
  )
  const focusedPaneId = activeWorkspaceViewState.focusedPaneId
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const dispatch = useCallback<Dispatch<ShellCommand>>(
    (command) => {
      void runtimeApi.ensemble
        .dispatch({ command })
        .then((response) => {
          setState(response.snapshot.state)
          setControlError(null)
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Failed to dispatch command."
          setControlError(message)
        })
    },
    [runtimeApi],
  )
  const handleAppShortcut = useCallback(
    (shortcut: AppShortcut) => {
      const panes = collectPanes(activeWorkspace.root)
      const focusedPane =
        (focusedPaneId ? panes.find((pane) => pane.id === focusedPaneId) : null) ?? panes[0]

      if (!focusedPane) {
        return
      }

      const activeTabId = getActiveTabId(focusedPane, activeWorkspaceViewState)
      const activeIndex = focusedPane.tabs.findIndex((tab) => tab.id === activeTabId)

      if (shortcut.type === "tab.new") {
        dispatch({ ...commandContext, type: "tab.create", paneId: focusedPane.id })
        return
      }

      if (shortcut.type === "tab.close") {
        if (activeTabId) {
          dispatch({
            ...commandContext,
            type: "tab.close",
            paneId: focusedPane.id,
            tabId: activeTabId,
          })
        }
        return
      }

      if (focusedPane.tabs.length === 0) {
        return
      }

      if (shortcut.type === "tab.next" || shortcut.type === "tab.previous") {
        const fallbackIndex = activeIndex >= 0 ? activeIndex : 0
        const offset = shortcut.type === "tab.next" ? 1 : -1
        const nextIndex =
          (fallbackIndex + offset + focusedPane.tabs.length) % focusedPane.tabs.length
        const nextTab = focusedPane.tabs[nextIndex]

        if (nextTab) {
          dispatch({
            ...commandContext,
            type: "tab.activate",
            paneId: focusedPane.id,
            tabId: nextTab.id,
          })
        }
        return
      }

      if (shortcut.type === "tab.select") {
        const targetIndex =
          shortcut.index === 8
            ? focusedPane.tabs.length - 1
            : Math.min(shortcut.index, focusedPane.tabs.length - 1)
        const targetTab = focusedPane.tabs[targetIndex]

        if (targetTab) {
          dispatch({
            ...commandContext,
            type: "tab.activate",
            paneId: focusedPane.id,
            tabId: targetTab.id,
          })
        }
      }
    },
    [activeWorkspace, activeWorkspaceViewState, commandContext, dispatch, focusedPaneId],
  )

  useEffect(() => {
    let isDisposed = false

    void runtimeApi.ensemble
      .getState()
      .then((snapshot) => {
        if (!isDisposed) {
          setState(snapshot.state)
          setControlError(null)
        }
      })
      .catch((error: unknown) => {
        if (!isDisposed) {
          const message = error instanceof Error ? error.message : "Failed to load shell state."
          setControlError(message)
        }
      })

    return () => {
      isDisposed = true
    }
  }, [runtimeApi])

  useEffect(() => {
    return runtimeApi.shortcuts?.onShortcut((shortcut) => {
      if (isAppShortcut(shortcut)) {
        handleAppShortcut(shortcut)
      }
    })
  }, [handleAppShortcut, runtimeApi])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      const shortcut = shortcutFromKeyboardEvent(event)

      if (!shortcut) {
        return
      }

      event.preventDefault()
      handleAppShortcut(shortcut)
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleAppShortcut])

  useEffect(() => {
    return runtimeApi.ensemble.onEvent((event) => {
      setState(event.snapshot.state)
      setControlError(null)
    })
  }, [runtimeApi])

  function handleDragStart(event: DragStartEvent): void {
    const data = event.active.data.current as DragData | undefined

    if (data?.type === "tab") {
      setDraggingTabData(data)
      setSplitPreview(null)
      setTabDropTarget(null)
      return
    }

    setDraggingTabData(null)
    setSplitPreview(null)
    setTabDropTarget(null)
  }

  function handleDragMove(event: DragMoveEvent): void {
    const activeData = event.active.data.current as DragData | undefined

    if (activeData?.type !== "tab") {
      setSplitPreview(null)
      setTabDropTarget(null)
      return
    }

    const nextSplitPreview = getSplitPreview(event, activeData)
    setSplitPreview(nextSplitPreview)
    setTabDropTarget(nextSplitPreview ? null : getTabDropTarget(event, activeData))
  }

  function handleDragEnd(event: DragEndEvent): void {
    const activeData = event.active.data.current as DragData | undefined
    const overData = event.over?.data.current as DragData | undefined
    const finalSplitPreview =
      activeData?.type === "tab" ? (getSplitPreview(event, activeData) ?? splitPreview) : null
    const finalTabDropTarget =
      activeData?.type === "tab" && !finalSplitPreview
        ? (getTabDropTarget(event, activeData) ?? tabDropTarget)
        : null
    setDraggingTabData(null)
    setSplitPreview(null)
    setTabDropTarget(null)

    if (activeData?.type === "workspace") {
      if (overData?.type === "workspace" && overData.workspaceId !== activeData.workspaceId) {
        dispatch({
          ...commandContext,
          type: "workspace.reorder",
          workspaceId: activeData.workspaceId,
          targetWorkspaceId: overData.workspaceId,
        })
      }

      return
    }

    if (activeData?.type !== "tab") {
      return
    }

    const sourcePaneId = activeData.paneId

    if (finalSplitPreview) {
      dispatch({
        ...commandContext,
        type: "tab.split",
        tabId: activeData.tab.id,
        sourcePaneId,
        targetPaneId: finalSplitPreview.paneId,
        direction: finalSplitPreview.direction,
        placement: finalSplitPreview.placement,
      })
      return
    }

    if (finalTabDropTarget) {
      if (finalTabDropTarget.isNoop) {
        return
      }

      dispatch({
        ...commandContext,
        type: "tab.move",
        tabId: activeData.tab.id,
        sourcePaneId,
        targetPaneId: finalTabDropTarget.paneId,
        targetIndex: finalTabDropTarget.index,
      })
      return
    }

    if (!overData || overData.type === "workspace") {
      return
    }

    let targetPaneId: string
    let targetIndex: number

    if (overData.type === "tab") {
      if (overData.tab.id === activeData.tab.id) {
        return
      }

      targetPaneId = overData.paneId
      const targetPane = findPane(activeWorkspace.root, targetPaneId)
      targetIndex = targetPane?.tabs.findIndex((tab) => tab.id === overData.tab.id) ?? 0
    } else {
      targetPaneId = overData.paneId

      if (targetPaneId === sourcePaneId) {
        return
      }

      targetIndex = findPane(activeWorkspace.root, targetPaneId)?.tabs.length ?? 0
    }

    dispatch({
      ...commandContext,
      type: "tab.move",
      tabId: activeData.tab.id,
      sourcePaneId,
      targetPaneId,
      targetIndex,
    })
  }

  function handleDragCancel(): void {
    setDraggingTabData(null)
    setSplitPreview(null)
    setTabDropTarget(null)
  }

  function handleSidebarResizeStart(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth

    function handlePointerMove(moveEvent: PointerEvent): void {
      const nextWidth = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, startWidth + moveEvent.clientX - startX),
      )
      setSidebarWidth(nextWidth)
    }

    function handlePointerUp(): void {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)
  }

  function getSplitPreview(
    event: Pick<DragMoveEvent, "activatorEvent" | "delta">,
    activeData: TabDragData,
  ): SplitPreview | null {
    const point = getDragPoint(event)

    if (!point) {
      return null
    }

    const elements = document.elementsFromPoint(point.x, point.y)
    const paneElement =
      elements
        .map((element) => element.closest<HTMLElement>(".pane"))
        .find((element) => element !== null) ?? null
    const paneId = paneElement?.dataset.paneId

    const isOverTabStrip = elements.some((element) => {
      const tabStrip = element.closest(".tab-strip")
      return tabStrip ? paneElement?.contains(tabStrip) : false
    })

    if (!paneElement || !paneId || isOverTabStrip) {
      return null
    }

    const sourcePane = findPane(activeWorkspace.root, activeData.paneId)

    if (!sourcePane || (paneId === activeData.paneId && sourcePane.tabs.length <= 1)) {
      return null
    }

    const contentElement = paneElement.querySelector<HTMLElement>(".pane-content")

    if (!contentElement) {
      return null
    }

    const rect = contentElement.getBoundingClientRect()

    if (
      point.x < rect.left ||
      point.x > rect.right ||
      point.y < rect.top ||
      point.y > rect.bottom
    ) {
      return null
    }

    const edge = getNearestSplitEdge(
      (point.x - rect.left) / rect.width,
      (point.y - rect.top) / rect.height,
    )
    const config = splitEdgeConfig[edge]

    return {
      paneId,
      edge,
      direction: config.direction,
      placement: config.placement,
    }
  }

  function getTabDropTarget(
    event: Pick<DragMoveEvent, "activatorEvent" | "delta">,
    activeData: TabDragData,
  ): TabDropTarget | null {
    const point = getDragPoint(event)

    if (!point) {
      return null
    }

    const elements = document.elementsFromPoint(point.x, point.y)
    const tabStrip =
      elements
        .map((element) => element.closest<HTMLElement>(".tab-strip"))
        .find((element) => element !== null) ?? null
    const paneElement = tabStrip?.closest<HTMLElement>(".pane")
    const paneId = paneElement?.dataset.paneId

    if (!tabStrip || !paneId) {
      return null
    }

    const rect = tabStrip.getBoundingClientRect()

    if (
      point.x < rect.left ||
      point.x > rect.right ||
      point.y < rect.top ||
      point.y > rect.bottom
    ) {
      return null
    }

    const tabElements = Array.from(tabStrip.querySelectorAll<HTMLElement>(".tab[data-tab-id]"))
      .filter((element) => element.dataset.tabId !== activeData.tab.id)
      .sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left)
    const index = tabElements.findIndex((element) => {
      const tabRect = element.getBoundingClientRect()
      return point.x < tabRect.left + tabRect.width / 2
    })
    const sourcePane = findPane(activeWorkspace.root, activeData.paneId)
    const sourceIndex = sourcePane?.tabs.findIndex((tab) => tab.id === activeData.tab.id) ?? -1
    const boundedIndex = index === -1 ? tabElements.length : index

    return {
      paneId,
      index: boundedIndex,
      isNoop: paneId === activeData.paneId && boundedIndex === sourceIndex,
    }
  }

  return (
    <DndContext
      collisionDetection={splitAwareCollisionDetection}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
      onDragMove={handleDragMove}
      onDragStart={handleDragStart}
      sensors={sensors}
    >
      <div
        className="app-shell"
        style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)` }}
      >
        <WorkspaceRail
          activeWorkspaceId={activeWorkspace.id}
          commandContext={commandContext}
          dispatch={dispatch}
          onResizeStart={handleSidebarResizeStart}
          runtimeApi={runtimeApi}
          workspaces={state.workspaces}
        />
        <main className="workspace-main">
          {controlError ? <div className="control-error">{controlError}</div> : null}
          <section className="layout-host" aria-label={activeWorkspace.name}>
            <LayoutView
              actorMarksByTabId={actorMarksByTabId}
              commandContext={commandContext}
              dispatch={dispatch}
              draggingTabId={draggingTabData?.tab.id ?? null}
              focusedPaneId={focusedPaneId}
              node={activeWorkspace.root}
              splitPreview={splitPreview}
              tabDropTarget={tabDropTarget}
              runtimeApi={runtimeApi}
              workspace={activeWorkspace}
              viewState={activeWorkspaceViewState}
            />
          </section>
        </main>
      </div>
      <DragOverlay>
        {draggingTabData ? <TabDragPreview tab={draggingTabData.tab} /> : null}
      </DragOverlay>
    </DndContext>
  )
}

type WorkspaceRailProps = {
  workspaces: Workspace[]
  activeWorkspaceId: string
  runtimeApi: AppShellApi
  commandContext: ShellCommandContext
  dispatch: Dispatch<ShellCommand>
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
}

function WorkspaceRail({
  workspaces,
  activeWorkspaceId,
  runtimeApi,
  commandContext,
  dispatch,
  onResizeStart,
}: WorkspaceRailProps): React.JSX.Element {
  const [draftDirectory, setDraftDirectory] = useState<string | null>(null)
  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null)
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState("")

  function startCreateWorkspace(): void {
    const workspaceIndex = workspaces.length + 1

    setWorkspaceMenuId(null)
    cancelRenameWorkspace()
    setDraftDirectory(getDefaultWorkspaceDirectory(runtimeApi, workspaceIndex))
  }

  async function browseWorkspaceDirectory(): Promise<void> {
    const selection = await runtimeApi.workspace?.chooseDirectory?.()

    if (selection) {
      setDraftDirectory(selection.path)
      return
    }

    const browserPicker = (
      window as Window & {
        showDirectoryPicker?: () => Promise<{ name?: string }>
      }
    ).showDirectoryPicker

    if (!browserPicker) {
      return
    }

    try {
      const handle = await browserPicker.call(window)

      if (handle.name) {
        setDraftDirectory(`${runtimeApi.testWorkspaceRoot.replace(/\/+$/, "")}/${handle.name}`)
      }
    } catch {
      // The browser picker throws when the user cancels.
    }
  }

  function createWorkspace(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()

    if (!draftDirectory?.trim()) {
      return
    }

    const workspaceIndex = workspaces.length + 1
    const directory = normalizeWorkspaceDirectoryInput(draftDirectory, runtimeApi.testWorkspaceRoot)

    dispatch({
      ...commandContext,
      type: "workspace.create",
      name: workspaceNameFromDirectory(draftDirectory, workspaceIndex),
      directory,
    })
    setDraftDirectory(null)
  }

  function startRenameWorkspace(workspace: Workspace): void {
    setWorkspaceMenuId(null)
    setRenamingWorkspaceId(workspace.id)
    setRenameDraft(workspace.name)
  }

  function cancelRenameWorkspace(): void {
    setRenamingWorkspaceId(null)
    setRenameDraft("")
  }

  function finishRenameWorkspace(workspace: Workspace, nextName = renameDraft): void {
    if (nextName.trim()) {
      dispatch({
        ...commandContext,
        type: "workspace.rename",
        workspaceId: workspace.id,
        name: nextName,
      })
    }

    cancelRenameWorkspace()
  }

  function submitRenameWorkspace(event: FormEvent<HTMLFormElement>, workspace: Workspace): void {
    event.preventDefault()
    finishRenameWorkspace(workspace)
  }

  function deleteWorkspace(workspace: Workspace): void {
    setWorkspaceMenuId(null)
    cancelRenameWorkspace()
    dispatch({
      ...commandContext,
      type: "workspace.delete",
      workspaceId: workspace.id,
    })
  }

  return (
    <aside className="workspace-rail">
      <div className="rail-header" />
      <div className="workspace-list" role="tablist" aria-label="Workspaces">
        <SortableContext
          items={workspaces.map((workspace) => workspace.id)}
          strategy={verticalListSortingStrategy}
        >
          {workspaces.map((workspace) => {
            const displayPath = formatWorkspaceDirectory(
              workspace.directory,
              runtimeApi.testWorkspaceRoot,
            )

            return (
              <SortableWorkspaceButton
                activeWorkspaceId={activeWorkspaceId}
                cancelRenameWorkspace={cancelRenameWorkspace}
                canDelete={workspaces.length > 1}
                closeWorkspaceMenu={() => setWorkspaceMenuId(null)}
                commandContext={commandContext}
                deleteWorkspace={deleteWorkspace}
                dispatch={dispatch}
                displayPath={displayPath}
                finishRenameWorkspace={finishRenameWorkspace}
                isMenuOpen={workspaceMenuId === workspace.id}
                isRenaming={renamingWorkspaceId === workspace.id}
                key={workspace.id}
                renameDraft={renameDraft}
                setRenameDraft={setRenameDraft}
                startRenameWorkspace={startRenameWorkspace}
                submitRenameWorkspace={submitRenameWorkspace}
                toggleMenu={() => {
                  setRenamingWorkspaceId(null)
                  setWorkspaceMenuId((current) => (current === workspace.id ? null : workspace.id))
                }}
                workspace={workspace}
              />
            )
          })}
        </SortableContext>
      </div>
      {draftDirectory !== null ? (
        <form className="workspace-create-form" onSubmit={createWorkspace}>
          <div className="workspace-create-copy">
            <strong>New workspace</strong>
            <p>Choose the folder terminals, files, and agents will use for this workspace.</p>
          </div>
          <div className="folder-picker">
            <button
              className="folder-picker-button"
              onClick={() => {
                void browseWorkspaceDirectory()
              }}
              type="button"
            >
              <FolderOpen size={15} />
              <span>Choose folder</span>
            </button>
            <input
              aria-label="Workspace path"
              className="folder-picker-input"
              onChange={(event) => setDraftDirectory(event.target.value)}
              value={draftDirectory}
            />
          </div>
          <div className="workspace-create-actions">
            <button className="workspace-create-primary" type="submit">
              Create workspace
            </button>
            <button onClick={() => setDraftDirectory(null)} type="button">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          aria-label="New workspace"
          className="workspace-create"
          onClick={startCreateWorkspace}
          title="New workspace"
          type="button"
        >
          <Plus size={15} />
          <span>New workspace</span>
        </button>
      )}
      <div aria-hidden="true" className="sidebar-resize-handle" onPointerDown={onResizeStart} />
    </aside>
  )
}

type SortableWorkspaceButtonProps = {
  workspace: Workspace
  activeWorkspaceId: string
  cancelRenameWorkspace: () => void
  canDelete: boolean
  closeWorkspaceMenu: () => void
  displayPath: string
  finishRenameWorkspace: (workspace: Workspace, nextName?: string) => void
  isMenuOpen: boolean
  isRenaming: boolean
  renameDraft: string
  commandContext: ShellCommandContext
  deleteWorkspace: (workspace: Workspace) => void
  dispatch: Dispatch<ShellCommand>
  setRenameDraft: (value: string) => void
  startRenameWorkspace: (workspace: Workspace) => void
  submitRenameWorkspace: (event: FormEvent<HTMLFormElement>, workspace: Workspace) => void
  toggleMenu: () => void
}

function SortableWorkspaceButton({
  workspace,
  activeWorkspaceId,
  cancelRenameWorkspace,
  canDelete,
  closeWorkspaceMenu,
  displayPath,
  finishRenameWorkspace,
  isMenuOpen,
  isRenaming,
  renameDraft,
  commandContext,
  deleteWorkspace,
  dispatch,
  setRenameDraft,
  startRenameWorkspace,
  submitRenameWorkspace,
  toggleMenu,
}: SortableWorkspaceButtonProps): React.JSX.Element {
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: workspace.id,
    data: {
      type: "workspace",
      workspaceId: workspace.id,
    } satisfies WorkspaceDragData,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  useEffect(() => {
    if (!isRenaming) {
      return
    }

    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [isRenaming])

  return (
    <div
      className={`workspace-row ${workspace.id === activeWorkspaceId ? "is-active" : ""} ${
        isDragging ? "is-dragging" : ""
      }`}
      ref={setNodeRef}
      style={style}
      title={`${workspace.name}\n${displayPath}`}
    >
      {isRenaming ? (
        <form
          className="workspace-rename-form"
          onPointerDown={(event) => event.stopPropagation()}
          onSubmit={(event) => submitRenameWorkspace(event, workspace)}
        >
          <input
            aria-label={`Rename ${workspace.name}`}
            className="workspace-rename-input"
            onChange={(event) => setRenameDraft(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                cancelRenameWorkspace()
                return
              }

              if (event.key === "Enter") {
                event.preventDefault()
                finishRenameWorkspace(workspace, event.currentTarget.value)
              }
            }}
            ref={renameInputRef}
            value={renameDraft}
          />
        </form>
      ) : (
        <button
          {...attributes}
          {...listeners}
          className="workspace-button"
          onClick={() => {
            closeWorkspaceMenu()
            dispatch({ ...commandContext, type: "workspace.select", workspaceId: workspace.id })
          }}
          type="button"
        >
          <span className="workspace-label">
            <span className="workspace-name">{workspace.name}</span>
            <span className="workspace-directory">{displayPath}</span>
          </span>
        </button>
      )}
      <button
        aria-label={`Workspace actions for ${workspace.name}`}
        className={`workspace-menu-trigger ${isMenuOpen ? "is-open" : ""}`}
        onClick={(event) => {
          event.stopPropagation()
          toggleMenu()
        }}
        onPointerDown={(event) => event.stopPropagation()}
        title="Workspace actions"
        type="button"
      >
        <MoreHorizontal size={15} />
      </button>
      {isMenuOpen ? (
        <div
          className="workspace-menu"
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
        >
          <button
            onClick={() => {
              startRenameWorkspace(workspace)
            }}
            type="button"
          >
            Rename
          </button>
          <button
            className="is-danger"
            disabled={!canDelete}
            onClick={() => {
              deleteWorkspace(workspace)
            }}
            type="button"
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  )
}

type LayoutViewProps = {
  node: LayoutNode
  actorMarksByTabId: ActorTabMarksByTabId
  viewState: WorkspaceViewState
  focusedPaneId: string | null
  splitPreview: SplitPreview | null
  tabDropTarget: TabDropTarget | null
  draggingTabId: string | null
  runtimeApi: AppShellApi
  workspace: Workspace
  commandContext: ShellCommandContext
  dispatch: Dispatch<ShellCommand>
}

function LayoutView({
  node,
  actorMarksByTabId,
  viewState,
  focusedPaneId,
  splitPreview,
  tabDropTarget,
  draggingTabId,
  runtimeApi,
  workspace,
  commandContext,
  dispatch,
}: LayoutViewProps): React.JSX.Element {
  if (node.kind === "pane") {
    return (
      <PaneView
        commandContext={commandContext}
        actorMarksByTabId={actorMarksByTabId}
        dispatch={dispatch}
        draggingTabId={draggingTabId}
        focusedPaneId={focusedPaneId}
        pane={node}
        runtimeApi={runtimeApi}
        splitPreview={splitPreview}
        tabDropTarget={tabDropTarget}
        viewState={viewState}
        workspace={workspace}
      />
    )
  }

  return (
    <Group className="panel-group" id={node.id} orientation={node.direction}>
      {node.children.map((child, index) => (
        <Fragment key={child.id}>
          <Panel defaultSize={100 / node.children.length} minSize={18}>
            <LayoutView
              actorMarksByTabId={actorMarksByTabId}
              commandContext={commandContext}
              dispatch={dispatch}
              draggingTabId={draggingTabId}
              focusedPaneId={focusedPaneId}
              node={child}
              runtimeApi={runtimeApi}
              splitPreview={splitPreview}
              tabDropTarget={tabDropTarget}
              workspace={workspace}
              viewState={viewState}
            />
          </Panel>
          {index < node.children.length - 1 ? (
            <Separator className={`resize-handle resize-handle-${node.direction}`}>
              <span />
            </Separator>
          ) : null}
        </Fragment>
      ))}
    </Group>
  )
}

type PaneViewProps = {
  pane: PaneNode
  actorMarksByTabId: ActorTabMarksByTabId
  viewState: WorkspaceViewState
  focusedPaneId: string | null
  splitPreview: SplitPreview | null
  tabDropTarget: TabDropTarget | null
  draggingTabId: string | null
  runtimeApi: AppShellApi
  workspace: Workspace
  commandContext: ShellCommandContext
  dispatch: Dispatch<ShellCommand>
}

function PaneView({
  pane,
  actorMarksByTabId,
  viewState,
  focusedPaneId,
  splitPreview,
  tabDropTarget,
  draggingTabId,
  runtimeApi,
  workspace,
  commandContext,
  dispatch,
}: PaneViewProps): React.JSX.Element {
  const { setNodeRef } = useDroppable({
    id: pane.id,
    data: {
      type: "pane",
      paneId: pane.id,
    } satisfies PaneDropData,
  })
  const activeTabId = getActiveTabId(pane, viewState)
  const activeTab = pane.tabs.find((tab) => tab.id === activeTabId) ?? null
  const paneTabDropTarget =
    draggingTabId && tabDropTarget?.paneId === pane.id ? tabDropTarget : null

  function focusPane(): void {
    dispatch({ ...commandContext, type: "view.focusPane", paneId: pane.id })
  }

  return (
    <section
      className={`pane ${focusedPaneId === pane.id ? "is-focused" : ""}`}
      data-pane-id={pane.id}
      onPointerDown={focusPane}
      ref={setNodeRef}
    >
      <div className="tab-strip">
        <div className="tab-list" role="tablist">
          <SortableContext
            items={pane.tabs.map((tab) => tab.id)}
            strategy={horizontalListSortingStrategy}
          >
            <TabListItems
              commandContext={commandContext}
              dispatch={dispatch}
              draggingTabId={draggingTabId}
              paneId={pane.id}
              tabs={pane.tabs}
              activeTabId={activeTab?.id ?? null}
              actorMarksByTabId={actorMarksByTabId}
              tabDropTarget={paneTabDropTarget}
            />
          </SortableContext>
        </div>
        <button
          aria-label="New tab"
          className="tab-strip-button"
          onClick={(event) => {
            event.stopPropagation()
            dispatch({ ...commandContext, type: "tab.create", paneId: pane.id })
          }}
          title="New tab"
          type="button"
        >
          <Plus size={15} />
        </button>
      </div>
      <div className="pane-content">
        {splitPreview?.paneId === pane.id ? <SplitPreviewOverlay edge={splitPreview.edge} /> : null}
        {activeTab ? (
          <TabContent
            commandContext={commandContext}
            dispatch={dispatch}
            paneId={pane.id}
            runtimeApi={runtimeApi}
            tab={activeTab}
            workspace={workspace}
          />
        ) : (
          <div className="empty-pane">
            <Square size={28} />
            <span>No Tabs</span>
          </div>
        )}
      </div>
    </section>
  )
}

const splitEdgeConfig: Record<SplitEdge, { direction: SplitDirection; placement: SplitPlacement }> =
  {
    left: { direction: "horizontal", placement: "before" },
    right: { direction: "horizontal", placement: "after" },
    top: { direction: "vertical", placement: "before" },
    bottom: { direction: "vertical", placement: "after" },
  }

function SplitPreviewOverlay({ edge }: { edge: SplitEdge }): React.JSX.Element {
  return <div aria-hidden="true" className={`split-preview split-preview-${edge}`} />
}

type TabListItemsProps = {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  actorMarksByTabId: ActorTabMarksByTabId
  paneId: string
  tabDropTarget: TabDropTarget | null
  draggingTabId: string | null
  commandContext: ShellCommandContext
  dispatch: Dispatch<ShellCommand>
}

function TabListItems({
  tabs,
  activeTabId,
  actorMarksByTabId,
  paneId,
  tabDropTarget,
  draggingTabId,
  commandContext,
  dispatch,
}: TabListItemsProps): React.JSX.Element {
  const items: React.JSX.Element[] = []
  let visibleIndex = 0

  for (const tab of tabs) {
    if (tabDropTarget && !tabDropTarget.isNoop && tabDropTarget.index === visibleIndex) {
      items.push(<TabDropPlaceholder key={`drop-${paneId}-${visibleIndex}`} />)
    }

    items.push(
      <SortableTab
        commandContext={commandContext}
        dispatch={dispatch}
        isActive={tab.id === activeTabId}
        actorMarks={actorMarksByTabId[tab.id] ?? []}
        key={tab.id}
        paneId={paneId}
        suppressSortTransform={tabDropTarget !== null}
        tab={tab}
      />,
    )

    if (tab.id !== draggingTabId) {
      visibleIndex += 1
    }
  }

  if (tabDropTarget && !tabDropTarget.isNoop && tabDropTarget.index === visibleIndex) {
    items.push(<TabDropPlaceholder key={`drop-${paneId}-${visibleIndex}`} />)
  }

  return <>{items}</>
}

function TabDropPlaceholder(): React.JSX.Element {
  return <div aria-hidden="true" className="tab-drop-placeholder" />
}

type SortableTabProps = {
  tab: WorkspaceTab
  paneId: string
  isActive: boolean
  actorMarks: ActorTabMark[]
  suppressSortTransform: boolean
  commandContext: ShellCommandContext
  dispatch: Dispatch<ShellCommand>
}

function SortableTab({
  tab,
  paneId,
  isActive,
  actorMarks,
  suppressSortTransform,
  commandContext,
  dispatch,
}: SortableTabProps): React.JSX.Element {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: tab.id,
    data: {
      type: "tab",
      paneId,
      tab,
    } satisfies TabDragData,
  })
  const style: CSSProperties = {
    transform: suppressSortTransform ? undefined : CSS.Transform.toString(transform),
    transition: suppressSortTransform ? undefined : transition,
  }

  return (
    <div
      {...attributes}
      {...listeners}
      aria-selected={isActive}
      className={`tab ${isActive ? "is-active" : ""} ${isDragging ? "is-dragging" : ""}`}
      data-tab-id={tab.id}
      onClick={(event) => {
        event.stopPropagation()
        dispatch({ ...commandContext, type: "tab.activate", paneId, tabId: tab.id })
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          dispatch({ ...commandContext, type: "tab.activate", paneId, tabId: tab.id })
        }
      }}
      ref={setNodeRef}
      role="tab"
      style={style}
      tabIndex={0}
    >
      {actorMarks.length > 0 ? (
        <span className="tab-actor-stack">
          {actorMarks.map((mark) => (
            <span
              className={`tab-actor tab-actor-${mark.kind}`}
              key={mark.actorId}
              style={{ "--actor-color": mark.color } as CSSProperties}
              title={mark.actorName}
            >
              {mark.kind === "user" ? <User size={11} /> : <MousePointer2 size={11} />}
            </span>
          ))}
        </span>
      ) : null}
      <span className="tab-title">{tab.title}</span>
      <button
        aria-label={`Close ${tab.title}`}
        className="tab-close"
        onClick={(event) => {
          event.stopPropagation()
          dispatch({ ...commandContext, type: "tab.close", paneId, tabId: tab.id })
        }}
        onPointerDown={(event) => event.stopPropagation()}
        title="Close tab"
        type="button"
      >
        <X size={13} />
      </button>
      {actorMarks.some((mark) => mark.isActive) ? (
        <span className="tab-actor-underlines" aria-hidden="true">
          {actorMarks
            .filter((mark) => mark.isActive)
            .map((mark) => (
              <span key={mark.actorId} style={{ "--actor-color": mark.color } as CSSProperties} />
            ))}
        </span>
      ) : null}
    </div>
  )
}

type TabContentProps = {
  tab: WorkspaceTab
  workspace: Workspace
  paneId: string
  runtimeApi: AppShellApi
  commandContext: ShellCommandContext
  dispatch: Dispatch<ShellCommand>
}

function TabContent({
  tab,
  workspace,
  paneId,
  runtimeApi,
  commandContext,
  dispatch,
}: TabContentProps): React.JSX.Element {
  if (tab.typeId === EMPTY_TAB_TYPE_ID) {
    return (
      <EmptyTabChooser
        commandContext={commandContext}
        dispatch={dispatch}
        paneId={paneId}
        tab={tab}
      />
    )
  }

  const tabType = tabRegistry.getTabType(tab.typeId)

  if (!tabType) {
    return (
      <div className="empty-tab-view">
        <div className="empty-tab-mark">
          <Square size={34} />
        </div>
        <div className="empty-tab-copy">
          <h1>Missing tab type</h1>
          <p>{tab.typeId}</p>
        </div>
      </div>
    )
  }

  const TabComponent = tabType.render

  return (
    <TabComponent
      key={`${tab.id}-${tab.typeId}`}
      api={runtimeApi}
      commandContext={commandContext}
      dispatch={dispatch}
      paneId={paneId}
      tab={tab}
      workspace={workspace}
    />
  )
}

type EmptyTabChooserProps = {
  tab: WorkspaceTab
  paneId: string
  commandContext: ShellCommandContext
  dispatch: Dispatch<ShellCommand>
}

function EmptyTabChooser({
  tab,
  paneId,
  commandContext,
  dispatch,
}: EmptyTabChooserProps): React.JSX.Element {
  return (
    <div className="empty-tab-view">
      <div className="empty-tab-mark is-brand">
        <img alt="" className="empty-tab-logo" src={ensembleLogoUrl} />
      </div>
      <div className="empty-tab-copy">
        <h1>{tab.title}</h1>
        <p>Choose a tab type</p>
      </div>
      <div className="tab-type-picker">
        {tabRegistry.extensions.map((extension) => (
          <section key={extension.id}>
            <h2>{extension.title}</h2>
            <div className="tab-type-list">
              {extension.tabs.map((tabType) => (
                <button
                  key={tabType.id}
                  onClick={() =>
                    dispatch({
                      ...commandContext,
                      type: "tab.setType",
                      paneId,
                      tabId: tab.id,
                      tabTypeId: tabType.id,
                      title: tabType.title,
                      state: tabType.state ?? {},
                    })
                  }
                  type="button"
                >
                  <strong>{tabType.title}</strong>
                  <span>{tabType.description}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function TabDragPreview({ tab }: { tab: WorkspaceTab }): React.JSX.Element {
  return (
    <div className="tab drag-preview">
      <span className="tab-title">{tab.title}</span>
    </div>
  )
}
