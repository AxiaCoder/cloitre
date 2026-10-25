# Releasing

Releases are cut by [Release Please](https://github.com/googleapis/release-please) from the commit history of `main`.

## The loop

1. Every pull request title follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat: …`, `fix: …`, `feat!: …`). Pull requests are squash-merged, so the title becomes the commit on `main`. `pr-title.yml` checks it.
2. On each push to `main`, `release.yml` opens or updates a release pull request. It bumps the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`, and writes `CHANGELOG.md`. Before 1.0.0, `feat` bumps the minor version and `fix` the patch version.
3. Merging the release pull request creates the tag `vX.Y.Z` and a **draft** GitHub release. The `build` job then builds the NSIS installer from that tag and attaches it to the draft.
4. Check the draft by hand: download the installer, install it, run it. If it works, publish the release from the GitHub interface.

## The `RELEASE_PLEASE_TOKEN` secret

Release Please uses a personal access token: a pull request opened with the default `GITHUB_TOKEN` would not trigger `checks.yml`.

To create or renew it:

1. GitHub, Settings, Developer settings, Fine-grained tokens, Generate new token.
2. Repository access: this repository only.
3. Permissions: Contents read and write, Pull requests read and write.
4. Set an expiration date and note it: when the token expires, the release workflow fails.
5. Store it in the repository settings, Secrets and variables, Actions, under the name `RELEASE_PLEASE_TOKEN`.

## Adding a GitHub Action

The repository only allows a listed set of actions (Settings, Actions, General). An action added to a workflow must be added to that list too, otherwise the workflow fails.

Every `uses:` is pinned to a full commit SHA, with the version in a comment:

```yaml
- uses: owner/action@<full commit SHA> # vX.Y.Z
```

Resolve the SHA with `gh api repos/<owner>/<action>/git/ref/tags/<tag>`. If the result is a tag object, dereference it with `gh api repos/<owner>/<action>/git/tags/<sha>`.

The pnpm, Node.js and Rust versions are set once, in `.github/actions/setup-toolchain/action.yml`.

## `pnpm bump-version`

Release Please owns the version. `pnpm bump-version <X.Y.Z>` is only for repairs, when the version files disagree.
