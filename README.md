# Nested Claude Code

Run multiple Claude Code instances in parallel, orchestrated by a controller Claude Code instance that acts as a tech lead — decomposing your goal into focused sub-tasks and delegating each to its own terminal.

```
You → Dashboard → Controller Claude Code
                        ├── Terminal 1: Claude Code (ui)
                        ├── Terminal 2: Claude Code (api)
                        ├── Terminal 3: Claude Code (db)
                        └── Terminal 4: Claude Code (tests)
```

## Requirements

- **Node.js** (no npm install needed — no dependencies)
- **Claude Code CLI** — installed and authenticated ([docs](https://docs.anthropic.com/en/docs/claude-code))
- Platform-specific prerequisites listed below

---

### macOS

- **tmux** — `brew install tmux`
- Terminal.app (built-in) — used for window management via AppleScript

### Linux (Ubuntu Desktop / GNOME, KDE, XFCE)

- **tmux** — `sudo apt install tmux`
- A terminal emulator (auto-detected in order): `gnome-terminal`, `konsole`, `xfce4-terminal`, `xterm`
- **wmctrl** (recommended for window positioning) — `sudo apt install wmctrl`
  - Fallback: `sudo apt install xdotool`

### Windows (Git Bash + WSL2)

- **Windows Terminal** (recommended) — [Install from the Microsoft Store](https://aka.ms/terminal)
  - Fallback: Git Bash (comes with mintty) — [git-scm.com](https://git-scm.com/downloads)
- **WSL2** with Ubuntu — [Install WSL](https://aka.ms/wsl)
- **Inside WSL**: `sudo apt install tmux`
- **Claude Code inside WSL**: `npm install -g @anthropic-ai/claude-code`
  - Authenticate: `claude` → follow the login prompt

---

## Quick Start

```bash
git clone <repo-url>
cd supervibes
node server.cjs
```

Open **http://localhost:3456** in your browser.

1. Type a goal (e.g. "Build a todo app with React and Express")
2. Pick terminal count (Auto lets the controller decide, or choose 1–6)
3. Pick a model (Sonnet, Opus, Haiku) — used for both the controller and child terminals
4. Set iterations (0 = one-shot, 1–5 = automatic improvement rounds after the initial build)
5. Click **Start**

Terminal windows will pop up on your screen — one per sub-task. The dashboard shows what the controller is doing in real-time.

## CLI Alternative

If you prefer a terminal-only experience:

```bash
node start.cjs
```

## How It Works

The controller is a Claude Code instance running in prompt mode. It receives a system prompt that tells it to act as a senior engineer who delegates work across parallel terminals. It uses a tmux control script to:

1. **Start** tmux sessions (each opens a terminal window)
2. **Launch** Claude Code in each session
3. **Send** focused tasks with explicit file ownership ("You own src/api/. Don't touch other files.")
4. **Poll** terminal output to monitor progress
5. **Verify** the project works before finishing
6. **Clean up** all sessions

The children are fully independent Claude Code instances. They don't know about each other or the controller — they just receive a task and do it.

## What Happens On Screen

When you click Start, you'll see:

- **Dashboard** (left panel): Activity log showing every action the controller takes — starting terminals, sending prompts, reading output
- **Dashboard** (right panel): List of active terminals with click-to-expand prompts
- **Terminal windows**: One window per child Claude Code instance, arranged in a grid

## Iterations

Setting iterations > 0 triggers automatic improvement rounds after the initial build. Each round spawns a fresh controller that:

1. Reviews the code built so far
2. Fixes bugs and improves quality
3. Adds one new feature
4. Verifies everything works

## Project Structure

```
server.cjs            — HTTP server, SSE streaming, controller process management
tmux-control.cjs      — Cross-platform session manager (start, stop, send commands, read output)
start.cjs             — CLI launcher (alternative to the dashboard)
public/index.html     — Web dashboard (single file, no dependencies)
platform/
  detect.cjs          — Platform detection (macos / linux / windows)
  macos.cjs           — macOS adapter: Terminal.app + AppleScript window management
  linux.cjs           — Linux adapter: gnome-terminal/konsole/xterm + wmctrl/xdotool
  windows.cjs         — Windows adapter: Windows Terminal (wt.exe) + WSL2 tmux
```

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `TMUX_CMD` | `tmux` (macOS/Linux), `wsl tmux` (Windows) | Override the tmux command |

## Limitations

- **Controller quality varies** — sometimes it under-parallelizes or sends overly broad prompts. The system prompt is tuned for this but it's not perfect.
- **No structured communication** — the controller talks to children by typing into terminals and reading screen output via tmux. There's no API or message passing.
- **Window positioning on Windows is best-effort** — Windows Terminal doesn't expose a positioning API; windows are moved via Win32 P/Invoke, which may not always work.
- **WSL2 required on Windows** — tmux runs inside WSL; native Windows tmux is not supported.

## License

MIT
