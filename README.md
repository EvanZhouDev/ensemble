<img src="assets/ensemble-icon.svg" alt="Ensemble logo" width="72" />

# Ensemble

Ensemble is a prototype desktop superapp for bringing together browser, terminal, and files into one multiplayer app, built for agents and humans alike.

## Features

- Workspace-based shell with split panes and draggable tabs.
- Actor-aware navigation, so humans and agents can maintain separate active tabs.
- Extensible Tab SDK for adding new tab types and tab extensions.
- Built-in Chat, Review, Browser, Terminal, and Files tabs.
- Ensemble CLI for scripting app layout, browser control, terminal commands, and agent workflows.
- Workspace runtime for directory-scoped terminals, file access, agent turns, and review diffs.

## Stack

- Electron, React, and TypeScript.
- Bun for package management and scripts.
- Biome for linting and formatting.
- electron-vite for main, preload, and renderer builds.

## Development

```sh
bun install
bun run dev
```

Useful checks:

```sh
bun run lint
bun run test
bun run build
```
