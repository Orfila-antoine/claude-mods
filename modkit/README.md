# modkit

A kit for Claude Code mods (terminal): one entry point, an ordered middleware pipeline for messages and events, layers above the prompt, and smooth transitions that do not flicker.

modkit is copied into your plugin, not installed: a plugin may only import its own files, and only plain data crosses between plugins.

```
node modkit/install.mjs <your-plugin-dir>           # copies hooks/modkit/ into it
node modkit/install.mjs <your-plugin-dir> --check   # exit 1 if your copy drifted
```

## Entry point

```tsx
import type { Register } from 'claude-code'
import { defineMods, grid, label } from './modkit'
import type { Mod } from './modkit'

const hello: Mod<{ count: number }> = {
  id: 'hello',
  on: {
    'prompt.submit': [
      async function count(msg, next, { fx }) {
        await fx.setState<{ count: number }>(s => ({ count: (s?.count ?? 0) + 1 }))
        return next()
      },
    ],
  },
  layers: [
    {
      id: 'line', z: 1, rows: 1,
      enter: { kind: 'fade', ms: 300 },
      grid({ columns, rows, state }) {
        const g = grid(columns, rows)
        label(g, 0, 0, `${state?.count ?? 0} prompts`)
        return g
      },
    },
  ],
}

export const register: Register = (on, options) => defineMods(on, options, { plugin: 'my-plugin', mods: [hello] })
```

`plugin` is your plugin.json `name`. Mods run in the order of `mods`, their steps in the order of their arrays.

## Pipeline

Events: `session` (`{ reason: 'load' | 'clear' }`: `load` each time the plugin loads, which a reload or a worker respawn repeats within a session; `clear` on `/clear`), `prompt.submit`, `turn.complete` (main loop only, unless the mod sets `agents: true`), `command.run` (commands listed in `commands` are registered at each load).

A step is `(msg, next, { mod, fx }) => result`:

| To | Write |
|---|---|
| pass | `return next()`, or return nothing |
| transform | `return next({ ...msg, text })` |
| consume | return a result without calling `next` |

What no step consumes reaches the engine as it came. A step that throws is logged (`<plugin>/<mod>: <event> step <name> failed: …`) and skipped: the steps after it get its input; if it threw after `next`, what ran downstream stands. Name your steps (`function count(...)`) to read the logs.

`fx` is the only door to the engine: `toast`, `log`, `now`, `state` / `setState` (per mod and per session id, `$.store` underneath: it survives reloads, and a new session or a `/clear` starts empty), `prompt.read` / `prompt.fill`. The engine refuses a hooks module that hands `$` itself to code it cannot follow, so the kit cannot pass it on.

## Layers

Layers draw in the band above the prompt.

- `grid(view)` returns a cell grid (`grid`, `text`, `label`, `bar`, `spinner`, `composite`). Only grid layers animate and transition.
- `node(view)` returns elements from `view.ui` (`Box`, `Text`, `Button`, `actions(ui, list)`), redrawn on state changes only.
- `z` orders them, highest on top; equal `z` keeps registration order. When `maxRows` runs out, the lowest go first, never cut in half.
- Grid layers with the same `slot` are composited into one raster, higher `z` painted over lower; blank cells are transparent.
- `cover: true` takes the whole band (the highest cover wins).
- `visible(state)` shows or hides it; `enter` / `exit` (`fade`, `reveal`, `none`, with `ms` and an optional easing) play on the change, the layer keeping its rows until its exit ends.
- `animated: true` repaints it every 33 ms while visible.

Frames go through `$.ui.blit` on a raster of fixed key and size, and progress is measured in time: the band's tree is drawn again only when a state changes, a layer finishes leaving, or the terminal is resized (a stale blit is dropped and the band redrawn at the new width).

A layer that throws is left out and logged once; the others draw.

### Several plugins in one band (protocol v1)

Each plugin's band is a `Box` keyed `modkit-stack` whose children are keyed `modkit:<z>:<plugin>:<slot>`, the band beneath last. A plugin on modkit always calls `next(e)` and sorts the stack it receives into its own by `z`, then plugin name, then slot, so the band reads the same whichever plugin the engine calls first. A plugin not on modkit stays beneath, as it drew.

## Limits

- Terminal only, band above the prompt only (no pane, no hint line yet).
- `fade` dims toward black: it suits dark themes.
- The kit hooks `session.start` and `session.end` (a `/clear` fires no `session.start`, and `classic.SessionStart` can be swallowed by a plugin above), and each pipeline event a mod uses: a hook of your own on one of those, without a matcher, makes the engine refuse the module.
- A cover hides what is beneath it in the chain, not plugins above.
- On a Team or Enterprise plan, or with managed settings, Anthropic's built-in guard (`cc-plugin-sec-default`) sends `classic.*`, `prompt.compose`, `prompt.section`, `prompt.context` and `prompt.attachment` past every installed mod, with no setting to change it. modkit uses none of them; to give the model context, attach it in a `prompt.submit` step: `next({ ...msg, context: [...(msg.context ?? []), text] })`.

## This plugin

`modkit` is also the runnable example: `clock` (a spinner and a timer that fade in while Claude works) and `echo` (a prompt counter with a Reset button, `:shrug:` expansion, and `/kit-boom`, whose step and layer throw on purpose while the rest keeps working). Each can be switched off in `/config`.

```
claude --plugin-dir ./modkit      # try it
claude plugin test modkit         # tests
claude plugin validate modkit
```
