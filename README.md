# MixCode Pi (`mpi`)

[中文文档](README.zh.md)

MixCode runs the [Pi fork](vendor/pi) as its CLI and interactive host. This repository owns the single-binary build, installer, and 19 built-in extensions in [`pi-packages/`](pi-packages/). The fork revision is pinned by the Git submodule; this repository no longer carries a second host implementation or Pi package patches.

## Highlights

- **One installed executable.** `install.sh` places one executable (named `mpi` by default) in the selected `bin/` directory; Bun and Node/npm are build dependencies, not runtime requirements.
- **Fork-native multi-tab workspace.** Tabs, sessions, themes, and batch execution run in the pinned fork rather than a separate UI.
- **Built-in extensions.** The executable embeds 19 `mpi-*` packages, their skills, and the fork's runtime documentation, examples, and assets.
- **Nested tool transcript.** `/transcript chatlog` shows recorded calls made inside `codemode` and other tools. [Details](pi-packages/mpi-transcript/README.md#nested-tool-calls).
- **Loop protection.** Normal read pagination stays quiet; repeated call sequences receive advisory reminders. [Details](pi-packages/mpi-stuck-guard/README.md#doom-loop).
- **Assistant response timing.** The footer shows elapsed run time and a live average generation time per assistant message in the current run. [Details](pi-packages/mpi-working-timer/README.md).

## Install

From this checkout, including its `vendor/pi` submodule:

```sh
git submodule update --init vendor/pi
./install.sh
~/.local/bin/mpi
```

Use `./install.sh --prefix /your/prefix` to install to `/your/prefix/bin/mpi`. Pass `--name custom-mpi` to install to `/your/prefix/bin/custom-mpi` instead; only the filename changes, not the app identity. The installer needs Bun, Node.js >= 22.19, and npm. Each fork build needs network access to refresh the model catalog; a failed refresh stops the build. The installed executable does not need the checkout or adjacent asset files. On Linux, runtime assets are extracted to `$XDG_CACHE_HOME/mpi/tmp/mixcode-pi-*` (default `~/.cache/mpi/tmp/mixcode-pi-*`; relative cache paths are ignored), and the per-launch directory is removed on normal exit. macOS and Windows keep their OS temporary directories. Built-in extensions and fork-specific docs persist in `extensions/` and `mixcode-docs/` under the Pi agent directory (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`); coding-agent docs and examples are unpacked only into the per-launch runtime directory.

## Development

```sh
git submodule update --init vendor/pi
./run.sh
```

`run.sh` builds the fork and recompiles the local binary when inputs change. Development runs and the installer reuse fork dependencies only while the lockfile checksum matches their last successful install. `bun run check` builds, typechecks, lints, and runs extension tests. `release.sh` builds platform-specific single-file executables. To advance Pi, update the fork repository and then the pinned submodule commit here; do not patch registry packages in this repository.

## Features And References

- [Fork features and commands](vendor/pi/docs/README.md) describe the actual host behavior.
- [Built-in extensions](pi-packages/) each carry their own package manifest and, where applicable, README and skill instructions.

The source build and removed implementation remain available in the `master` branch's Git history, not in this branch's runtime tree.
