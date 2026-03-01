# tmux nested claude code — how it works

this document explains how we run nested claude code sessions inside tmux for the twitch live-coding stream. written for another AI agent to understand and operate the system.

---

## the problem

claude code detects when it's running inside another claude code session via the `CLAUDECODE` env var and blocks itself:

```
Error: Claude Code cannot be launched inside another Claude Code session
```

we need nested claude code instances visible in macOS Terminal windows for a twitch stream — viewers watch the terminals on screen.

## the solution

tmux sessions with `CLAUDECODE` unset. the outer claude code (twitch-agent) spawns tmux sessions, opens Terminal windows attached to them, and controls everything via `tmux send-keys` and `tmux capture-pane`.

```
┌──────────────────────────────────────────────────┐
│  twitch-agent.cjs (outer claude -p)              │
│  controls everything via tmux-control.cjs        │
│                                                  │
│  ┌─────────────────┐  ┌─────────────────┐        │
│  │ Terminal (left)  │  │ Terminal (right) │       │
│  │ tmux: "coding"   │  │ tmux: "coding2"  │      │
│  │ claude code      │  │ claude code      │      │
│  │ (builds project) │  │ (tests/runs)     │      │
│  └─────────────────┘  └─────────────────┘        │
└──────────────────────────────────────────────────┘
```

---

## key concepts

### 1. env vars that make it work

when creating a tmux session, three `-e` flags are critical:

```bash
tmux new-session -d -s coding -x 120 -y 40 -c "/project/dir" \
  -e "CLAUDECODE=" \
  -e "TERM=xterm-256color" \
  -e "PATH=/opt/homebrew/bin:$PATH"
```

| flag | why |
|------|-----|
| `CLAUDECODE=` | unsets the env var so nested claude code doesn't block itself |
| `TERM=xterm-256color` | tmux defaults to `tmux-256color` which makes claude code render without colors (plain white text). `xterm-256color` forces proper color output |
| `PATH=...` | ensures `/opt/homebrew/bin` is on PATH so `node`, `claude`, `g++` etc. are found |

**important:** do NOT use a `~/.tmux.conf` file. the default tmux config works best. any custom config (like `set -g default-terminal`) tends to break claude code's color rendering.

### 2. sending input — `tmux send-keys`

```bash
# send text literally (no key interpretation) + Enter
tmux send-keys -t coding -l 'build a snake game in python'
tmux send-keys -t coding Enter

# send just Enter (accept prompts, approve plans)
tmux send-keys -t coding Enter
```

the `-l` flag is critical — without it, tmux interprets key names (e.g., "C-c" becomes ctrl+c). with `-l`, text is sent literally.

**in node (tmux-control.cjs):**
```javascript
function sendKeys(name, text) {
  if (text === "") {
    run(`tmux send-keys -t ${name} Enter`);
  } else {
    const escaped = text.replace(/'/g, "'\\''");
    run(`tmux send-keys -t ${name} -l '${escaped}'`);
    run(`tmux send-keys -t ${name} Enter`);
  }
}
```

**ghost text gotcha:** claude code shows ghost suggestions that can eat the Enter keystroke. after every `--cmd "text"`, always follow up with `sleep 1 && node tmux-control.cjs --cmd ""` to send a blank Enter ensuring submission.

### 3. reading output — `tmux capture-pane`

```bash
# read last 50 lines from session
tmux capture-pane -t coding -p -S -50
```

| flag | meaning |
|------|---------|
| `-p` | print to stdout (instead of paste buffer) |
| `-S -50` | start capture 50 lines back in scrollback |

**in node:**
```javascript
function readPane(name, lines = 50) {
  return run(`tmux capture-pane -t ${name} -p -S -${lines}`);
}
```

**what to look for in output:**
- `>` prompt + "bypass permissions on" = claude code is **idle**, ready for next command
- "Proofing..." / "Honking..." / "Doing..." = **working**, keep polling
- "Yes, I trust this folder" = trust prompt → send blank Enter
- "Entered plan mode" = wants approval → send blank Enter
- "Error writing file" = normal retry, keep polling
- "Done!" / summary text = task complete, claude returns to `>`

### 4. Terminal windows — AppleScript

macOS Terminal windows are opened via AppleScript attached to tmux sessions:

```javascript
function openTerminalWindow(name, position) {
  const script = `
tell application "Finder"
  set screenBounds to bounds of window of desktop
  set screenW to item 3 of screenBounds
  set screenH to item 4 of screenBounds
end tell
set halfW to screenW / 2
tell application "Terminal"
  activate
  set prof to settings set "Pro"
  set font size of prof to 30
  do script "tmux attach -t ${name}"
  set win to front window
  set current settings of win to prof
  ${position === "left"
    ? 'set bounds of win to {0, 0, halfW, screenH}'
    : 'set bounds of win to {halfW, 0, screenW, screenH}'}
