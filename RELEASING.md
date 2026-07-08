# Releasing Zephyr Workbench

Releases are fully automated by [release.yml](.github/workflows/release.yml):
pushing a version tag builds the VSIX, creates a GitHub Release, and publishes
to the VS Code Marketplace and Open VSX.

## Versioning: stable vs pre-release

The VS Code Marketplace does not accept semver suffixes (`3.3.0-beta.1` is
rejected; versions must be plain `X.Y.Z`), so the channel is encoded in the
minor number, following the official VS Code convention:

- **Odd minor = pre-release**: `v3.3.0`, `v3.3.1`, ...
  Published with the pre-release flag on the Marketplace and Open VSX, and
  marked "Pre-release" on GitHub. Only users who chose *Switch to Pre-Release
  Version* receive it.
- **Even minor = stable**: `v3.4.0`, `v3.4.1`, ...
  Published as a normal release everywhere.

Stable releases must leapfrog pre-release numbers. Example sequence:
`3.2.2` (stable) -> `3.3.0`, `3.3.1` (pre-releases) -> `3.4.0` (stable).

## How to cut a release

1. Update `version` in `package.json` (respect the odd/even rule above) and
   run `npm install` so `package-lock.json` follows.
2. Move the `[Unreleased]` items in `CHANGELOG.md` under a new version heading.
3. Commit, then tag and push (the tag must match `package.json` exactly):

   ```sh
   git tag v3.4.0
   git push origin main v3.4.0
   ```

4. The Release workflow does the rest. Check the run under the *Actions* tab.

The tag can be pushed from any branch; stable tags are expected on `main`,
pre-release tags typically come from the `pre-release` branch. Note that the
workflow file must exist on the tagged commit.

## One-time store setup

Two repository secrets are required (GitHub repo > Settings > Secrets and
variables > Actions):

### `VSCE_PAT` (VS Code Marketplace)

The `Ac6` publisher already exists; this is only about minting a token:

1. Sign in at <https://dev.azure.com> with the Microsoft account that manages
   the `Ac6` publisher (see <https://marketplace.visualstudio.com/manage>).
2. User settings (top right) > Personal Access Tokens > New Token:
   - Organization: **All accessible organizations** (required; a single-org
     token cannot publish to the Marketplace)
   - Expiration: up to 1 year (set a reminder to rotate it)
   - Scopes: Custom defined > **Marketplace > Manage**
3. Verify the token before storing it: `npx vsce verify-pat Ac6`
4. Save it as the `VSCE_PAT` repository secret.

### `OVSX_PAT` (Open VSX)

First-time onboarding, in order:

1. Log in at <https://open-vsx.org> with the GitHub account.
2. Sign the publisher agreement (publishing is blocked until this is done):
   create an Eclipse Foundation account at <https://accounts.eclipse.org>,
   set the GitHub username in the Eclipse profile, then on open-vsx.org go to
   avatar > Settings > Publisher Agreement and sign it.
3. Create a token: avatar > Settings > Access Tokens > Generate New Token
   (shown once; store it safely).
4. Create the namespace matching the `publisher` field in `package.json`:
   `npx ovsx create-namespace Ac6 -p <token>`
5. Save the token as the `OVSX_PAT` repository secret.
6. Optional: claim verified ownership of the namespace by opening an issue at
   <https://github.com/EclipseFdn/open-vsx.org> ("Claim publisher namespace"
   template). Until then the extension shows an "unverified" note, but
   publishing works.

## Troubleshooting

- **Version guard failed**: the tag does not match `package.json`. Delete the
  tag (`git push origin :refs/tags/vX.Y.Z`), fix the version, re-tag.
- **One store failed, the other succeeded**: the GitHub Release is kept; fix
  the token and re-publish manually with the VSIX from the release page:
  `npx vsce publish --packagePath <vsix>` or `npx ovsx publish <vsix>`.
  Add `--pre-release` for odd-minor versions.
- **Marketplace rejects the version**: it was already published once (the
  Marketplace never accepts the same version twice). Bump the patch number
  and release again.
