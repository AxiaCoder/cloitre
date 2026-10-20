# Cloître

A desktop terminal that runs only Claude Code. One project per folder, several tabs per project, each tab starts in the project's folder.

Stack: Tauri v2, TypeScript and xterm.js in the webview, Rust for the pseudo-terminal layer only. Windows first, macOS next.

## Where things stand

Early stage. The work is tracked in GitHub issues, milestone POC. Start with issue #1 (rendering spike): its verdict can change the later issues.

## Architecture rules

- **Rust stays thin.** It spawns `claude` in a folder, reads, writes, resizes and stops the session (plus the raw-byte recording during the spike). Everything else is TypeScript in the webview.
- **The webview can run nothing but `claude`, in a validated project folder.** Tauri permissions are a closed list. Never add a shell permission or a generic "run a command" permission.
- **The Rust/TypeScript contract is written down** in `docs/ARCHITECTURE.md`: one entry per Rust command (name, arguments, what it returns, what it refuses). Create the file with the first Rust command and update it with every change.
- **Windows first, macOS possible.** Any Windows-specific code goes in a clearly named module.
- **Sessions do not survive closing the app.** On reopening, each tab offers Resume or New session.

## Quality

- Every Rust function has a doc comment saying what it does and what its caller must know.
- No Rust code without a test. `cargo clippy` and `cargo test` pass before a pull request.
- A bug starts with the test that reproduces it.

## Public repository

- Nothing personal in the repo, the issues or the pull requests: no local paths, no personal project names, no references to private tools, no tokens. Example data uses generic names.
- Work on a branch and open a pull request. Do not push to `main`.

## Out of scope until after the POC

Plugin system, running a regular shell, SSH, tab notifications, pasted images and file drag and drop. The last two are planned for V1.

## Commands

To be added with the project scaffold.
