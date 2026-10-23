# modkit

A kit for Claude Code mods (terminal): one entry point, an ordered middleware pipeline for messages and events, layers above the prompt, and smooth transitions that do not flicker.

modkit is copied into your plugin, not installed: a plugin may only import its own files, and only plain data crosses between plugins.

```
node modkit/install.mjs <your-plugin-dir>           # copies hooks/modkit/, writes own.ts and the contract block
node modkit/install.mjs <your-plugin-dir> --check   # exit 1 if your copy, own.ts or the contract drifted
```

`hooks/modkit/own.ts` is written for your plugin's `name` and is the only file that writes its `layout`. The contract (`types/index.d.ts`, created and named in `plugin.json` if missing) gets a `// modkit:roster` block the script rewrites: the layout types and the `PluginState` of each roster member. If your contract already declares your plugin in `PluginState`, add `layout: ModkitLayout` to that entry.

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

## In a mod that keeps its own hooks

A mod with its own `on(...)` hooks (they keep `$`) uses the kit à la carte:

```tsx
const KIT: Kit = { plugin: 'my-plugin', mods: [hello] }

on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => band($, e, await next(e), KIT))
on('turn.complete', async ($, e, next) => {
  await modFx($, KIT, 'hello').setState<{ count: number }>(s => ({ count: (s?.count ?? 0) + 1 }))
  return next(e)
})
```

`band` draws the layers, `modFx` gives a hook the same `fx` the layers read from. A button whose action needs `$` gets `onPress={() => undefined}` and is handled by key in the mod's own `ui.press` hook, after `await next(e)`. Hook an event either through `defineMods` or yourself, never both: the engine refuses two hooks on one event without a matcher.

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

Layers draw in the band above the prompt. Element layers draw on every surface; grid layers on the terminal only.

- `grid(view)` returns a cell grid (`grid`, `text`, `label`, `bar`, `spinner`, `composite`). Only grid layers animate and transition.
- `node(view)` returns elements from `view.ui` (`Box`, `Text`, `Button`, `actions(ui, list)`), redrawn on state changes only.
- `view.columns` is the width the layer is given (full or narrowed): draw from it, never from `bodyColumns`, and switch to a compact form under whatever width you choose.
- `rows` is a number or `({ state, columns, maxRows, isWorking }) => number`, `columns` being that given width; `visible(state, room)` gets `columns = bodyColumns` (visibility comes before the plan).
- Grid layers of one plugin with the same `slot` are composited into one raster and one cell of the flow, higher `z` painted over lower; blank cells are transparent.
- `cover: true` takes the whole band (the highest cover wins).
- `visible(state)` shows or hides it; `enter` / `exit` (`fade`, `reveal`, `none`, with `ms` and an optional easing) play on the change, the layer keeping its place until its exit ends.
- `animated: true` repaints it every 33 ms while visible.

Frames go through `$.ui.blit` on a raster of fixed key and size, and progress is measured in time: the band's tree is drawn again only when a state or a published layout changes, a layer finishes leaving, or the terminal is resized.

A layer that throws is left out and logged once; the others draw.

### The flow

Every layer of every roster plugin goes in one vertical flow, ordered by `z` (highest on top), then plugin name, then declaration order. A layer is a block (the default) or a float:

| Field | Meaning |
|---|---|
| `float: 'left' \| 'right'`, `width` | a float of that fixed width, glued to its edge from the row where it comes in the flow; it takes no row from the flow |
| `minColumns` | a block's narrowest readable width (default 1) |
| `priority` | what survives when `maxRows` runs out (default `z`) |
| `at: [{ below, float?, hidden? }]` | breakpoints: each entry whose `below` is above `bodyColumns` applies in order; `float: null` makes a float a block, `hidden` hides it |

- A block takes the width left at its row: a block that starts while a float is active is narrowed by its whole width (per layer, not per line); the first block that starts after the float ends is full width again. A zone taller than its blocks keeps the float's height, the blocks at its bottom.
- At most one float per side at a time: a second one on a taken side is a block. A float that would push a block that starts beside it under its `minColumns` is a block too.
- Placement rule: the band grows upward, so what acts on the prompt and never leaves gets the lowest `z`, and what comes and goes the highest. Importance is `priority`: when `maxRows` runs out, layers are taken by `priority`, each skipped whole if it does not fit.

### Shared plan

Each plugin publishes its layers in its own `$.state` key `layout` (`ModkitLayout`: per layer its id, `z`, order, flow and its rows at full width and at each narrowed width the published floats could give it). `band` publishes it itself, from a timer, when what it computes differs from what it reads back, and logs each write; then every roster plugin runs the same `solve(bodyColumns, maxRows, layouts)` and gets the same plan.

The roster is `hooks/modkit/roster.ts`, one literal reference per plugin; a plugin that is not loaded reads as nothing. Adding a mod = one line there, then `install.mjs` on each roster mod.

### Several plugins in one band (protocol v2)

Each rendered layer is keyed `modkit:<id>` and sized to its plan width. A plugin returns a `Box` keyed `modkit-stack`: the rest (the engine band, plugins not on modkit) first, then the flow (`modkit-flow`), so the lowest layer stays on the prompt. A float zone is a row: left float, the column of narrowed blocks, right float. A plugin always calls `next(e)`, takes every `modkit:` element of the plan out of what it gets back (at any depth), drops the inner flows, unwraps the inner stacks and rebuilds one flow from the plan. A layer of the plan whose element is not there yet keeps its place empty.

## Limits

- Terminal only, band above the prompt only (no pane, no hint line yet). The layout is published from terminal draws only.
- `fade` dims toward black: it suits dark themes.
- The kit hooks `session.start` and `session.end` (a `/clear` fires no `session.start`, and `classic.SessionStart` can be swallowed by a plugin above), and each pipeline event a mod uses: a hook of your own on one of those, without a matcher, makes the engine refuse the module.
- A cover hides the rest of the band beneath the flow, not plugins above.
- Text never wraps around a float: a block beside it is narrowed whole. One float per side at a time.
- A plugin outside the roster is not laid out: drawn beneath us it lands above the flow; drawn around us it places our flow itself and may still overflow beside it. A roster plugin still on modkit 0.2 publishes nothing: move the whole roster together.
- After `/clear` or a resume `$.state` starts empty: the first draw lacks the others' layouts until they publish again.
- Two opposite floats in one zone: a block that started beside only one of them is clipped to the zone's middle column.
- On a Team or Enterprise plan, or with managed settings, Anthropic's built-in guard (`cc-plugin-sec-default`) sends `classic.*`, `prompt.compose`, `prompt.section`, `prompt.context` and `prompt.attachment` past every installed mod, with no setting to change it. modkit uses none of them; to give the model context, attach it in a `prompt.submit` step: `next({ ...msg, context: [...(msg.context ?? []), text] })`.

## This plugin

`modkit` is also the runnable example: `clock` (a spinner and a timer that fade in while Claude works) and `echo` (a prompt counter with a Reset button, `:shrug:` expansion, and `/kit-boom`, whose step and layer throw on purpose while the rest keeps working). Each can be switched off in `/config`.

```
claude --plugin-dir ./modkit      # try it
claude plugin test modkit         # tests
claude plugin validate modkit
```
