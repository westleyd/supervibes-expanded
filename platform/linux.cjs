#!/usr/bin/env node
"use strict";

/**
 * Linux platform adapter for supervibes.
 *
 * Terminal emulator: auto-detects gnome-terminal → konsole → xfce4-terminal → xterm
 * Window positioning: wmctrl (preferred) → xdotool (fallback) → graceful skip
 *
 * Prerequisites (Ubuntu/Debian):
 *   sudo apt install tmux wmctrl
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
  for (const term of ["gnome-terminal", "konsole", "xfce4-terminal", "xterm"]) {
    if (which(term)) return term;
  }
  return null;
}

function buildTerminalCmd(term, sess) {
  const attach =
    `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null; tmux attach -t ${sess}`;
  // On Wayland, GTK/Qt terminals open as Wayland-native windows which wmctrl cannot
  // see or position. Forcing the X11 backend makes them run via XWayland instead,
  // restoring wmctrl grid positioning without requiring any extra tools.
  const gtkX11  = isWayland() ? "GDK_BACKEND=x11 " : "";
  const qtX11   = isWayland() ? "QT_QPA_PLATFORM=xcb " : "";

  switch (term) {
    case "gnome-terminal":
      return `${gtkX11}gnome-terminal --title="${sess}" -- bash -c '${attach}; exec bash'`;
    case "konsole":
      return `${qtX11}konsole --title "${sess}" -e bash -c '${attach}; exec bash'`;
    case "xfce4-terminal":
      // xfce4-terminal -e takes a single string
      return `${gtkX11}xfce4-terminal --title="${sess}" -e "bash -c '${attach}; exec bash'"`;
    case "xterm":
    default:
      // xterm is always X11-native — no prefix needed
      return `xterm -title "${sess}" -e bash -c '${attach}'`;
  }
}

function openTerminalWindow(sess) {
  const term = detectTerminalEmulator();
  if (!term) {
    console.warn(
      "[supervibes] No supported terminal emulator found.\n" +
      "  Install one: sudo apt install gnome-terminal  (or konsole / xfce4-terminal / xterm)"
    );
    return;
  }
  const cmd = buildTerminalCmd(term, sess);
  // Launch detached so Node.js doesn't wait for the window to close
  execSync(`${cmd} &`, { timeout: 5000, shell: "/bin/bash" });
}

function rearrangeWindows(sessions) {
  if (sessions.length === 0) return;

  const hasWmctrl = which("wmctrl");
  const hasXdotool = which("xdotool");

  if (!hasWmctrl && !hasXdotool) {
    const waylandNote = isWayland()
      ? "\n  On Wayland, GDK_BACKEND=x11 is set automatically — wmctrl should work."
      : "";
    console.warn(
      "[supervibes] Window positioning skipped — neither wmctrl nor xdotool found.\n" +
      "  Install wmctrl: sudo apt install wmctrl" + waylandNote
    );
    return;
  }

  // Give windows a moment to appear before we try to position them
  run("sleep 1");

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
      run(`wmctrl -r "${title}" -e 0,${x},${y},${winW},${winH} 2>/dev/null`);
    } else {
      // xdotool: search by name, then move
      run(
        `xdotool search --name "${title}" windowmove ${x} ${y} 2>/dev/null`
      );
    }
  }
}

function convertWorkDir(dir) {
  return dir; // no conversion needed on Linux
}

module.exports = { openTerminalWindow, rearrangeWindows, convertWorkDir };
