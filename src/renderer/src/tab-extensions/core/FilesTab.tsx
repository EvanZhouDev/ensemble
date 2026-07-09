import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import { EditorState, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { basicSetup } from "codemirror"
import {
  ChevronRight,
  FileBraces,
  FileCode,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  NotebookText,
  Search,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { type NodeRendererProps, Tree } from "react-arborist"
import type { TabRenderContext } from "../../tab-sdk"

const FILE_PREVIEW_TAB_TYPE_ID = "core.filePreview"

type FileTreeTabState = {
  selectedPath?: string
}

type FilePreviewTabState = {
  path?: string
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

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [size, setSize] = useState({ width: 280, height: 420 })

  useEffect(() => {
    const element = ref.current

    if (!element) {
      return
    }

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) {
        return
      }

      setSize({
        width: Math.max(180, entry.contentRect.width),
        height: Math.max(180, entry.contentRect.height),
      })
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return [ref, size] as const
}

function languageExtensionsForPath(path: string): Extension[] {
  const lowerPath = path.toLowerCase()

  if (/\.(tsx)$/.test(lowerPath)) {
    return [javascript({ jsx: true, typescript: true })]
  }

  if (/\.(ts|mts|cts)$/.test(lowerPath)) {
    return [javascript({ typescript: true })]
  }

  if (/\.(jsx)$/.test(lowerPath)) {
    return [javascript({ jsx: true })]
  }

  if (/\.(js|mjs|cjs)$/.test(lowerPath)) {
    return [javascript()]
  }

  if (/\.jsonc?$/.test(lowerPath)) {
    return [json()]
  }

  if (/\.(md|markdown)$/.test(lowerPath)) {
    return [markdown()]
  }

  if (/\.css$/.test(lowerPath)) {
    return [css()]
  }

  if (/\.(html|htm)$/.test(lowerPath)) {
    return [html()]
  }

  if (/\.py$/.test(lowerPath)) {
    return [python()]
  }

  return []
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path
}

function openPreviewTab(context: TabRenderContext, path: string): void {
  context.dispatch({
    ...context.commandContext,
    type: "tab.open",
    paneId: context.paneId,
    tabTypeId: FILE_PREVIEW_TAB_TYPE_ID,
    title: fileNameFromPath(path),
    state: { path },
  })
}

function CodeViewer({ path, value }: { path: string; value: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const initialValueRef = useRef(value)

  useEffect(() => {
    const host = hostRef.current

    if (!host) {
      return
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          basicSetup,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          ...languageExtensionsForPath(path),
          EditorView.theme({
            "&": {
              height: "100%",
              backgroundColor: "#111215",
              color: "#d7dbe3",
              fontSize: "12px",
            },
            ".cm-content": {
              caretColor: "#f4f5f7",
              fontFamily: '"SFMono-Regular", Consolas, monospace',
              padding: "10px 0",
            },
            ".cm-gutters": {
              backgroundColor: "#111215",
              borderRight: "1px solid #25272e",
              color: "#626873",
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: "#191b20",
            },
            ".cm-selectionBackground": {
              backgroundColor: "#315f9f !important",
            },
            ".cm-scroller": {
              fontFamily: '"SFMono-Regular", Consolas, monospace',
            },
          }),
        ],
      }),
    })

    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [path])

  useEffect(() => {
    const view = viewRef.current

    if (!view) {
      return
    }

    const currentValue = view.state.doc.toString()

    if (currentValue === value) {
      return
    }

    view.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: value,
      },
    })
  }, [value])

  return <div className="code-editor-host" ref={hostRef} />
}

function FileTypeIcon({ path }: { path: string }): React.JSX.Element {
  const lowerPath = path.toLowerCase()

  if (/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py|html|htm|css)$/.test(lowerPath)) {
    return <FileCode className="file-node-icon is-code" size={15} />
  }

  if (/\.jsonc?$/.test(lowerPath)) {
    return <FileBraces className="file-node-icon is-data" size={15} />
  }

  if (/\.(md|markdown)$/.test(lowerPath)) {
    return <NotebookText className="file-node-icon is-doc" size={15} />
  }

  if (/\.(txt|log|gitignore|env|toml|yaml|yml)$/.test(lowerPath)) {
    return <FileType className="file-node-icon is-text" size={15} />
  }

  return <FileText className="file-node-icon" size={15} />
}

