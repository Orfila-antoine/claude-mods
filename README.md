# claude-mods

Claude Code mods (plugins of function hooks).

## backstage

A band above the prompt:

| Button | Key | What it does |
|---|---|---|
| ✨✏️ | `r` | Haiku rewrites your draft so it is clear and precise, from the recent conversation |
| Refine… | `i` | Same, with a direction: Clarify, Simplify, Distill, Focus, Harden, Expand, Overdrive |
| Write prompt… | `w` | Haiku writes (empty box) or rewrites your draft as a prompt type: Question, UI change, Bug fix, Feature / ticket, Code review, Investigation, Tooling / config |
| Verify | `v` | A read-only Haiku scout checks the sentence you selected, or else the weakest claim found in the last answer; the verdict shows as a toast |
| Undo Haiku | `u` | Restores your draft; gone once you edit or send the prompt |
| Handoff → /new | `p` | From 50 % of context: runs `/session-handoff`, then `/new`, and puts the summary in the new prompt |
| 3 next prompts | `1` `2` `3` | After each answer, Opus at low effort (last 10 messages and the full answer, in your own style) proposes the next step, the answer to the open point and a check; one click sends it as is |

Press a button with the mouse, or focus the band with `ctrl+x tab` and press its key. `/refute <text>` verifies a given sentence.

Requirements: the Handoff button needs a `session-handoff` skill or command in your setup.

### Install

```
/plugin marketplace add Orfila-antoine/claude-mods
/plugin install backstage@claude-mods
```

### Develop

```
claude plugin validate backstage
claude plugin test backstage
```
