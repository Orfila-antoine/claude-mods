# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): plugins that change Claude Code's own interface through its function-hook API.

## backstage

**A band of buttons above your Claude Code prompt: turn a rough draft into a sharp prompt in one key, make a read-only scout check Claude's weakest claim, and send one of three next prompts in one click.**

```
 [✨✏️] [Refine…] [Write prompt…] [Verify] [Undo] [Handoff → /new]
 ──────────────────────────────────────────────────────────────────
 [1] Run the auth spec alone and paste the first failing line
 [2] Should expired tokens return 401 or redirect to /login?
 [3] Check that refreshToken is still called on the mobile client
 > _
```

### Install

```
/plugin marketplace add Orfila-antoine/claude-mods
/plugin install backstage@claude-mods
```

Built and tested on Claude Code 2.1.296.

### What it does

**A sharp prompt in one key.** `✨✏️` rewrites your draft so it is clear and precise, using the recent conversation. `Refine…` does the same in a direction you pick: Clarify, Simplify, Distill, Focus, Harden, Expand, Overdrive. `Write prompt…` writes a prompt from scratch (empty box) or rewrites your draft as a type: Question, UI change, Bug fix, Feature / ticket, Code review, Investigation, Tooling / config. The result replaces your draft; `Undo` brings the draft back until you edit or send.

**Catch Claude bluffing.** `Verify` sends a read-only scout (Haiku, Read/Grep/Glob only, no edits) to check the sentence you selected. With nothing selected, it first finds the weakest claim in Claude's last answer, then checks that. The verdict, `CONFIRMED`, `REFUTED` or `INCONCLUSIVE` with its evidence, shows as a toast. `/refute <text>` checks a sentence you type.

**Three next prompts, not one.** Claude Code's built-in suggestion offers one guess as ghost text. backstage offers three distinct moves after every answer: the next step, the open point, and a check, each in 12 words or fewer. They rain in as random letters, then decode left to right. Press `1`, `2` or `3` (or click) to send one as is. Nothing is ever sent without your click.

**Hand off before the context fills up.** From 50 % of context, `Handoff → /new` appears, coloured like a context gauge (green, yellow above 50 %, red above 80 %). It runs `/session-handoff`, opens `/new`, and puts the summary in the new prompt.

### Keys

Click a button, or focus the band with `ctrl+x tab` and press its key:

| Key | Button |
|---|---|
| `r` | ✨✏️ rewrite |
| `i` | Refine… |
| `w` | Write prompt… |
| `v` | Verify |
| `u` | Undo |
| `p` | Handoff → /new |
| `1` `2` `3` | Send a suggested prompt |

### What it costs

backstage calls models on your account:

| When | Call |
|---|---|
| After every answer, and when a session resumes | 1 Opus call at low effort for the three next prompts (last 10 messages, each cut to 1,500 characters, plus the last 6,000 characters of the answer) |
| `✨✏️`, `Refine…`, `Write prompt…` | 1 Opus call at low effort per click |
| `Verify` | 1 Haiku scout; with nothing selected, also 1 call to your session's model to pick the weakest claim |

To stop it: `/plugin disable backstage@claude-mods`.

### Handoff requirement

`Handoff → /new` needs a `session-handoff` skill or command in your setup whose answer starts with `# Session Handoff`. Any other answer stops the handoff with a toast, and nothing is lost.

### How it's built

One hooks module, [`backstage/hooks/register.tsx`](backstage/hooks/register.tsx), readable as an example of the mod API:

- `ui.render` on `AbovePrompt` draws the band and fits it to the rows left;
- `turn.complete` triggers the suggestions and catches the scout's verdict;
- `agent.register` declares the read-only scout, and `agent.offer` hides it from the main model;
- `command.register` adds `/refute`.

Every model instruction lives in [`backstage/hooks/prompts.ts`](backstage/hooks/prompts.ts).

```
claude plugin validate backstage
claude plugin test backstage
```

## ripple

**Edits stop flooding the conversation, and you see what they ripple into.**

Each successful `Edit` or `Write` collapses to one line, `● Edit  src/token.ts  +3 -1`, the dot colored by its share of added lines, without the diff block, even while it runs. Edits in a row on one file fold into one line, `+5 -2 x3`, that counts up as each edit lands. A failed edit, or one on a sensitive file (`.env*`, `.git*`, `.claude/`, `.codex/`, `.github/`, `.husky/`, `.ssh/`, `.npmrc`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `settings*.json`, `hooks.json`, keys and certificates), keeps the full view. A finished search group reads `● Found it: src/auth.ts:42`.

`/ripple` opens a pane with one section per author, `Claude` then `agent: <its brief>`. Each section is a tree of the files just edited, one line per file with its net diff against the last commit (`git diff --numstat HEAD`; summed edits outside git) and `x3` once it is edited 3 times, colored from red to green by its share of added lines: a new file is green, a deleted one (`rm`, `git rm`, `del`, `Remove-Item`) grey. The files that use the latest one join the tree one after another, lit for a moment with `~ uses token.ts`:

```
Claude
src/
  auth.ts  ~ uses token.ts
  token.ts +3 -1
api/
  client.ts
```

Dependents are found with one `Grep` for the file's name inside its git repo, 300 ms after the agent's latest edit. Claude's own files (`~/.claude/{projects,plans,jobs,todos,memory,dev-mods,plugins}/` and any `MEMORY.md`) stay out of the pane. Nothing is searched while the pane is closed, nor outside a git repo except under the session's own folder.

```
/plugin install ripple@claude-mods
```

## cues

**Small cues around the prompt, none of them a popup.**

- Claude ends each answer with one `Next:` line, and the line under your empty prompt shows it as `next: …`.
- Options in Claude's questions state their consequence: files touched, migrations, impact on clients.
- The first line of a session reads `Week 3 in a row, rest days are free.` and `Resume: <your bead in progress>` (from `.beads/issues.jsonl` when there is one).
- A successful `git push` plays eight sparks and `pushed 9199dfc -> main` above the band over the prompt when Claude's turn ends, for 3 s.

`cues` adds two lines to the system prompt (the `Next:` line and the option consequences).

```
/plugin install cues@claude-mods
```

## wipe

**`/clear` and `/new` stop being a cut: the screen goes away with style.**

Before the conversation clears, the chat, the band above the prompt and the line under it play one effect together, for about 1.5 s, then the clear runs:

- `blackhole`: the text spirals into a hole at the center, purple then orange then yellow.
- `fall`: the rows fall to the bottom of the screen, the lowest first.
- `dust`: from left to right, the characters crumble into ash and drift away.
- `fade`: the text dims to black from the top down.
- `tv`: an old TV switching off: the screen squashes into a bright line, the line into a dot, the dot goes out.

`/wipe <effect>` plays one without clearing anything (`/wipe` alone picks one at random, as `/clear` does). The effect redraws the conversation from its text, since a mod cannot read the screen: line breaks and colours differ a little from what was there. The prompt box itself stays as it is.

```
/plugin install wipe@claude-mods
```

## License

MIT