function FileNode({ dragHandle, node, style }: NodeRendererProps<FileTreeNode>): React.JSX.Element {
  const entry = node.data
  const isDirectory = entry.type === "directory"

  return (
    <div
      className={[
        "file-node",
        node.isSelected ? "is-selected" : "",
        node.isFocused ? "is-focused" : "",
      ].join(" ")}
      ref={dragHandle}
      style={style}
      title={entry.path || entry.name}
    >
      <button
        aria-label={node.isOpen ? "Collapse folder" : "Expand folder"}
        className="file-node-disclosure"
        disabled={!isDirectory}
        onClick={(event) => {
          event.stopPropagation()
          node.toggle()
        }}
        type="button"
      >
        {isDirectory ? <ChevronRight className={node.isOpen ? "is-open" : ""} size={13} /> : null}
      </button>
      {isDirectory ? (
        node.isOpen ? (
          <FolderOpen className="file-node-icon is-folder" size={15} />
        ) : (
          <Folder className="file-node-icon is-folder" size={15} />
        )
      ) : (
        <FileTypeIcon path={entry.path} />
      )}
      <span>{entry.name}</span>
    </div>
  )
}

export function FileTreeTab(context: TabRenderContext): React.JSX.Element {
  const tabState = context.tab.state as FileTreeTabState
  const [treeData, setTreeData] = useState<FileTreeNode[]>([])
  const [selectedPath, setSelectedPath] = useState(tabState.selectedPath ?? "")
  const [searchTerm, setSearchTerm] = useState("")
  const [isLoadingTree, setIsLoadingTree] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [treeRef, treeSize] = useElementSize<HTMLDivElement>()

  const loadTree = useCallback(async (): Promise<void> => {
    setIsLoadingTree(true)
    setError(null)

    try {
      const result = await context.api.files.tree({
        workspaceDirectory: context.workspace.directory,
      })
      setTreeData(result.entries)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to load file tree.")
    } finally {
      setIsLoadingTree(false)
    }
  }, [context.api.files, context.workspace.directory])

  function openFile(path: string): void {
    setSelectedPath(path)
    updateTabState(context, { selectedPath: path })
    openPreviewTab(context, path)
  }

  useEffect(() => {
    void loadTree()
  }, [loadTree])

  return (
    <div className="tab-surface files-tab file-tree-tab">
      <header className="files-toolbar">
        <div className="files-search">
          <Search size={14} />
          <input
            aria-label="Search files"
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search files"
            value={searchTerm}
          />
        </div>
      </header>
      <section className="file-tree-panel">
        <div className="file-tree-shell" ref={treeRef}>
          {isLoadingTree && treeData.length === 0 ? (
            <p className="muted-copy">Loading files.</p>
          ) : treeData.length === 0 ? (
            <p className="muted-copy">No files in this workspace.</p>
          ) : (
            <Tree<FileTreeNode>
              data={treeData}
              disableDrag
              disableMultiSelection
              height={treeSize.height}
              idAccessor="id"
              indent={14}
              onActivate={(node) => {
                if (node.data.type === "directory") {
                  node.toggle()
                  return
                }

                openFile(node.data.path)
              }}
              openByDefault
              rowHeight={24}
              searchMatch={(node, term) =>
                node.data.name.toLowerCase().includes(term.toLowerCase()) ||
                node.data.path.toLowerCase().includes(term.toLowerCase())
              }
              searchTerm={searchTerm}
              selection={selectedPath}
              width={treeSize.width}
            >
              {FileNode}
            </Tree>
          )}
        </div>
      </section>
      {error ? <p className="inline-error file-tree-error">{error}</p> : null}
    </div>
  )
}

export function FilePreviewTab(context: TabRenderContext): React.JSX.Element {
  const tabState = context.tab.state as FilePreviewTabState
  const path = tabState.path ?? ""
  const [file, setFile] = useState<FileReadResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadFile = useCallback(async (): Promise<void> => {
    if (!path) {
      setFile(null)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const result = await context.api.files.read({
        workspaceDirectory: context.workspace.directory,
        path,
      })
      setFile(result)
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to read file.")
    } finally {
      setIsLoading(false)
    }
  }, [context.api.files, context.workspace.directory, path])

  useEffect(() => {
    void loadFile()
  }, [loadFile])

  return (
    <div className="tab-surface file-preview-tab">
      {file ? (
        <>
          <div className="file-editor-header">
            <div>
              <h2>{file.path}</h2>
              <span>
                {formatBytes(file.size)} · {new Date(file.modifiedAt).toLocaleString()}
              </span>
            </div>
          </div>
          <CodeViewer key={file.path} path={file.path} value={file.content} />
        </>
      ) : (
        <div className="empty-file-state">
          <FileText size={20} />
          <span>{isLoading ? "Opening file..." : "Open a file from File Tree."}</span>
        </div>
      )}
      {error ? <p className="inline-error file-preview-error">{error}</p> : null}
    </div>
  )
}
