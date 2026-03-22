#!/usr/bin/env node
"use strict";

/**
 * Linux platform adapter for supervibes.
 *
 * Terminal emulator:
 *   X11  — gnome-terminal → konsole → xfce4-terminal → xterm
 *   Wayland — xterm (preferred) → gnome-terminal → konsole → xfce4-terminal
 *
 *   On Wayland, gnome-terminal/konsole/xfce4-terminal use a D-Bus factory model:
 *   new windows are created by a server daemon that ignores GDK_BACKEND=x11 on
 *   the client side. xterm has no factory model and is always X11/XWayland-native,
 *   so wmctrl can see and position its windows correctly.
 *
 * Window positioning: wmctrl (preferred) → xdotool (fallback) → graceful skip
 *
 * Prerequisites (Ubuntu/Debian):
 *   sudo apt install tmux wmctrl
 *   # For Wayland grid positioning:
 *   sudo apt install xterm
 *   # Optional for xdotool fallback:
 *   sudo apt install xdotool
 */

const { execSync } = require("child_process");

const PREFIX = "cc-";
const WIN_COLS = 53;
const WIN_ROWS = 22;
const GRID_ROWS = 2;
const WIN_GAP = 10;
const GRID_ORIGIN_X = 40;
const GRID_ORIGIN_Y = 40;

// Rough pixel estimates per character for window sizing
const CHAR_W = 8;
const CHAR_H = 18;
const WIN_PADDING_W = 20;
const WIN_PADDING_H = 50;

function isWayland() {
  return !!process.env.WAYLAND_DISPLAY;
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 15000 }).trimEnd();
  } catch (e) {
    return e.stdout ? e.stdout.trimEnd() : "";
  }
}

function which(cmd) {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8", timeout: 5000 });
    return true;
  } catch (_) {
    return false;
  }
}

function detectTerminalEmulator() {
  // On Wayland, GTK/Qt terminals use a D-Bus factory model: the daemon that creates
  // windows ignores GDK_BACKEND=x11 set on the client, so new windows remain
  // Wayland-native and are invisible to wmctrl. xterm has no factory — it is always
  // an XWayland window — so prefer it on Wayland for reliable grid positioning.
  const order = isWayland()
    ? ["xterm", "gnome-terminal", "konsole", "xfce4-terminal"]
    : ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
  for (const term of order) {
    if (which(term)) return term;
  }
  return null;
}

function buildTerminalCmd(term, sess) {
  const attach =
    `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null; tmux attach -t ${sess}`;
  // GDK_BACKEND=x11 / QT_QPA_PLATFORM=xcb help only when the terminal's D-Bus
  // server daemon is not already running; if it is, the daemon ignores these vars.
  // On Wayland, detectTerminalEmulator() prefers xterm which has no factory model.
  // These prefixes are kept here as a best-effort fallback for edge cases.
  const gtkX11  = isWayland() ? "GDK_BACKEND=x11 " : "";
  const qtX11   = isWayland() ? "QT_QPA_PLATFORM=xcb " : "";

  switch (term) {
    case "gnome-terminal":
      // No 'exec bash' — let the window close when tmux exits so stale windows
      // don't accumulate across iterations.
      return `${gtkX11}gnome-terminal --title="${sess}" -- bash -c '${attach}'`;
    case "konsole":
      return `${qtX11}konsole --title "${sess}" -e bash -c '${attach}'`;
    case "xfce4-terminal":
      // xfce4-terminal -e takes a single string
      return `${gtkX11}xfce4-terminal --title="${sess}" -e "bash -c '${attach}'"`;
    case "xterm":
    default:
      // xterm is always X11-native — no prefix needed
      return `xterm -title "${sess}" -e bash -c '${attach}'`;
  }
}

