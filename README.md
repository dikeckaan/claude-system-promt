# system-promt

A Claude Code mod that shows, exports and edits the system prompt of your session.

## Install

In Claude Code:

```
/plugin marketplace add dikeckaan/claude-system-promt
/plugin install system-promt@system-promt
```

It is written with Claude Code's function hooks, an early-access API: it needs a recent Claude Code (built against 2.1.288) and may break when that API changes.

## Use

| Command | What it does |
| --- | --- |
| `/system-promt` | Opens a pane with a section picker, the section's text, and Edit / Reset / Export / Refresh buttons |
| `/system-promt list` | Lists every section with its size; `✎` marks an edited one |
| `/system-promt export [path]` | Writes everything the model is given to a markdown file (`system-prompt.md` in the working directory by default) |
| `/system-promt edit <section>` | Copies the section to `~/.claude/system-promt/<section>.md` and opens it in your text editor |
| `/system-promt reset <section\|all>` | Restores the original text |

The export has four parts: the system prompt's sections, the first message's context blocks (CLAUDE.md, date, account), the messages the engine injects (skill listings, reminders), and each tool's name and description. The second and third are captured as they pass, so send one message after installing before you export. Tool parameter schemas are not included.

An edited section is sent from the next request after you save its file, and stays edited across sessions until you reset it. An empty file drops the section. Changing a section invalidates the prompt cache for the next request.

**An export contains your own instructions, memory and account email. Read it before you share it.**

## Develop

```
claude plugin validate plugins/system-promt
claude plugin test plugins/system-promt
```
