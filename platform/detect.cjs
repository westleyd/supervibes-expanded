#!/usr/bin/env node
"use strict";

/**
 * Detects the current platform.
 * Returns: 'macos' | 'linux' | 'windows'
 *
 * Note: Node.js reports process.platform as 'win32' even when running
 * inside Git Bash on Windows.
 */
function detectPlatform() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  throw new Error(`Unsupported platform: ${process.platform}`);
}

module.exports = { detectPlatform };
