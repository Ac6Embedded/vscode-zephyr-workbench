# Vendored west sdk command

This directory holds a minimal, self-contained west manifest package that
exposes the upstream `west sdk` extension command so the extension can install
the Zephyr SDK globally before any west workspace or Zephyr checkout exists.

- `manifest/scripts/west_commands/sdk.py` (verbatim)
- `manifest/scripts/west_commands/zcmake.py` (verbatim)
- `manifest/scripts/west_commands/sdk/listsdk.cmake` (verbatim)

Vendored verbatim from Zephyr v4.4.1 (`scripts/west_commands/`).
`manifest/west.yml` and `manifest/scripts/west-commands.yml` are authored here
(the west-commands entry mirrors the `sdk` entry of Zephyr's
`scripts/west-commands.yml`).

At runtime the extension copies `manifest/` into globalStorage and generates a
`.west/config` next to it, then runs `west sdk install ...` from that
directory (see `src/utils/zephyr/westSdkRunner.ts`).

## Re-vendoring

1. Copy the three files verbatim from the new Zephyr tag.
2. Diff the `sdk` entry of Zephyr's `scripts/west-commands.yml` against ours.
3. Update the tag recorded above.
4. Smoke test: materialize the runner workspace and run `west sdk --help`,
   then a minimal install with one toolchain.
