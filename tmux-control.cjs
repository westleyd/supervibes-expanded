#!/usr/bin/env node
"use strict";

/**
 * tmux-control.cjs — Cross-platform terminal session manager for supervibes.
 *
 * Manages tmux sessions and terminal windows across macOS, Linux, and Windows.
 * Platform-specific behaviour (window opening, grid positioning) is handled by
 * the appropriate adapter in the platform/ directory.
 *
 * On Windows, tmux runs inside WSL2. Set TMUX_CMD=wsl tmux to override the
 * default, or let auto-detection handle it.
 */

const { execSync } = require("child_process");

const { detectPlatform } = require("./platform/detect.cjs");
const PLATFORM = detectPlatform();
const { openTerminalWindow, rearrangeWindows, convertWorkDir } =
  require(`./platform/${PLATFORM}.cjs`);

// On Windows, tmux lives inside WSL; prefix every tmux call with `wsl`.
const TMUX = process.env.TMUX_CMD || (PLATFORM === "windows" ? "wsl tmux" : "tmux");

const PREFIX = "cc-";

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
  const raw = run(`${TMUX} list-sessions -F '#{session_name}' 2>/dev/null`);
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((s) => s.startsWith(PREFIX))
    .map((s) => s.slice(PREFIX.length));
}

function startSession(name, workDir) {
  const sess = sessionName(name);

  // check if session already exists
  const existing = run(`${TMUX} has-session -t ${sess} 2>/dev/null; echo $?`);
  if (existing === "0") {
    console.log(`Session '${name}' already exists.`);
    return;
  }

  // On Windows, workDir must be a WSL path (/mnt/c/...) for tmux -c to work.
  const tmuxWorkDir = convertWorkDir(workDir);

  // Build PATH: use the current PATH without any hardcoded platform prefixes.
  const pathEnv = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";

  // Unset CLAUDECODE so nested Claude Code sessions don't detect a parent.
  run(
    `${TMUX} new-session -d -s ${sess} -x 120 -y 40 -c "${tmuxWorkDir}" ` +
      `-e "CLAUDECODE=" ` +
      `-e "CLAUDE_CODE_ENTRYPOINT=" ` +
      `-e "TERM=xterm-256color" ` +
      `-e "PATH=${pathEnv}"`
  );

  // Unset at the tmux environment level too (prevents inheritance on attach).
  run(`${TMUX} set-environment -t ${sess} -u CLAUDECODE 2>/dev/null`);
  run(`${TMUX} set-environment -t ${sess} -u CLAUDE_CODE_ENTRYPOINT 2>/dev/null`);

  // Also send unset commands into the shell to be safe.
  run(
    `${TMUX} send-keys -t ${sess} 'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null' Enter`
  );

  openTerminalWindow(sess);
  rearrangeWindows(listSessions());
  console.log(`Started session '${name}' in ${workDir}`);
}

function stopSession(name) {
  const sess = sessionName(name);
  run(`${TMUX} kill-session -t ${sess} 2>/dev/null`);
  run("sleep 0.5");
  rearrangeWindows(listSessions());
  console.log(`Stopped session '${name}'`);
}

function stopAll() {
  const sessions = listSessions();
  for (const name of sessions) {
    run(`${TMUX} kill-session -t ${sessionName(name)} 2>/dev/null`);
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
    run(`${TMUX} send-keys -t ${sess} Enter`);
  } else {
    const escaped = text.replace(/'/g, "'\\''");
    run(`${TMUX} send-keys -t ${sess} -l '${escaped}'`);
    run(`${TMUX} send-keys -t ${sess} Enter`);
  }
}

function readPane(name, lines = 50) {
  const sess = sessionName(name);
  const output = run(`${TMUX} capture-pane -t ${sess} -p -S -${lines}`);
  console.log(output);
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
  --list                  List active sessions

Environment variables:
  TMUX_CMD    Override the tmux command (default: 'tmux' on macOS/Linux, 'wsl tmux' on Windows)`);
}

main();
