# ConPTY

Microsoft's ConPTY release, shipped next to the Windows executable. The ConPTY built into Windows rewrites some of the bytes `claude` writes, which breaks composed emojis; this release passes them through unchanged.

## Provenance

- Package: NuGet `Microsoft.Windows.Console.ConPTY` 1.25.260930003, https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY/1.25.260930003
- File version of both files: `1.25.2609.30003`
- Signed with Authenticode by `CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US`
- Licence: MIT, from `microsoft/terminal` (`LICENSE`)

| File | SHA-256 |
|---|---|
| `conpty.dll` | `feeef341d891643c62d30b6b07800bc70f0bc148f44cb8c3bee84aa557ae805a` |
| `x64/OpenConsole.exe` | `3d66b23d0a71bb8eed2b77edc8b9df9bf54ce6c8fb74c863a30e760997f80586` |

`conpty.dll` starts `x64/OpenConsole.exe` from its own folder, so the layout is the one the NuGet package installs.

## Updating

1. Download the new version of the NuGet package from nuget.org and take `conpty.dll` and `x64/OpenConsole.exe` from the same package: the two files are always replaced together.
2. Replace `LICENSE` if it changed.
3. Update `$ExpectedVersion` and the hashes in `scripts/check-conpty.ps1`, then this file.
4. Run `./scripts/check-conpty.ps1` from the repository root: it must pass.
