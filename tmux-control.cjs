#!/usr/bin/env node
"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PREFIX = "cc-";
const FONT_SIZE = 16;
const WIN_COLS = 38;
const WIN_ROWS = 44;
const WIN_GAP = 10; // pixels between windows

// --- helpers ---

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 15000 }).trimEnd();
  } catch (e) {
    return e.stdout ? e.stdout.trimEnd() : "";
  }
}

function sessionName(name) {
  return `${PREFIX}${name}`;
}

// --- core functions ---

function listSessions() {
  const raw = run("tmux list-sessions -F '#{session_name}' 2>/dev/null");
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((s) => s.startsWith(PREFIX))
    .map((s) => s.slice(PREFIX.length));
}

function startSession(name, workDir) {
  const sess = sessionName(name);

  // check if session already exists
  const existing = run(`tmux has-session -t ${sess} 2>/dev/null; echo $?`);
  if (existing === "0") {
    console.log(`Session '${name}' already exists.`);
    return;
  }

  const pathEnv = `/opt/homebrew/bin:${process.env.PATH || "/usr/bin:/bin"}`;

  // Unset CLAUDECODE so nested Claude Code sessions don't detect a parent
  run(
    `tmux new-session -d -s ${sess} -x 120 -y 40 -c "${workDir}" ` +
      `-e "CLAUDECODE=" ` +
      `-e "CLAUDE_CODE_ENTRYPOINT=" ` +
      `-e "TERM=xterm-256color" ` +
      `-e "PATH=${pathEnv}"`
  );

  // Unset at the tmux environment level too (prevents inheritance on attach)
  run(`tmux set-environment -t ${sess} -u CLAUDECODE 2>/dev/null`);
  run(`tmux set-environment -t ${sess} -u CLAUDE_CODE_ENTRYPOINT 2>/dev/null`);

  // Also send unset commands into the shell to be safe
  run(`tmux send-keys -t ${sess} 'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null' Enter`);

  openTerminalWindow(sess);
  rearrangeWindows();
  console.log(`Started session '${name}' in ${workDir}`);
}

function stopSession(name) {
  const sess = sessionName(name);
  run(`tmux kill-session -t ${sess} 2>/dev/null`);
  // small delay so Terminal window closes before rearrange
  run("sleep 0.5");
  rearrangeWindows();
  console.log(`Stopped session '${name}'`);
}

function stopAll() {
  const sessions = listSessions();
  for (const name of sessions) {
    run(`tmux kill-session -t ${sessionName(name)} 2>/dev/null`);
  }
  console.log(
    sessions.length > 0
      ? `Stopped all sessions: ${sessions.join(", ")}`
      : "No active sessions."
  );
}

function sendKeys(name, text) {
  const sess = sessionName(name);
  if (text === "") {
    run(`tmux send-keys -t ${sess} Enter`);
  } else {
    const escaped = text.replace(/'/g, "'\\''");
    run(`tmux send-keys -t ${sess} -l '${escaped}'`);
    run(`tmux send-keys -t ${sess} Enter`);
  }
}

function readPane(name, lines = 50) {
  const sess = sessionName(name);
  const output = run(`tmux capture-pane -t ${sess} -p -S -${lines}`);
  console.log(output);
}

// --- Terminal window management ---

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

function rearrangeWindows() {
  const sessions = listSessions();
  if (sessions.length === 0) return;

  // Find the first cc- window, ensure it's sized correctly, measure it,
  // then position all windows left-to-right using that size.
  const firstSess = sessionName(sessions[0]);
  const topY = 40;

  let positionLogic = "";
  for (let i = 0; i < sessions.length; i++) {
    const sess = sessionName(sessions[i]);
    positionLogic += `
    repeat with win in windows
      if name of win contains "${sess}" then
        set number of columns of win to ${WIN_COLS}
        set number of rows of win to ${WIN_ROWS}
      end if
    end repeat
`;
  }

  // Second pass: measure actual pixel size, then set positions
  let boundsLogic = "";
  for (let i = 0; i < sessions.length; i++) {
    const sess = sessionName(sessions[i]);
    boundsLogic += `
    repeat with win in windows
      if name of win contains "${sess}" then
        set position of win to {${topY} + ${i} * (winW + ${WIN_GAP}), ${topY}}
      end if
    end repeat
`;
  }

  const script = `
tell application "Terminal"
  activate

  -- first pass: ensure all cc windows are sized correctly
  ${positionLogic}

  delay 0.3

  -- measure pixel size of first cc window
  set winW to 400
  repeat with win in windows
    if name of win contains "${firstSess}" then
      set b to bounds of win
      set winW to (item 3 of b) - (item 1 of b)
      exit repeat
    end if
  end repeat

  -- second pass: position left to right
  ${boundsLogic}
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

// --- CLI ---

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    return;
  }

  const flag = args[0];

  switch (flag) {
    case "--start": {
      const name = args[1];
      const workDir = args[2];
      if (!name || !workDir) {
        console.error("Usage: --start <name> <working-dir>");
        process.exit(1);
      }
      startSession(name, workDir);
      break;
    }
    case "--cmd": {
      const name = args[1];
      const text = args[2];
      if (!name || text === undefined) {
        console.error('Usage: --cmd <name> "command text"');
        process.exit(1);
      }
      sendKeys(name, text);
      break;
    }
    case "--read": {
      const name = args[1];
      const lines = args[2] ? parseInt(args[2], 10) : 50;
      if (!name) {
        console.error("Usage: --read <name> [lines]");
        process.exit(1);
      }
      readPane(name, lines);
      break;
    }
    case "--stop": {
      const name = args[1];
      if (!name) {
        console.error("Usage: --stop <name>");
        process.exit(1);
      }
      stopSession(name);
      break;
    }
    case "--stop-all": {
      stopAll();
      break;
    }
    case "--list": {
      const sessions = listSessions();
      if (sessions.length === 0) {
        console.log("No active sessions.");
      } else {
        console.log("Active sessions:");
        for (const s of sessions) {
          console.log(`  ${s}`);
        }
      }
      break;
    }
    default:
      console.error(`Unknown flag: ${flag}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.log(`Usage:
  --start <name> <dir>    Start a new terminal session
  --cmd <name> "text"     Send command to a session
  --read <name> [lines]   Read output (default 50 lines)
  --stop <name>           Stop a session
  --stop-all              Stop all sessions
  --list                  List active sessions`);
}

main();
