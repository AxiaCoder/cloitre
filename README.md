# Cloître

A desktop terminal that runs only [Claude Code](https://claude.com/claude-code). One project per folder, as many tabs as you want per project, and every tab starts in the project's folder.

Built with Tauri, TypeScript and xterm.js. Windows first, macOS next.

**Status:** early stage. Nothing to install yet.

Cloître is an independent project, not affiliated with or endorsed by Anthropic.

## Data folder

Each build keeps its project list, tabs and session ids in its own folder, so a development build can run beside the installed app without touching its data:

| Build | Data folder on Windows |
|---|---|
| Release (installed app) | `%APPDATA%\com.cloitre.desktop` |
| Development (`pnpm tauri dev`, `pnpm tauri build --debug`) | `%APPDATA%\com.cloitre.desktop.dev` |

A development build shows `(dev)` after its window title. Run the executable `pnpm tauri build --debug` leaves in `src-tauri/target/debug`, never its installers: they keep the release identifier, so installing one replaces the installed app.

## License

[MIT](LICENSE)