function openTerminalWindow(sess) {
  const term = detectTerminalEmulator();
  if (!term) {
    const waylandHint = isWayland()
      ? "\n  On Wayland, xterm is required for grid positioning: sudo apt install xterm"
      : "";
    console.warn(
      "[supervibes] No supported terminal emulator found.\n" +
      "  Install one: sudo apt install gnome-terminal  (or xterm, konsole, xfce4-terminal)" +
      waylandHint
    );
    return;
  }
  const cmd = buildTerminalCmd(term, sess);
  // Launch detached so Node.js doesn't wait for the window to close
  execSync(`${cmd} &`, { timeout: 5000, shell: "/bin/bash" });
}

/**
 * Close all terminal windows whose title contains a cc- session name.
 * Called during stopAll to prevent stale windows from accumulating across
 * iterations.
 */
function closeAllWindows() {
  const hasWmctrl = which("wmctrl");
  const hasXdotool = which("xdotool");

  if (hasWmctrl) {
    // wmctrl -l lists all windows; grep for cc- prefix, then close each
    const list = run(`wmctrl -l 2>/dev/null`);
    if (list) {
      for (const line of list.split("\n")) {
        if (line.includes(PREFIX)) {
          // Extract window ID (first column)
          const wid = line.trim().split(/\s+/)[0];
          if (wid) run(`wmctrl -i -c ${wid} 2>/dev/null`);
        }
      }
    }
  } else if (hasXdotool) {
    const wids = run(`xdotool search --name "${PREFIX}" 2>/dev/null`);
    if (wids) {
      for (const wid of wids.split("\n")) {
        if (wid.trim()) run(`xdotool windowclose ${wid.trim()} 2>/dev/null`);
      }
    }
  }
}

function rearrangeWindows(sessions) {
  if (sessions.length === 0) return;

  const hasWmctrl = which("wmctrl");
  const hasXdotool = which("xdotool");

  if (!hasWmctrl && !hasXdotool) {
    const waylandNote = isWayland()
      ? "\n  On Wayland, also install xterm for X11-compatible windows: sudo apt install xterm"
      : "";
    console.warn(
      "[supervibes] Window positioning skipped — neither wmctrl nor xdotool found.\n" +
      "  Install wmctrl: sudo apt install wmctrl" + waylandNote
    );
    return;
  }

  // Give windows time to appear. gnome-terminal uses D-Bus so the window may
  // take longer to materialise than the gnome-terminal command itself.
  run("sleep 1.5");

  const winW = WIN_COLS * CHAR_W + WIN_PADDING_W;
  const winH = WIN_ROWS * CHAR_H + WIN_PADDING_H;

  for (let i = 0; i < sessions.length; i++) {
    const col = Math.floor(i / GRID_ROWS);
    const row = i % GRID_ROWS;
    const x = GRID_ORIGIN_X + col * (winW + WIN_GAP);
    const y = GRID_ORIGIN_Y + row * (winH + WIN_GAP);
    const title = `${PREFIX}${sessions[i]}`;

    if (hasWmctrl) {
      // -e gravity,x,y,w,h  (gravity 0 = default)
      // Retry once after a short delay if the window isn't found yet.
      let result = run(`wmctrl -r "${title}" -e 0,${x},${y},${winW},${winH} 2>&1`);
      if (result.includes("Cannot find")) {
        run("sleep 1");
        run(`wmctrl -r "${title}" -e 0,${x},${y},${winW},${winH} 2>/dev/null`);
      }
    } else {
      // xdotool: search by name, then move + resize
      const wid = run(`xdotool search --name "${title}" 2>/dev/null | head -1`);
      if (wid) {
        run(`xdotool windowsize ${wid} ${winW} ${winH} 2>/dev/null`);
        run(`xdotool windowmove ${wid} ${x} ${y} 2>/dev/null`);
      } else {
        // Retry once
        run("sleep 1");
        const wid2 = run(`xdotool search --name "${title}" 2>/dev/null | head -1`);
        if (wid2) {
          run(`xdotool windowsize ${wid2} ${winW} ${winH} 2>/dev/null`);
          run(`xdotool windowmove ${wid2} ${x} ${y} 2>/dev/null`);
        }
      }
    }
  }
}

function convertWorkDir(dir) {
  return dir; // no conversion needed on Linux
}

module.exports = { openTerminalWindow, rearrangeWindows, closeAllWindows, convertWorkDir };
