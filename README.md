# claude-mods

Claude Code mods (plugins of function hooks).

## coulisses

A band above the prompt:

| Button | Key | What it does |
|---|---|---|
| ✨✏️ | `r` | Haiku rewrites your draft so it is clear and precise, from the recent conversation |
| Refine… | `i` | Same, with a direction: Clarify, Simplify, Distill, Focus, Harden, Expand, Overdrive |
| Write prompt… | `w` | Haiku writes (empty box) or rewrites your draft as a prompt type: Question, UI change, Bug fix, Feature / ticket, Code review, Investigation, Tooling / config |
| Verify | `v` | A read-only Haiku scout checks the sentence you selected, or else the weakest claim found in the last answer; the verdict shows as a toast |
| Undo Haiku | `u` | Restores your draft; gone once you edit or send the prompt |
| Handoff → /new | `p` | From 50 % of context: runs `/session-handoff`, then `/new`, and puts the summary in the new prompt |

Press a button with the mouse, or focus the band with `ctrl+x tab` and press its key. `/refute <text>` verifies a given sentence.

Requirements: the Handoff button needs a `session-handoff` skill or command in your setup.

### Install

```
/plugin marketplace add Orfila-antoine/claude-mods
/plugin install coulisses@claude-mods
```

### Develop

```
claude plugin validate coulisses
claude plugin test coulisses
```
