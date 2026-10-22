# Cloître

A desktop terminal that runs only Claude Code. One project per folder, several tabs per project, each tab starts in the project's folder.

Stack: Tauri v2, TypeScript and xterm.js in the webview, Rust for the pseudo-terminal layer only. Windows first, macOS next.

## Where things stand

Early stage. The work is tracked in GitHub issues, milestone POC. Start with issue #1 (rendering spike): its verdict can change the later issues.

## Architecture rules

- **Rust stays thin.** It spawns `claude` in a folder, reads, writes, resizes and stops the session (plus the raw-byte recording during the spike). It also owns the project list and opens the folder picker itself, so the folders `claude` may run in never come from the webview. Everything else is TypeScript in the webview.
- **The webview can run nothing but `claude`, in a validated project folder.**
  - Rust builds the command line itself from a closed choice: New session, or Resume with a session id. The webview never passes raw arguments, otherwise `--dangerously-skip-permissions`, `--mcp-config` or `-p` would get through.
  - Rust validates the folder: canonical path, compared with the registered projects. A check made by the webview protects nothing.
  - The app's own Rust commands are declared in the app manifest and allowed through a capability. In Tauri v2 a command registered in `invoke_handler` is otherwise callable by every window. Check this against the Tauri documentation when implementing issue #2.
  - Never add a shell permission or a generic "run a command" permission.
- **The Rust/TypeScript contract is written down** in `docs/ARCHITECTURE.md`: one entry per Rust command (name, arguments, what it returns, what it refuses). Create the file with the first Rust command and update it with every change.
- **Windows first, macOS possible.** Any Windows-specific code goes in a clearly named module.
- **Tabs are restored, their `claude` processes are not.** On reopening, each tab offers Resume (reopens the previous Claude Code conversation) or New session. See issue #5.

## Quality

- Every Rust function has a doc comment saying what it does and what its caller must know.
- No Rust code without a test. `cargo clippy --all-targets -- -D warnings` and `cargo test` pass before a pull request.
- Every named TypeScript function, method and class has a JSDoc comment (enforced by ESLint). `pnpm lint`, `pnpm typecheck` and `pnpm test` pass before a pull request.
- A bug starts with the test that reproduces it.

## Public repository

- Nothing personal in the repo, the issues or the pull requests: no local paths, no personal project names, no references to private tools, no tokens. Example data uses generic names.
- Work on a branch and open a pull request. Do not push to `main`.

## Out of scope until after the POC

Plugin system, running a regular shell, SSH, tab notifications, pasted images and file drag and drop. The last two are planned for V1.

## Commands

From the repository root:

- `pnpm install`
- `pnpm tauri dev`: run the app
- `pnpm lint`, `pnpm typecheck`, `pnpm test`
- `pnpm tauri build --debug`

From `src-tauri`:

- `cargo clippy --all-targets -- -D warnings`
- `cargo test`
