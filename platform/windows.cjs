#!/usr/bin/env node
"use strict";

/**
 * Windows platform adapter for supervibes.
 *
 * Session management: delegates to WSL2 tmux (via `wsl tmux ...`)
 * Terminal launcher:  Windows Terminal (wt.exe) → mintty (Git Bash) → error
 * Window positioning: PowerShell Win32 SetWindowPos (best-effort)
 *
 * Prerequisites:
 *   - Windows Terminal: https://aka.ms/terminal  (recommended)
 *     OR Git Bash (comes with mintty) as fallback
 *   - WSL2 with a Linux distro (e.g. Ubuntu): https://aka.ms/wsl
 *   - Inside WSL: sudo apt install tmux
 *   - Claude Code in WSL: npm install -g @anthropic-ai/claude-code
 *
 * Usage note:
 *   All tmux commands must be prefixed with `wsl` when called from Windows.
 *   Set TMUX_CMD=wsl tmux  (tmux-control.cjs handles this automatically on Windows).
 */

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PREFIX = "cc-";
const GRID_ROWS = 2;
const WIN_GAP = 10;
const GRID_ORIGIN_X = 40;
const GRID_ORIGIN_Y = 40;
const WIN_W = 500;
const WIN_H = 350;

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 15000 }).trimEnd();
  } catch (e) {
    return e.stdout ? e.stdout.trimEnd() : "";
  }
}

/**
 * Converts a working directory path to a WSL-compatible path (/mnt/c/...).
 * Handles Git Bash paths (/c/Users/...) and Windows paths (C:\Users\...).
 */
function convertWorkDir(dir) {
  if (!dir) return dir;
  // Already a proper Unix/WSL path
  if (dir.startsWith("/mnt/")) return dir;
  // Git Bash path: /c/Users/... → /mnt/c/Users/...
  const gitBashMatch = dir.match(/^\/([a-zA-Z])\/(.*)/);
  if (gitBashMatch) {
    return `/mnt/${gitBashMatch[1].toLowerCase()}/${gitBashMatch[2]}`;
  }
  // Windows path: C:\Users\... or C:/Users/...
  const winMatch = dir.match(/^([a-zA-Z]):[/\\](.*)/);
  if (winMatch) {
    const drive = winMatch[1].toLowerCase();
    const rest = winMatch[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }
  return dir;
}

function hasWt() {
  try {
    execSync("where wt.exe 2>nul", { encoding: "utf-8", timeout: 5000 });
    return true;
  } catch (_) {
    // where.exe might not work in Git Bash; try PowerShell
    try {
      const result = execSync(
        "powershell -NoProfile -Command \"(Get-Command wt -ErrorAction SilentlyContinue) -ne $null\"",
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      return result === "True";
    } catch (_) {
      return false;
    }
  }
}

function findMintty() {
  const candidates = [
    "C:\\Program Files\\Git\\usr\\bin\\mintty.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\mintty.exe",
  ];
  for (const p of candidates) {
    try {
      const result = execSync(
        `powershell -NoProfile -Command "Test-Path '${p}'"`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      if (result === "True") return p;
    } catch (_) {}
  }
  return null;
}

function openTerminalWindow(sess) {
  const attach =
    `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null; tmux attach -t ${sess}`;

  if (hasWt()) {
    // Windows Terminal: open a new tab running WSL, which attaches to the tmux session
    run(`wt.exe new-tab --title "${sess}" -- wsl bash -c '${attach}'`);
    return;
  }

  const mintty = findMintty();
  if (mintty) {
    // mintty (Git Bash terminal emulator): spawn a new window running WSL tmux attach
    run(`start "" "${mintty}" -t "${sess}" -e bash -c 'wsl ${attach}'`);
    return;
  }

  console.warn(
    "[supervibes] No terminal launcher found on Windows.\n" +
    "  Option 1 (recommended): Install Windows Terminal from the Microsoft Store\n" +
    "    https://aka.ms/terminal\n" +
    "  Option 2: Install Git for Windows (includes mintty)\n" +
    "    https://git-scm.com/downloads\n" +
    "  Also ensure WSL2 + Ubuntu is installed: https://aka.ms/wsl"
  );
}

function rearrangeWindows(sessions) {
  if (sessions.length === 0) return;

  // Build a PowerShell script that uses Win32 SetWindowPos to reposition windows.
  // Windows Terminal doesn't expose a positioning API, so we use P/Invoke.
  const windowMoves = sessions
    .map((name, i) => {
      const col = Math.floor(i / GRID_ROWS);
      const row = i % GRID_ROWS;
      const x = GRID_ORIGIN_X + col * (WIN_W + WIN_GAP);
      const y = GRID_ORIGIN_Y + row * (WIN_H + WIN_GAP);
      const title = `${PREFIX}${name}`;
      return `Move-WindowByTitle "${title}" ${x} ${y} ${WIN_W} ${WIN_H}`;
    })
    .join("\n");

  const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Helper {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
"@

function Move-WindowByTitle($title, $x, $y, $w, $h) {
    $SWP_NOZORDER = 0x0004
    [Win32Helper]::EnumWindows([Win32Helper+EnumWindowsProc]{
        param($hwnd, $lParam)
        $sb = New-Object System.Text.StringBuilder 256
        [Win32Helper]::GetWindowText($hwnd, $sb, 256) | Out-Null
        if ($sb.ToString() -like "*$title*" -and [Win32Helper]::IsWindowVisible($hwnd)) {
            [Win32Helper]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $w, $h, $SWP_NOZORDER) | Out-Null
        }
        return $true
    }, [IntPtr]::Zero) | Out-Null
}

# Wait for windows to appear
Start-Sleep -Milliseconds 1500

${windowMoves}
`;

  const tmp = path.join(os.tmpdir(), `supervibes-arrange-${Date.now()}.ps1`);
  try {
    fs.writeFileSync(tmp, psScript);
    run(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}" 2>/dev/null`
    );
  } catch (_) {
    console.warn("[supervibes] Window positioning skipped (PowerShell error).");
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

module.exports = { openTerminalWindow, rearrangeWindows, convertWorkDir };