end tell`;
  run(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
}
```

key details:
- uses built-in **"Pro" profile** (black background) — never create custom profiles
- font size 30 for stream readability
- left terminal: `{0, 0, halfW, screenH}`, right terminal: `{halfW, 0, screenW, screenH}`
- `tmux attach -t <name>` connects the Terminal window to the tmux session

---

## tmux-control.cjs CLI

the controller script wraps all tmux operations:

```bash
# dual mode (stream setup) — two side-by-side terminals
node tmux-control.cjs --start2 /Users/ejae_dev/my-project

# send commands to left / right terminal
node tmux-control.cjs --cmd "build a snake game in python"
node tmux-control.cjs --cmd2 "write tests for the snake game"

# send blank Enter (accept prompts)
node tmux-control.cjs --cmd ""
node tmux-control.cjs --cmd2 ""

# read output from left / right terminal
node tmux-control.cjs --read        # last 50 lines
node tmux-control.cjs --read2 100   # last 100 lines

# kill everything
node tmux-control.cjs --stop
```

session names: `coding` (left) and `coding2` (right).

---

## full session lifecycle

this is what `twitch-agent.cjs` does for each coding activity:

```
1. start dual terminals
   node tmux-control.cjs --start2 /Users/ejae_dev/project-name
   sleep 3

2. launch claude code in both (with --dangerously-skip-permissions)
   node tmux-control.cjs --cmd "claude --dangerously-skip-permissions"
   sleep 1 && node tmux-control.cjs --cmd ""
   sleep 3
   node tmux-control.cjs --cmd2 "claude --dangerously-skip-permissions"
   sleep 1 && node tmux-control.cjs --cmd2 ""
   sleep 5

3. send build prompt to LEFT, parallel task to RIGHT
   node tmux-control.cjs --cmd "build a particle galaxy in three.js..."
   sleep 1 && node tmux-control.cjs --cmd ""
   node tmux-control.cjs --cmd2 "write tests for the project"
   sleep 1 && node tmux-control.cjs --cmd2 ""

4. poll both terminals (check every few seconds)
   node tmux-control.cjs --read    → check left status
   node tmux-control.cjs --read2   → check right status
   handle prompts on both sides

5. test: RIGHT compiles/runs, LEFT starts next improvement
   node tmux-control.cjs --cmd2 "cd /Users/ejae_dev/project && python3 main.py"
   node tmux-control.cjs --cmd "add particle trails and color gradients"

6. iterate 3-4 rounds (LEFT builds, RIGHT tests — always parallel)

7. for browser projects: screenshot → interact → ALWAYS bring Terminal back
   node dist/browser.js screenshot 0 -o /tmp/preview.png
   osascript -e 'tell application "Terminal" to activate'
   screencapture -x /tmp/terminal-check.png  → verify terminals visible

8. wrap up naturally
   node tmux-control.cjs --cmd "/exit"
   node tmux-control.cjs --cmd2 "/exit"
   sleep 2
   node tmux-control.cjs --stop
```

---

## common pitfalls

| problem | cause | fix |
|---------|-------|-----|
| "cannot launch inside another claude code" | `CLAUDECODE` env var set | `-e "CLAUDECODE="` on `tmux new-session` |
| no colors in claude code (white text) | `TERM=tmux-256color` (tmux default) | `-e "TERM=xterm-256color"` on `tmux new-session` |
| colors still broken | `~/.tmux.conf` overriding TERM | delete `~/.tmux.conf` — use default config |
| ghost text eats Enter | claude code autocomplete suggestions | always send blank `--cmd ""` after every `--cmd "text"` |
| Terminal not visible after browser use | Chrome stays in front | `osascript -e 'tell application "Terminal" to activate'` + screenshot to verify |
| `send-keys` interprets text as key names | missing `-l` flag | always use `tmux send-keys -t name -l 'text'` |
| commands not found (node, claude, g++) | PATH not set in tmux | `-e "PATH=/opt/homebrew/bin:$PATH"` on session create |

---

## file reference

| file | role |
|------|------|
| `tmux-control.cjs` | CLI controller — start/stop sessions, send/read |
| `twitch-agent.cjs` | outer loop — picks projects, builds prompts, spawns `claude -p` which uses tmux-control |
| `twitch-chat.cjs` | chat bridge (IRC) — reads/sends twitch chat |
| `twitch-overlay-render.py` | renders chat overlay PNG |
| `twitch-stream.cjs` | ffmpeg screen capture → rtmp stream |
