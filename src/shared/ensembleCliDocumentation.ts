export function createEnsembleCliUsage(command = "ensemble"): string {
  return `Ensemble CLI

Command summary:
  ${command} status [--json]
    Show the current implicit actor/view, active workspace, panes, tabs, and active tab markers.
  ${command} state --json
    Print the full Core state. Use only when status/list output is not enough.
  ${command} actor list [--json]
    List actors. Chat-launched commands already inherit an actor; do not create one by default.
  ${command} actor create [name] [--workspace <workspace-id>]
    Create a separate actor/view only when the user explicitly asks for another actor.
  ${command} actor activate <actor-id-or-name>
    Make an actor/view visible to the user. Avoid this unless the user asks.
  ${command} workspace list [--json]
    List workspaces and directories.
  ${command} workspace create [directory] [--name Name]
    Create a workspace rooted at a directory.
  ${command} workspace select <workspace-id-or-name>
    Select the active workspace for the inherited actor/view.
  ${command} pane list [--json]
    List pane ids in visual order. Selectors: focused, active, first, or a pane id.
  ${command} tab list [--json]
    List tabs with paneId, typeId, title, id, and state.
  ${command} tab new [--pane focused|first|<pane-id>]
    Add an empty shell tab to a pane.
  ${command} tab open <type-id> [--pane <pane-id>] [--title Title] [--state '{"url":"https://example.com"}']
    Open a typed tab. Useful type ids: ai-agent.chat, ai-agent.review, core.browser, core.terminal, core.files, core.filePreview.
    Browser URL example: ${command} tab open core.browser --title Apple --state '{"url":"https://www.apple.com"}'
  ${command} tab activate [tab-id|title] [--pane <pane-id>]
    Focus a tab.
  ${command} tab close [tab-id|title] [--pane <pane-id>]
    Close a tab. If it is the last tab in a split pane, the pane collapses.
  ${command} tab move <tab-id> --to-pane <pane-id> [--from-pane <pane-id>] [--index 0]
    Move a tab into an existing tab strip. Use this for tab-bar insertion, not pane splitting.
  ${command} tab split <tab-id> --target-pane <pane-id> --direction horizontal|vertical --placement before|after
    Move an existing tab into a new pane adjacent to target-pane. It never creates empty panes.
    Requires the source pane to still contain another tab if source and target are the same pane.
  ${command} agent ask <chat-tab-id-or-title> <prompt...> [--pane <pane-id>] [--base-url <url>] [--model <name>]
    Start a turn in an ai-agent.chat tab. Defaults match the Chat tab: http://127.0.0.1:10531/v1 and gpt-5.5.
  ${command} browser run [tab-id-or-title] <javascript> [--pane <pane-id>] [--timeout-ms 10000]
    Execute JavaScript inside a core.browser tab and print { tabId, url, result } as JSON.
    If no tab is given, the focused pane's active tab must be a browser tab.
    When an AI actor runs this, the target Browser tab becomes controlled by that actor.
  ${command} terminal run <command> --tab <terminal-tab-id-or-title> [--pane <pane-id>] [--no-enter]
    Type a command into a core.terminal tab, press Enter by default, and print { tabId, sessionId, command, cwd } as JSON.
    When an AI actor runs this, the target Terminal tab becomes controlled by that actor.

Global flags:
  --actor <actor-id-or-name>
  --view <view-id>
  --url <control-url>
  --control-file <path>
  --json

Environment:
  ENSEMBLE_ACTOR and ENSEMBLE_VIEW select the implicit actor/view for commands.
  AI chat-launched commands inherit these automatically.

Split semantics:
  horizontal = left/right split row. placement before puts the moved tab on the left; after puts it on the right.
  vertical = top/bottom split column. placement before puts the moved tab above; after puts it below.

Layout strategy:
  Use titles for tabs you just created, and use focused/first pane selectors to avoid unnecessary state reads.
  Tab selectors can be tab ids or exact titles. If a title is duplicated, pass --pane focused|first|<pane-id>.
  Run pane list --json or tab list --json only when generated ids are needed or a title is ambiguous.

Case study: terminal bottom, top row split between current Chat and Apple browser, then ask Chat for a joke.
  Starting assumption: the current/focused pane already contains the controlling Chat tab.
  Minimum command sequence:
    ${command} tab open core.terminal --title Terminal
    ${command} tab open core.browser --title Apple --state '{"url":"https://www.apple.com"}'
    ${command} tab split Terminal --from-pane focused --target-pane focused --direction vertical --placement after
    ${command} tab split Apple --from-pane first --target-pane first --direction horizontal --placement after
    ${command} agent ask Chat --pane first "tell me a joke"
    ${command} terminal run "pwd" --tab Terminal

  Same sequence as one shell block:
    ${command} tab open core.terminal --title Terminal && ${command} tab open core.browser --title Apple --state '{"url":"https://www.apple.com"}' && ${command} tab split Terminal --from-pane focused --target-pane focused --direction vertical --placement after && ${command} tab split Apple --from-pane first --target-pane first --direction horizontal --placement after && ${command} agent ask Chat --pane first "tell me a joke" && ${command} terminal run "pwd" --tab Terminal

  If there is not already a Chat tab in the current pane, first run:
    ${command} tab open ai-agent.chat --title Chat`
}

export function createAgentEnsembleCliInstructions(input: {
  command: string
  fallbackCommand: string
}): string {
  return `Ensemble app control:

You can manipulate the Ensemble shell with the local CLI. Prefer this exact command form from any workspace directory:

  ${input.command} <command>

If ENSEMBLE_CLI is unavailable, use this executable directly:

  ${input.fallbackCommand} <command>

Rules:
- The CLI controls Ensemble's shared Core state: actors, views, workspaces, panes, and tabs.
- Discover commands with ${input.command} --help, not by reading CLI source files.
- Your actor and view are already selected through ENSEMBLE_ACTOR and ENSEMBLE_VIEW. Do not create, activate, or pass --actor for a separate agent actor unless the user explicitly asks to manage actors.
- For app-control requests, use the minimum CLI sequence from the command manual below. Do not inspect implementation files to infer commands.
- For browser-control requests inside Ensemble, use the Ensemble CLI only. Do not use Computer Use, the bundled browser MCP/plugin, node_repl, or any external browser automation surface to control Ensemble browser tabs.
- For layout requests, prefer stable titles for tabs you create and pane selectors like focused and first. Use JSON list commands only when selectors are ambiguous.
- Use --json when you need stable machine-readable state.
- A tab split moves an existing tab into a new pane; it does not create an empty pane.
- Splitting the only tab in its own pane is invalid.
- Closing the last tab in a pane collapses that pane when another pane exists.
- Current tab type ids include shell.empty, ai-agent.chat, ai-agent.review, core.browser, core.terminal, core.files, and core.filePreview.
- Browser tabs can be automated with ${input.command} browser run. Use JavaScript for navigation, DOM reads, clicks, typing, and form submission.
- Browser run examples: ${input.command} browser run Browser 'document.title'; ${input.command} browser run Browser 'location.href = "https://example.com"; true'; ${input.command} browser run Browser 'document.querySelector("button")?.click(); true'.
- Terminal tabs can be automated with ${input.command} terminal run. It types into the existing visible terminal tab and presses Enter by default.
- Browser and terminal automation claim the target tab for your actor. After you use one, that tab is marked as yours and your active underline moves there.

Typical commands:
  ${input.command} --help
  ${input.command} status
  ${input.command} tab list --json
  ${input.command} pane list --json

${createEnsembleCliUsage(input.command)}`
}
