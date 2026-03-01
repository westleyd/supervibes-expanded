# Nested Claude Code — How It Works

## The Core Idea

A **controller** Claude Code instance acts as a tech lead. It doesn't write code itself — it spawns multiple **child** Claude Code instances in parallel tmux sessions and delegates focused tasks to each one. Each child works independently on its own files while the controller monitors progress and coordinates.

## The Nesting Mechanism

### Problem: Claude Code blocks nesting by default

Claude Code detects if it's running inside another Claude Code session via the `CLAUDECODE` environment variable. If set, it refuses to start with: *"Claude Code cannot be launched inside another Claude Code session."*

### Solution: Unset the env var + use tmux as isolation

1. The controller is spawned with `CLAUDECODE` deleted from its environment
2. Each child runs in its own **tmux session**, which provides process isolation
3. The tmux sessions also unset `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` at three levels:
   - tmux `-e` flag on session creation
   - `tmux set-environment -u` to prevent inheritance on attach
   - `unset` command sent directly into the shell

This triple-unset ensures no child Claude Code instance ever sees the parent's env vars.

## How the Controller Operates

The controller is a Claude Code instance running in **prompt mode** (`claude -p "..."`) — it receives a single system prompt containing:

1. **A role identity** — senior staff engineer who delegates, never codes
2. **A tool reference** — the `tmux-control.cjs` CLI and all its commands
3. **Parallelism rules** — split work across 3-6 terminals, each with explicit file ownership
4. **The user's goal**

The controller then uses Claude Code's Bash tool to execute `tmux-control.cjs` commands. From its perspective, it's just running shell commands — it doesn't know it's orchestrating other AI instances.

### Controller workflow

```
Controller thinks: "I need to build a web app. I'll split it into 4 areas."

$ node tmux-control.cjs --start ui /path/to/project
$ node tmux-control.cjs --start api /path/to/project
$ node tmux-control.cjs --start db /path/to/project
$ node tmux-control.cjs --start tests /path/to/project

(each --start creates a tmux session + macOS Terminal window)

$ node tmux-control.cjs --cmd ui "claude --dangerously-skip-permissions --model sonnet"
$ node tmux-control.cjs --cmd ui ""          ← blank Enter to dismiss prompts
$ node tmux-control.cjs --cmd ui "Build the React components in src/components/. You own this directory only."
$ node tmux-control.cjs --cmd ui ""          ← blank Enter to dismiss ghost text

(repeat for api, db, tests — each gets a focused, non-overlapping task)

$ node tmux-control.cjs --read ui            ← poll for progress
$ node tmux-control.cjs --read api
...

(when all done)
$ node tmux-control.cjs --cmd ui "/exit"
$ node tmux-control.cjs --stop-all
```

### What `--cmd` actually does

`tmux send-keys` — it types text into the tmux pane and presses Enter. This is how the controller "talks" to each child Claude Code instance. The child sees it as if a human typed a prompt.

### What `--read` actually does

`tmux capture-pane` — it reads the visible terminal output (last N lines). The controller uses this to check if a child is still working, idle (shows `>` prompt), or stuck on a trust/plan prompt.

### Why blank Enters matter

Claude Code has ghost text (autocomplete suggestions) that can interfere with the next command. Sending a blank Enter (`--cmd <name> ""`) after every real command clears any pending ghost text or dismisses trust/plan approval prompts.

## Parallelism & Ownership

The key to avoiding conflicts between children: **each terminal owns specific files**.

The controller's system prompt enforces this pattern:

```
Terminal "ui":   "You own src/components/. Do NOT edit files outside this directory."
Terminal "api":  "You own src/api/. Do NOT edit files outside this directory."
Terminal "db":   "You own src/db/. Do NOT edit files outside this directory."
Terminal "tests": "You only read code and run tests. Do NOT edit source files."
```

Since each child Claude Code instance respects its instructions, there are no file conflicts even though all terminals run simultaneously in the same project directory.

## Iteration System

After the initial build completes (controller exits with code 0), the system can automatically spawn a new controller round with an improvement-focused prompt:

1. **Code review** — read through what was built, find issues
2. **Fix and improve** — address bugs, refactor, improve quality
3. **Add a feature** — one meaningful addition
4. **Verify** — test everything works

Each iteration spawns fresh child terminals. Up to 5 iterations can run sequentially.

## Process Tree

```
server.cjs (or start.cjs)
  └── claude -p "system prompt + goal"          ← controller
        ├── [Bash] node tmux-control.cjs ...    ← controller's tool calls
        │
        ├── tmux session "cc-ui"
        │     └── claude --dangerously-skip-permissions   ← child 1
        ├── tmux session "cc-api"
        │     └── claude --dangerously-skip-permissions   ← child 2
        ├── tmux session "cc-db"
        │     └── claude --dangerously-skip-permissions   ← child 3
        └── tmux session "cc-tests"
              └── claude --dangerously-skip-permissions   ← child 4
```

## Key Flags

| Flag | Purpose |
|---|---|
| `claude -p "..."` | Prompt mode — controller receives instructions as a single prompt, runs autonomously |
| `--dangerously-skip-permissions` | Both controller and children skip all permission prompts (required for unattended operation) |
| `--model <model>` | Select which Claude model to use (sonnet, opus, haiku) |
| `--output-format stream-json --verbose` | Controller only — enables real-time JSON streaming of output for the dashboard |

## Requirements

- **macOS** — uses Terminal.app + AppleScript for window management
- **tmux** — `brew install tmux`
- **Claude Code CLI** — installed and authenticated
