#!/usr/bin/env node
"use strict";

/**
 * Linux platform adapter for supervibes.
 *
 * xterm is always preferred — it has no D-Bus factory model, so it works
 * whether the server is launched from a GUI session or over SSH (where
 * WAYLAND_DISPLAY may be unset). GTK/Qt terminals use a D-Bus daemon that
 * creates Wayland-native windows invisible to wmctrl — kept as fallbacks only.
 *
 * Window positioning: wmctrl + xdotool (both used; Mutter needs a second pass)
 *
 * Prerequisites (Ubuntu/Debian):
 *   sudo apt install tmux wmctrl xdotool xterm
 */

const { execSync, spawn: nodeSpawn } = require("child_process");

const PREFIX = "cc-";
const GRID_ROWS = 2;
const WIN_GAP = 6;
const GRID_ORIGIN_X = 20;
const GRID_ORIGIN_Y = 20;

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

function getScreenSize() {
  const d = run("xdpyinfo 2>/dev/null | grep dimensions");
  if (d) {
    const m = d.match(/(\d+)x(\d+)\s+pixels/);
    if (m) return { width: +m[1], height: +m[2] };
  }
  const x = run("xrandr 2>/dev/null | grep '\\*'");
  if (x) {
    const m = x.match(/(\d+)x(\d+)/);
    if (m) return { width: +m[1], height: +m[2] };
  }
  return { width: 1920, height: 1080 };
}

function computeGrid(sessionCount) {
  const screen = getScreenSize();
  const rows = Math.min(GRID_ROWS, sessionCount);
  const cols = Math.ceil(sessionCount / rows);
  const availW = screen.width - GRID_ORIGIN_X * 2 - (cols - 1) * WIN_GAP;
  const availH = screen.height - GRID_ORIGIN_Y * 2 - (rows - 1) * WIN_GAP;
  const winW = Math.max(200, Math.floor(availW / cols));
  const winH = Math.max(150, Math.floor(availH / rows));
  return { rows, cols, winW, winH };
}

function detectTerminalEmulator() {
  // xterm is always preferred: no D-Bus factory model, works reliably from both
  // GUI sessions and SSH. GTK/Qt terminals kept only as fallbacks.
  const order = ["xterm", "gnome-terminal", "konsole", "xfce4-terminal"];
  for (const term of order) {
    if (which(term)) return term;
  }
  return null;
}

function buildTerminalCmd(term, sess) {
  const attach = `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null; tmux attach -t ${sess}`;
  // GDK_BACKEND/QT hints are best-effort for edge cases where the D-Bus daemon
  // isn't already running. xterm needs no prefix — it is always X11-native.
  const gtkX11 = isWayland() ? "GDK_BACKEND=x11 " : "";
  const qtX11  = isWayland() ? "QT_QPA_PLATFORM=xcb " : "";
  switch (term) {
    case "gnome-terminal":
      return `${gtkX11}gnome-terminal --title="${sess}" -- bash -c '${attach}'`;
    case "konsole":
      return `${qtX11}konsole --title "${sess}" -e bash -c '${attach}'`;
    case "xfce4-terminal":
      return `${gtkX11}xfce4-terminal --title="${sess}" -e "bash -c '${attach}'"`;
    case "xterm":
    default:
      return `xterm -title "${sess}" -e bash -c '${attach}'`;
  }
}

function openTerminalWindow(sess) {
  const term = detectTerminalEmulator();
  if (!term) {
    console.warn(
      "[supervibes] No supported terminal emulator found.\n" +
      "  Install one: sudo apt install xterm"
    );
    return;
  }
  const cmd = buildTerminalCmd(term, sess);
  // Use spawn() with detached:true — multiple rapid execSync+& launches can be
  // dropped on XWayland due to race conditions in the X11 socket.
  const child = nodeSpawn("bash", ["-c", cmd], { detached: true, stdio: "ignore" });
  child.unref();
  // Brief pause between launches to let XWayland settle before the next window
  run("sleep 0.5");
}

function killTerminalWindows() {
  run(`pkill -f 'xterm.*${PREFIX}' 2>/dev/null`);
  run(`pkill -f 'gnome-terminal.*${PREFIX}' 2>/dev/null`);
  run(`pkill -f 'konsole.*${PREFIX}' 2>/dev/null`);
  run(`pkill -f 'xfce4-terminal.*${PREFIX}' 2>/dev/null`);
}

function rearrangeWindows(sessions) {
  if (sessions.length === 0) return;

  const hasWmctrl  = which("wmctrl");
  const hasXdotool = which("xdotool");

  if (!hasWmctrl && !hasXdotool) {
    console.warn(
      "[supervibes] Window positioning skipped — install wmctrl or xdotool.\n" +
      "  sudo apt install wmctrl xdotool"
    );
    return;
  }

  // Give windows a moment to appear before positioning
  run("sleep 1");

  const { rows, winW, winH } = computeGrid(sessions.length);

  function positionAll() {
    for (let i = 0; i < sessions.length; i++) {
      const col = Math.floor(i / rows);
      const row = i % rows;
      const x = GRID_ORIGIN_X + col * (winW + WIN_GAP);
      const y = GRID_ORIGIN_Y + row * (winH + WIN_GAP);
      const title = `${PREFIX}${sessions[i]}`;

      if (hasWmctrl) {
        // Remove maximized state first — Mutter ignores moves on maximized windows
        run(`wmctrl -r "${title}" -b remove,maximized_vert,maximized_horz 2>/dev/null`);
        run(`wmctrl -r "${title}" -e 0,${x},${y},${winW},${winH} 2>/dev/null`);
        run(`wmctrl -r "${title}" -b remove,hidden 2>/dev/null`);
      }
      if (hasXdotool) {
        run(`xdotool search --name "${title}" windowsize ${winW} ${winH} windowmove ${x} ${y} 2>/dev/null`);
      }
    }
  }

  positionAll();

  // Wayland/Mutter often ignores the first positioning attempt — second pass fixes it
  if (isWayland() || !hasWmctrl) {
    run("sleep 0.4");
    positionAll();
  }
}

function convertWorkDir(dir) {
  return dir; // no conversion needed on Linux
}

module.exports = { openTerminalWindow, rearrangeWindows, killTerminalWindows, convertWorkDir };
