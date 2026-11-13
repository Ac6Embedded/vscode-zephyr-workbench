# GitHub Actions workflows

Quick reference for what runs when. The full release procedure (store setup,
secrets, versioning rules) is documented in [RELEASING.md](../../RELEASING.md).

## ci.yml (CI)

Runs on every push and pull request to `main` and `pre-release` (and manually
via *Run workflow*):

1. `npm ci`
2. `npm run lint` (ESLint over `src`)
3. `npm run package` (TypeScript typecheck + esbuild production bundle)
4. `npm run test:unit` (mocha unit tests)
5. `vsce package`, then uploads the VSIX as a downloadable artifact
   (7-day retention) so every run yields an installable build.

## release.yml (Release)

Runs when a version tag `vX.Y.Z` is pushed. The tag must match the `version`
in `package.json`, otherwise the workflow fails immediately.

The MINOR version number selects the channel (the Marketplace rejects semver
suffixes like `-beta.1`, so the odd/even convention is used instead):

| Tag        | Minor | Channel                                        |
| ---------- | ----- | ---------------------------------------------- |
| `v3.3.x`   | odd   | pre-release (Marketplace pre-release badge, GitHub "Pre-release", Open VSX pre-release) |
| `v3.4.x`   | even  | stable release on all channels                 |

Steps: package the VSIX, create a GitHub Release with the VSIX attached, then
publish that same VSIX to the VS Code Marketplace and Open VSX. The two store
publishes are isolated: if one fails the other still runs, and the GitHub
Release is kept either way.

Required repository secrets:

- `VSCE_PAT`: Azure DevOps personal access token (Marketplace > Manage scope)
- `OVSX_PAT`: open-vsx.org access token

## dependabot.yml (in `.github/`)

Weekly npm and github-actions update PRs. Minor/patch npm updates are grouped
into one PR; majors arrive individually. Only read from the default branch.
