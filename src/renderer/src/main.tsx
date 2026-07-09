import { createRoot, type Root } from "react-dom/client"
import { App } from "./App"

declare global {
  interface Window {
    workspaceShellRoot?: Root
  }
}

const rootElement = document.getElementById("root")

if (!rootElement) {
  throw new Error("Missing root element")
}

window.workspaceShellRoot ??= createRoot(rootElement)
window.workspaceShellRoot.render(<App />)
