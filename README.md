# effect-godot (monorepo)

Bun workspace monorepo.

```
packages/
  effect-godot/   the library — see packages/effect-godot/README.md
  game/           example Godot project consuming it
  godot-bin/      CLI (`godot-bin`) for fetching/running the pinned GodotJS engine build
```

## Quickstart

```sh
bun install
bun run --cwd packages/game godot:fetch   # downloads the GodotJS engine build pinned in packages/game/godot.config.json
bun run --cwd packages/game build         # bundles packages/game/src/**/*.ts to CJS via rolldown
bun run --cwd packages/game edit          # opens the project in the Godot editor
```
