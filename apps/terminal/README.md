# Arcane Terminal

Arcane Terminal is a thin application composition over shared Arcane terminal capabilities.

- `arcane/components/terminal-workspace.html` owns the reusable terminal interaction surface, session tabs, command history, search, and keyboard behavior.
- `arcane/entities/TerminalSession.js` validates the reusable session value object.
- `arcane/modules/TerminalClient.js` adapts the capability-gated native API into domain-neutral session events.
- `arcane/modules/TerminalCommandRegistry.js` provides reusable command routing and completion.
- `apps/terminal/modules/ArcaneTerminalCommands.js` contains the Arcane-specific command catalog.
- `arcane/modules/SystemToolRegistry.js` provides a reusable named-tool contract; `apps/terminal/modules/ArcaneSystemTools.js` registers the workspace's web and native app build/check routes.
- `apps/terminal/modules/TerminalApp.js` composes settings, native sessions, and Arcane commands for this app.

The native application is granted `terminal.execute` explicitly. Other Arcane applications do not receive terminal access by default.

From a checkout-root session, `app package terminal` runs the standard public packaging route and `native-app build terminal portable` runs the machine-bundle target build. `tools` lists every registered route and exact usage. The Startup directory preference can point new sessions at a checkout root automatically.
