# cache-tax

**Keep Claude Code's one-hour prompt cache warm during breaks, and get stopped once before a cold send with its estimated rewrite cost. The status row lives in the modkit band.**

> Adapted from [cache-tax](https://github.com/karanb192/claude-code-mods/tree/main/plugins/cache-tax) 2.2.1 by **Karan Bansal**, under the MIT License ([website](https://cachetax.aidojo.si/)). The warming loop, the guard, the pricing and the commands are his; this fork changes how the row is drawn and how a `/clear` is detected. His copyright notice is kept in [`LICENSE`](LICENSE).

```
● cache-tax warm · keepwarm 5h10m left · ping in 50m · last ping read 200k $0.05
```

## What changed from upstream

- **The row is a modkit grid layer.** It is drawn at a fixed width and placed in the same flow as the other roster mods (backstage, cues, eta-band, mirror), so it no longer jumps or duplicates when another mod's line changes width.
- **It shrinks instead of wrapping.** On a narrow terminal, the last ping goes first, then the `cache-tax` name; after that, the text is cut with `…`.
- **The state shows as a colored dot plus a word.** `●` is green when warm, orange when cold and grey for `unknown` or `stopped`, and the state word always follows it. The orange follows Claude's light or dark theme. `NO_COLOR` drops every color.
- **`/clear` is detected through `session.end`.** Upstream relied on `classic.SessionStart`, which Anthropic's built-in guard (`cc-plugin-sec-default`) skips on Team and Enterprise plans. A window restored at session start is armed right away.
- **Desktop and the other surfaces get the plain status text.** modkit draws on the terminal only, so the image cube is gone.

## Commands

    /keepwarm               keep warm for six hours
    /keepwarm 90m           keep warm for a window of your own (also 2h30m, 6h)
    /keepwarm always        arm a six-hour window at every session start
    /keepwarm 6h every 2m   ping every two minutes; a testing knob, floor 1m
    /keepwarm status        the warming window, next ping and last receipt
    /keepwarm off           stop, forget the window, and turn always off
    /cache-tax              the card
    /cache-tax guard warn   show the price and send
    /cache-tax guard refuse drop a cold send once, the resend goes through (default)

Pings are real model requests and cost tokens. See the [upstream README](https://github.com/karanb192/claude-code-mods/tree/main/plugins/cache-tax#cost-and-the-plan-limit-question) for costs, limits and how to prove a ping on your own session.

## Install

```
/plugin marketplace add Orfila-antoine/claude-mods
/plugin install cache-tax@claude-mods
```

Disable `cache-tax@claude-code-mods` first: both register `/keepwarm` and `/cache-tax`, and two guards would stop every cold send twice.

## Limits

- Where `classic.SessionStart` is skipped, a resumed session gets no resume fields. Until its first turn, the row reads `unknown` and the guard has no clock to price a cold send.
- The row repaints every 30 seconds while a window is armed, so its countdown moves in steps of up to 30 seconds.

## Tests

```
claude plugin test cache-tax
claude plugin validate cache-tax/.claude-plugin/plugin.json
```
