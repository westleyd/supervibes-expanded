#!/usr/bin/env node
"use strict";

/**
 * macOS platform adapter for supervibes.
 * Uses Terminal.app + AppleScript for window management.
 * Original implementation — no changes from the upstream code.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PREFIX = "cc-";
const FONT_SIZE = 16;
const WIN_COLS = 53;
const WIN_ROWS = 22;
const GRID_ROWS = 2;
const WIN_GAP = 10;
const GRID_ORIGIN_X = 40;
const GRID_ORIGIN_Y = 40;

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 15000 }).trimEnd();
  } catch (e) {
    return e.stdout ? e.stdout.trimEnd() : "";
  }
}

function openTerminalWindow(sess) {
  const script = `
tell application "Terminal"
  activate
  set prof to settings set "Pro"
  set font size of prof to ${FONT_SIZE}
  do script "unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null; tmux attach -t ${sess}"
  delay 0.5
  set win to front window
  set current settings of win to prof
  set number of columns of win to ${WIN_COLS}
  set number of rows of win to ${WIN_ROWS}
end tell`;
  runAppleScript(script);
}

function rearrangeWindows(sessions) {
  if (sessions.length === 0) return;

  const firstSess = `${PREFIX}${sessions[0]}`;

  let resizeLogic = "";
  for (const name of sessions) {
    const sess = `${PREFIX}${name}`;
    resizeLogic += `
    repeat with win in windows
      if name of win contains "${sess}" then
        set number of columns of win to ${WIN_COLS}
        set number of rows of win to ${WIN_ROWS}
      end if
    end repeat
`;
  }

  // Fill order: top-to-bottom, then left-to-right
  let gridLogic = "";
  for (let i = 0; i < sessions.length; i++) {
    const sess = `${PREFIX}${sessions[i]}`;
    const col = Math.floor(i / GRID_ROWS);
    const row = i % GRID_ROWS;
    gridLogic += `
    repeat with win in windows
      if name of win contains "${sess}" then
        set position of win to {${GRID_ORIGIN_X} + ${col} * (winW + ${WIN_GAP}), ${GRID_ORIGIN_Y} + ${row} * (winH + ${WIN_GAP})}
      end if
    end repeat
`;
  }

  const script = `
tell application "Terminal"
  activate

  -- first pass: resize all cc windows
  ${resizeLogic}

  delay 0.3

  -- measure pixel size of first cc window
  set winW to 400
  set winH to 300
  repeat with win in windows
    if name of win contains "${firstSess}" then
      set b to bounds of win
      set winW to (item 3 of b) - (item 1 of b)
      set winH to (item 4 of b) - (item 2 of b)
      exit repeat
    end if
  end repeat

  -- second pass: position in grid (top-to-bottom, left-to-right)
  ${gridLogic}
end tell`;
  runAppleScript(script);
}

function runAppleScript(script) {
  const tmp = path.join(os.tmpdir(), `tmux-control-${Date.now()}.scpt`);
  fs.writeFileSync(tmp, script);
  try {
    run(`osascript ${tmp}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function convertWorkDir(dir) {
  return dir; // no conversion needed on macOS
}

module.exports = { openTerminalWindow, rearrangeWindows, convertWorkDir };
