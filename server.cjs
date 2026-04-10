#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { execSync, spawn } = require("child_process");

const PORT = parseInt(process.env.PORT, 10) || 3456;
const TMUX_CONTROL = path.join(__dirname, "tmux-control.cjs");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BUFFER_LINES = 500;
const POLL_INTERVAL_MS = 2000;
// Watchdog: nudge the controller if it goes quiet
const WATCHDOG_QUIET_MS  = 30000;  // quiet threshold before nudging (30s)
const WATCHDOG_CHECK_MS  = 10000;  // how often we check (10s)
const WATCHDOG_MAX_NUDGES = 10;    // give up after this many nudges without output
// Marker the orchestrator outputs to signal it has finished a work session
const COMPLETION_MARKER = "##SUPERVIBES_DONE##";

// --- SYSTEM_PROMPT (reused from start.cjs) ---

const SYSTEM_PROMPT = `You are a senior staff software engineer and expert technical lead. Your role is to decompose complex projects into parallel workstreams and delegate them across multiple Claude Code terminals. You think architecturally — breaking systems into clean modules with clear interfaces — and you manage your team of AI coders like a seasoned engineering manager: precise task assignments, clear ownership boundaries, and aggressive parallelization. You never do the coding yourself — you delegate everything and monitor progress.

You have the following tool available — a CLI script you run via shell:

## tmux-control.cjs commands

# Start a new terminal window with a Claude Code-ready environment
node ${TMUX_CONTROL} --start <name> <working-dir>

# Send a command to a terminal
node ${TMUX_CONTROL} --cmd <name> "your instruction here"

# Send blank Enter (accept prompts, approve plans, dismiss ghost text)
node ${TMUX_CONTROL} --cmd <name> ""

# Read output from a terminal (default 50 lines, or specify count)
node ${TMUX_CONTROL} --read <name>
node ${TMUX_CONTROL} --read <name> 100

# Stop a specific terminal
node ${TMUX_CONTROL} --stop <name>

# Stop all terminals
node ${TMUX_CONTROL} --stop-all

# List active terminals
node ${TMUX_CONTROL} --list

## Workflow

1. Break the goal into small, focused sub-tasks — one per terminal
2. Stagger terminal starts 12-15s apart to avoid OOM (do NOT launch all at once). Descriptive names e.g. "ui", "api", "tests"
3. In each terminal, launch Claude Code: --cmd <name> "claude --dangerously-skip-permissions --model <MODEL>"
4. Wait a few seconds, then send a blank Enter: --cmd <name> ""
5. Send a SHORT, FOCUSED task to each terminal — one specific thing per terminal
6. IMPORTANT: Always follow every --cmd with a blank Enter after ~1 second: --cmd <name> ""
7. Poll terminals with --read to check progress
8. When done, exit Claude Code in each terminal: --cmd <name> "/exit"
9. Clean up: --stop-all

## MANDATORY: MAXIMIZE PARALLEL TERMINALS

You MUST split work across AS MANY terminals as possible. The whole point of this system is parallelism. More terminals = faster delivery.

**Minimum 3 terminals, aim for 4-6 for any non-trivial task.**

Think of it like a dev team — you wouldn't assign one developer to build an entire app. You'd have one on the data layer, one on the UI components, one on styling, one on utilities, one on tests, etc.

Example — "Build a ball drop game with Three.js":
WRONG (2 terminals, too few):
- Terminal 1: obstacles.js (all obstacles)
- Terminal 2: index.html (everything else)

RIGHT (5 terminals, properly distributed):
- Terminal 1: "Create obstacles.js with 8 obstacle factory functions for Three.js + cannon-es. Each returns {meshes, bodies, update}. You own obstacles.js only."
- Terminal 2: "Create physics.js — cannon-es world setup, ball body, gravity, contact materials, stuck detection + reset. You own physics.js only."
- Terminal 3: "Create renderer.js — Three.js scene, camera follow with lerp + shake, sky-to-hell color gradient based on depth, fog, lighting. You own renderer.js only."
- Terminal 4: "Create ui.js — HTML overlay showing depth, speed, max depth. Depth milestone popups at 10m, 50m, 100m, 500m. You own ui.js only."
- Terminal 5: "Create index.html — imports all modules, runs the game loop, procedurally spawns obstacles ahead of the ball, cleans up old ones. You own index.html only."

Each terminal gets ONE file or ONE responsibility. Be precise about what it owns and how it connects to the others.

## Reading output — what to look for

- ">" prompt = Claude Code is idle, ready for next command
- Working indicators (e.g. "Analyzing...", "Writing...") = still working, keep polling
- "Yes, I trust this folder" = trust prompt, send blank Enter
- "Entered plan mode" = wants approval, send blank Enter
- Task complete = you'll see a summary and the ">" prompt returns

## Parallel execution — USE MULTIPLE TERMINALS

ALWAYS use multiple terminals in parallel. Stagger launches 12-15s apart — start a terminal, send its task, then start the next. Do NOT launch all simultaneously (causes OOM crashes on memory-constrained systems).

There are NO conflicts as long as your instructions to each terminal are precise about what files and directories it owns. This is easy — just be explicit in every prompt.

**How to split work:**
- Give each terminal a distinct area (e.g. "ui" owns src/components/, "api" owns src/api/, "tests" only reads and runs tests)
- In each prompt, state exactly: "You own <directory>. Do NOT create or edit files outside this directory."
- Stagger terminal starts 12-15s apart; send each its task immediately after starting it
- For dependent work, start both — have the dependent one scaffold its own area while waiting, then integrate once the dependency is ready

**Simple rule:** If the task can be split into 2+ areas, split it and run in parallel. The only thing that matters is giving clear, non-overlapping ownership in each prompt.

## Verification — MANDATORY before completion

You MUST verify that everything works before declaring the task done. NEVER hand off a project without testing it first.

**Frontend work:**
- Start the dev server and confirm it runs without errors
- Use a terminal to take screenshots (e.g. \`npx playwright screenshot\`, \`screencapture\`, or have Claude Code use its screenshot tool) and verify the UI looks correct
- Check the browser console for errors by reading the terminal output
- Test key user flows — click through the app, fill forms, navigate pages

**Backend work:**
- Start the server and confirm it boots without errors
- Hit key API endpoints with curl and verify responses (correct status codes, expected data)
- Check logs for warnings or errors
- Run any existing test suites

**Full-stack work:**
- Do ALL of the above
- Verify frontend can talk to backend (API calls succeed, data renders)

**General:**
- Run the project's test suite if one exists (\`npm test\`, \`pytest\`, etc.)
- Run linters/type checks if configured (\`npm run lint\`, \`tsc --noEmit\`, etc.)
- If any test or check fails, fix it before finishing — loop until clean
- Summarize verification results when reporting completion: what you tested, what passed

## Important rules

- ALWAYS use --cmd <name> "" (blank Enter) after every --cmd <name> "text" to handle ghost text
- Wait a few seconds between starting a terminal and sending commands
- Use descriptive session names that match the task purpose
- DEFAULT to running multiple terminals in parallel — speed matters more than caution
- Stagger terminal starts 12-15s apart; send each its task immediately after starting it
- When you have fully completed all assigned tasks and verified everything works, signal completion by outputting this exact text on a line by itself: ${COMPLETION_MARKER}
`;

// --- State ---

const state = {
  running: false,
  controllerProcess: null,
  controllerOutput: [],   // ring buffer, max MAX_BUFFER_LINES
  goal: "",
  terminalCount: "auto",
  model: "sonnet",
  workerModel: "haiku",
  githubRepo: "",
  workDir: "",
  iterations: 0,
  currentIteration: 0,
  sessions: [],
  sseClients: [],
  pollInterval: null,
  stopped: false,
  // Log file
  logFilePath: null,
  logStream: null,
  // Rate limit recovery
  rateLimitDetected: false,
  rateLimitResetTime: null,   // Date object
  rateLimitTimer: null,
  rateLimitBackupTimer: null, // fires every 2h when primary timer > 2h (handles incorrect parse)
  rateLimitResumedAt: null,
  // User messages queued for delivery to orchestrator on next spawn
  pendingMessages: [],
  // Watchdog — detects when the controller goes quiet and nudges it
  lastControllerOutputAt: 0,
  watchdogNudges: 0,
  watchdogInterval: null,
  // /compact event-driven handoff
  onCompactComplete: null,
  compactFallbackTimer: null,
};

// --- Helpers ---

// Wrap a plain-text message in the stream-json envelope claude expects on stdin
function makeStreamJsonMsg(content) {
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function pushControllerLine(line) {
  state.controllerOutput.push(line);
  if (state.controllerOutput.length > MAX_BUFFER_LINES) {
    state.controllerOutput.shift();
  }
  writeLog(line);
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = state.sseClients.length - 1; i >= 0; i--) {
    try {
      state.sseClients[i].write(msg);
    } catch (_) {
      state.sseClients.splice(i, 1);
    }
  }
}

function runTmux(...args) {
  try {
    return execSync(`node ${TMUX_CONTROL} ${args.join(" ")}`, {
      encoding: "utf-8",
      timeout: 15000,
    }).trimEnd();
  } catch (e) {
    return e.stdout ? e.stdout.trimEnd() : "";
  }
}

// --- Log file helpers ---

function resolveLogDir(workDir) {
  // Try 1: user-specified workDir
  if (workDir) {
    const resolved = path.resolve(workDir);
    try {
      fs.accessSync(resolved, fs.constants.W_OK);
      return resolved;
    } catch (_) {}
  }
  // Try 2: server's own directory (__dirname)
  try {
    fs.accessSync(__dirname, fs.constants.W_OK);
    return __dirname;
  } catch (_) {}
  // Try 3: user's home directory
  return os.homedir();
}

function openLog(workDir, goal, githubRepo, terminalCount, model, workerModel, iterations) {
  // Close any existing log first
  closeLog();

  const logDir = resolveLogDir(workDir);
  const now = new Date();
  const year  = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day   = String(now.getDate()).padStart(2, "0");
  const hh    = String(now.getHours()).padStart(2, "0");
  const mm    = String(now.getMinutes()).padStart(2, "0");
  const ss    = String(now.getSeconds()).padStart(2, "0");
  const filename = `supervibes_${year}${month}${day}-${hh}${mm}${ss}.log`;
  const logPath = path.join(logDir, filename);

  try {
    const stream = fs.createWriteStream(logPath, { flags: "w", encoding: "utf-8" });
    state.logFilePath = logPath;
    state.logStream = stream;

    const workerParams = JSON.stringify({
      terminals: terminalCount,
      models: { controller: model, worker: workerModel },
      iterations,
    });

    const header = [
      `supervibes run log — ${now.toISOString()}`,
      `prompt=${goal}`,
      `GitHub url=${githubRepo || ""}`,
      `path=${workDir || ""}`,
      `worker parameters=${workerParams}`,
      "=".repeat(60),
      "",
    ].join("\n");

    stream.write(header);
    return logPath;
  } catch (err) {
    console.warn("[supervibes] Failed to open log file:", err.message);
    state.logFilePath = null;
    state.logStream = null;
    return null;
  }
}

function writeLog(line) {
  if (state.logStream) {
    try {
      state.logStream.write(line + "\n");
    } catch (_) {}
  }
}

function closeLog() {
  if (state.logStream) {
    try { state.logStream.end(); } catch (_) {}
    state.logStream = null;
  }
}

// --- Controller stdin / watchdog ---

function sendToController(text) {
  if (!state.controllerProcess) return false;
  const stdin = state.controllerProcess.stdin;
  if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
  try {
    stdin.write(makeStreamJsonMsg(text));
    return true;
  } catch (_) {
    return false;
  }
}

function startWatchdog() {
  stopWatchdog();
  state.watchdogNudges = 0;
  state.lastControllerOutputAt = Date.now();
  state.watchdogInterval = setInterval(() => {
    if (!state.controllerProcess || !state.running) { stopWatchdog(); return; }
    if (state.rateLimitDetected) return;  // rate limit active — don't nudge
    const quietMs = Date.now() - state.lastControllerOutputAt;
    if (quietMs < WATCHDOG_QUIET_MS) return;
    if (state.watchdogNudges >= WATCHDOG_MAX_NUDGES) {
      const gaveUpMsg = `[Watchdog: ${WATCHDOG_MAX_NUDGES} nudges sent with no response — stopping nudges]`;
      pushControllerLine(gaveUpMsg);
      broadcast("controller", { line: gaveUpMsg });
      stopWatchdog();
      return;
    }
    state.watchdogNudges++;
    // Reset the clock so we don't fire again immediately
    state.lastControllerOutputAt = Date.now();
    const nudgeMsg = `[Watchdog: quiet for ${Math.round(quietMs / 1000)}s — nudge #${state.watchdogNudges}]`;
    pushControllerLine(nudgeMsg);
    broadcast("controller", { line: nudgeMsg });
    sendToController("continue");
  }, WATCHDOG_CHECK_MS);
}

function stopWatchdog() {
  if (state.watchdogInterval) {
    clearInterval(state.watchdogInterval);
    state.watchdogInterval = null;
  }
}

// --- Rate limit helpers ---

/**
 * Parse a reset time string like "resets 5am (America/Chicago)" into a Date.
 * Returns a Date in the future, or null if unparseable.
 */
function parseResetTime(message) {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?([ap]m)\s*\(([^)]+)\)/i.exec(message);
  if (!m) return null;

  let h = parseInt(m[1], 10);
  const min = parseInt(m[2] || "0", 10);
  const ampm = m[3].toLowerCase();
  const tz = m[4];

  if (ampm === "pm" && h !== 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;

  const now = new Date();

  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const checkDate = new Date(now.getTime() + dayOffset * 86400000);

    // Get the Y/M/D in the target timezone
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(checkDate);
    const p = {};
    for (const part of parts) p[part.type] = part.value;

    // Build a naive UTC estimate (pretend the wall-clock time is UTC)
    const naiveISO = `${p.year}-${p.month}-${p.day}T${String(h).padStart(2,"0")}:${String(min).padStart(2,"0")}:00.000Z`;
    const estimate = new Date(naiveISO);

    // Find what hour this UTC maps to in the target timezone
    const tzHour = parseInt(new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "2-digit", hour12: false,
    }).format(estimate), 10);

    // Shift estimate so the target timezone shows the desired hour
    const diff = (h - tzHour + 24) % 24;
    const adjusted = new Date(estimate.getTime() + diff * 3600000);

    if (adjusted > now) return adjusted;
  }

  return null;
}

function detectRateLimit(text) {
  if (state.rateLimitDetected) return;
  const resetTime = parseResetTime(text);
  if (!resetTime) return;

  state.rateLimitDetected = true;
  state.rateLimitResetTime = resetTime;

  const resumeTime = new Date(resetTime.getTime() + 20000);
  const msg = `[Rate limit detected — session resets at ${resetTime.toLocaleString()} — will auto-resume ~20s after]`;
  pushControllerLine(msg);
  broadcast("controller", { line: msg });

  // Broadcast timer state to all clients immediately
  broadcast("ratelimit", {
    active: true,
    resetTime: resetTime.toISOString(),
    resumeTime: resumeTime.toISOString(),
  });
}

function doRateLimitResume(reason) {
  if (state.rateLimitTimer) { clearTimeout(state.rateLimitTimer); state.rateLimitTimer = null; }
  if (state.rateLimitBackupTimer) { clearInterval(state.rateLimitBackupTimer); state.rateLimitBackupTimer = null; }

  broadcast("ratelimit", { active: false });
  state.rateLimitDetected = false;
  state.rateLimitResetTime = null;
  state.rateLimitResumedAt = Date.now();

  // If the controller process is still alive (stdin pipe open), inject "Continue"
  // directly — no need to spawn a new process.
  if (sendToController("Continue")) {
    const resumeMsg = `[${reason} — sent Continue to live orchestrator]`;
    pushControllerLine(resumeMsg);
    broadcast("controller", { line: resumeMsg });
    state.lastControllerOutputAt = Date.now();
    state.watchdogNudges = 0;
    return;
  }

  // Controller exited — spawn a new one in continuation mode
  const resumeMsg = `[${reason} — spawning continuation orchestrator]`;
  pushControllerLine(resumeMsg);
  broadcast("controller", { line: resumeMsg });
  spawnController(
    state.goal,
    state.terminalCount,
    state.model,
    state.currentIteration,
    state.workerModel,
    state.workDir,
    true // continuationMode
  );
}

function startRateLimitTimer() {
  if (!state.rateLimitResetTime || state.rateLimitTimer) return;

  const resumeTime = new Date(state.rateLimitResetTime.getTime() + 20000);
  const delayMs = Math.max(resumeTime.getTime() - Date.now(), 5000);

  const timerMsg = `[Rate limit timer started — will resume at ${resumeTime.toLocaleString()}]`;
  pushControllerLine(timerMsg);
  broadcast("controller", { line: timerMsg });

  state.rateLimitTimer = setTimeout(() => {
    state.rateLimitTimer = null;
    doRateLimitResume("Rate limit reset");
  }, delayMs);

  // If the timer is set for more than 2 hours, the parsed reset time may be wrong
  // (e.g. a 24-hour countdown when the real reset is 5 hours away).
  // Set a backup that fires every 2 hours to attempt an early resume.
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  if (delayMs > TWO_HOURS_MS && !state.rateLimitBackupTimer) {
    const backupMsg = "[2-hour auto-retry enabled — will attempt early resume every 2h in case timer was parsed incorrectly]";
    pushControllerLine(backupMsg);
    broadcast("controller", { line: backupMsg });

    state.rateLimitBackupTimer = setInterval(() => {
      // Stop the interval if rate limit is no longer active or a run is underway
      if (!state.rateLimitDetected || state.running) {
        clearInterval(state.rateLimitBackupTimer);
        state.rateLimitBackupTimer = null;
        return;
      }
      doRateLimitResume("2-hour auto-retry");
    }, TWO_HOURS_MS);
  }
}

function cancelRateLimitTimer() {
  if (state.rateLimitTimer) {
    clearTimeout(state.rateLimitTimer);
    state.rateLimitTimer = null;
  }
  if (state.rateLimitBackupTimer) {
    clearInterval(state.rateLimitBackupTimer);
    state.rateLimitBackupTimer = null;
  }
  if (state.compactFallbackTimer) {
    clearTimeout(state.compactFallbackTimer);
    state.compactFallbackTimer = null;
  }
  state.onCompactComplete = null;
  state.rateLimitDetected = false;
  state.rateLimitResetTime = null;
  state.rateLimitResumedAt = null;

  broadcast("ratelimit", { active: false });

  // Stop workers and clean up
  try { runTmux("--stop-all"); } catch (_) {}
  stopPolling();
  state.running = false;
  state.sessions = [];

  const msg = "[Rate limit timer cancelled — work ended by user]";
  pushControllerLine(msg);
  broadcast("controller", { line: msg });
  broadcast("status", { running: false });
  broadcast("terminals", { sessions: [] });

  closeLog();
}

// --- Terminal polling ---

function pollTerminals() {
  try {
    const listOutput = runTmux("--list");
    const sessions = [];
    if (listOutput && !listOutput.includes("No active sessions")) {
      const lines = listOutput.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && trimmed !== "Active sessions:") {
          sessions.push(trimmed);
        }
      }
    }
    state.sessions = sessions;
    broadcast("terminals", { sessions });

    // Scan pane content for rate limit messages
    const resumeGrace = state.rateLimitResumedAt && (Date.now() - state.rateLimitResumedAt) < 120000;
    if (!state.rateLimitDetected && !resumeGrace && sessions.length > 0) {
      for (const name of sessions) {
        try {
          const paneContent = runTmux("--read", name);
          if (paneContent && /you'?ve hit your (rate )?limit/i.test(paneContent)) {
            detectRateLimit(paneContent);
            break;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
}

function startPolling() {
  if (state.pollInterval) return;
  state.pollInterval = setInterval(pollTerminals, POLL_INTERVAL_MS);
  pollTerminals();
}

function stopPolling() {
  if (state.pollInterval) {
    clearInterval(state.pollInterval);
    state.pollInterval = null;
  }
}

// --- Git clone helper ---

function cloneOrPullRepo(repoInput, targetDir) {
  let repoUrl = repoInput.trim();
  if (!repoUrl.startsWith("https://") && !repoUrl.startsWith("git@")) {
    repoUrl = `https://github.com/${repoUrl}`;
  }

  const urlObj = new URL(repoUrl);
  const slug = urlObj.pathname
    .replace(/^\//, "")
    .replace(/\.git$/, "")
    .replace(/\//g, "-");

  const resolvedDir = targetDir
    ? path.resolve(targetDir)
    : path.join(__dirname, "workspaces", slug);

  fs.mkdirSync(path.dirname(resolvedDir), { recursive: true });

  if (fs.existsSync(path.join(resolvedDir, ".git"))) {
    console.log(`[supervibes] Pulling latest in ${resolvedDir}`);
    try {
      execSync("git pull --ff-only", { cwd: resolvedDir, encoding: "utf-8", timeout: 60000 });
    } catch (e) {
      console.warn("[supervibes] git pull failed, using existing checkout:", e.message);
    }
  } else {
    console.log(`[supervibes] Cloning ${repoUrl} → ${resolvedDir}`);
    execSync(`git clone "${repoUrl}" "${resolvedDir}"`, { encoding: "utf-8", timeout: 120000 });
  }

  return resolvedDir;
}

// --- Controller process ---

function buildPrompt(goal, terminalCount, model, iteration, workerModel, workDir, continuationMode) {
  let terminalInstruction = "";
  if (terminalCount === "auto") {
    terminalInstruction = "Decide how many terminals to use based on the goal. If possible, operate in parallel to improve dev speed.";
  } else {
    terminalInstruction = `Use exactly ${terminalCount} terminal(s). Name them appropriately for the task.`;
  }

  const wModel = workerModel || model || "sonnet";
  const modelInstruction = `When launching Claude Code in each terminal, use: claude --dangerously-skip-permissions --model ${wModel}`;

  const workDirInstruction = workDir
    ? `\n\n## Working Directory\n\nThe project is located at:\n\n    ${workDir}\n\nWhen starting agent terminals, always pass this path as the working directory:\n\n    node ${TMUX_CONTROL} --start <name> "${workDir}"`
    : "";

  let goalSection = "";
  if (continuationMode) {
    goalSection = `## Rate Limit Recovery — Continue Previous Session

Your previous orchestration session was interrupted because Claude hit its API usage limits. The terminal workers may still be running in tmux sessions.

Your job now:
1. Use --list to check which terminals are still active
2. For each active terminal that was still working, send: "Continue the work you were doing when session limits were hit"
3. For terminals that are no longer active but were part of the original task, restart them and re-send their task
4. Continue coordinating until the original goal is complete

Original goal for context: ${goal}`;
  } else if (iteration === 0) {
    goalSection = `## Your Goal\n\n${goal}`;
  } else {
    goalSection = `## Iteration ${iteration} — Improvement Round

The project below was already built in a previous round. Your job now:

1. **Code review**: Open the project, read through the codebase, identify issues (bugs, code quality, missing error handling, UX problems, performance)
2. **Fix and improve**: Address the issues you found. Refactor where needed, fix bugs, improve code quality.
3. **Add 1 new feature**: Think about what would make this project better and add one meaningful new feature that fits naturally.
4. **Verify everything**: Run the project, test it works (including your new feature), ensure nothing is broken.

Original goal for context: ${goal}`;
  }

  // Include any queued user messages so the new orchestrator sees them immediately
  let messagesSection = "";
  if (state.pendingMessages.length > 0) {
    const msgList = state.pendingMessages.map(m => `- ${m.text}`).join("\n");
    messagesSection = `\n\n## User Instructions\n\nThe user sent the following instructions while the previous session was running. Please acknowledge and incorporate them:\n\n${msgList}`;
  }

  return `${SYSTEM_PROMPT}\n\n## Terminal count\n\n${terminalInstruction}\n\n## Model\n\n${modelInstruction}${workDirInstruction}\n\n${goalSection}${messagesSection}`;
}

// Build the short prompt for a follow-on improvement iteration.
// The controller already has the system prompt and full context in its window,
// so this only needs to describe what to do next.
function buildIterationPrompt(iteration, goal) {
  return `Great work — that phase is complete.

## Iteration ${iteration} — Improvement Round

Review the project you just built and improve it across four steps:
1. **Code review**: read through the codebase, identify bugs, code quality issues, missing error handling, UX problems, and performance opportunities
2. **Fix and improve**: address every issue you found — refactor, fix bugs, improve code quality
3. **Add 1 new feature**: choose something meaningful that fits naturally and implement it fully
4. **Verify everything**: run the project, confirm it works including your new feature, ensure nothing is broken

When you are completely done with all tasks and verification, output the marker ${COMPLETION_MARKER} on a line by itself.

Original goal for context: ${goal}`;
}

function spawnController(goal, terminalCount, model, iteration, workerModel, workDir, continuationMode) {
  const prompt = buildPrompt(goal, terminalCount, model, iteration || 0, workerModel, workDir, continuationMode || false);
  // Pending messages are now in the prompt — clear the queue
  state.pendingMessages = [];

  const env = Object.assign({}, process.env);
  delete env.CLAUDECODE;

  // Use --input-format stream-json so we can keep stdin open and inject
  // messages (user instructions, /compact, iteration prompts, Continue) at
  // any time without needing a TTY.  The process lives until we call
  // child.stdin.end(), giving us true multi-turn orchestration in one session.
  const child = spawn("claude", [
    "--dangerously-skip-permissions",
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model || "sonnet",
  ], {
    cwd: __dirname,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  state.controllerProcess = child;
  state.running = true;
  state.goal = goal;
  state.terminalCount = terminalCount;
  state.model = model || "sonnet";
  state.workerModel = workerModel || state.model;
  state.workDir = workDir || "";
  state.controllerOutput = [];
  state.sessions = [];
  state.onCompactComplete = null;
  if (state.compactFallbackTimer) { clearTimeout(state.compactFallbackTimer); state.compactFallbackTimer = null; }

  broadcast("status", { running: true, goal, terminalCount });

  if (state.logFilePath) {
    const logLine = `[Log: ${state.logFilePath}]`;
    pushControllerLine(logLine);
    broadcast("controller", { line: logLine });
  }

  if (continuationMode) {
    const contLine = "[Continuation mode — resuming after rate limit reset]";
    pushControllerLine(contLine);
    broadcast("controller", { line: contLine });
  }

  // Deliver the initial prompt (and any queued user messages) via stdin
  child.stdin.write(makeStreamJsonMsg(prompt));
  state.pendingMessages = [];  // already included in prompt via buildPrompt

  let lineBuf = "";

  const emitLine = (l) => {
    pushControllerLine(l);
    broadcast("controller", { line: l });
    checkForTextRateLimit(l);
    checkForCompletion(l);
  };

  const processJsonLine = (raw) => {
    if (!raw.trim()) return;
    try {
      const msg = JSON.parse(raw);

      // --- Rate limit event (reliable Unix timestamp, prefer over text parsing) ---
      if (msg.type === "rate_limit_event" && msg.rate_limit_info) {
        const info = msg.rate_limit_info;
        if (info.status !== "allowed" && info.resetsAt && !state.rateLimitDetected) {
          const resetTime = new Date(info.resetsAt * 1000);
          state.rateLimitDetected = true;
          state.rateLimitResetTime = resetTime;
          const resumeTime = new Date(resetTime.getTime() + 20000);
          const msg2 = `[Rate limit detected via event — session resets at ${resetTime.toLocaleString()} — will auto-resume ~20s after]`;
          pushControllerLine(msg2);
          broadcast("controller", { line: msg2 });
          broadcast("ratelimit", { active: true, resetTime: resetTime.toISOString(), resumeTime: resumeTime.toISOString() });
        }
        return;
      }

      // --- /compact lifecycle events ---
      if (msg.type === "system" && msg.subtype === "status" && msg.status === "compacting") {
        const compactingMsg = "[/compact: compacting conversation history...]";
        pushControllerLine(compactingMsg);
        broadcast("controller", { line: compactingMsg });
        return;
      }
      if (msg.type === "system" && msg.subtype === "compact_boundary") {
        const preTokens = msg.compact_metadata && msg.compact_metadata.pre_tokens;
        const boundaryMsg = `[/compact complete — context reduced${preTokens ? ` (was ${preTokens.toLocaleString()} tokens)` : ""}]`;
        pushControllerLine(boundaryMsg);
        broadcast("controller", { line: boundaryMsg });
        // Fire the pending iteration callback now that compaction is confirmed done
        if (state.compactFallbackTimer) { clearTimeout(state.compactFallbackTimer); state.compactFallbackTimer = null; }
        if (state.onCompactComplete) { const cb = state.onCompactComplete; state.onCompactComplete = null; cb(); }
        return;
      }

      // --- Normal output ---
      let line = null;
      if (msg.type === "assistant" && msg.message) {
        const content = msg.message.content || [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            line = block.text;
          } else if (block.type === "tool_use") {
            const input = block.input || {};
            line = input.command ? "$ " + input.command : "[tool: " + block.name + "]";
          }
          if (line) { for (const l of line.split("\n")) { emitLine(l); } line = null; }
        }
      } else if (msg.type === "result" && msg.result) {
        const text = typeof msg.result === "string" ? msg.result : (msg.result.text || "");
        if (text) { for (const l of text.split("\n")) { emitLine(l); } }
      } else if (msg.type === "content_block_delta" && msg.delta) {
        const text = msg.delta.text || "";
        if (text) { for (const l of text.split("\n")) { if (l) emitLine(l); } }
      }
    } catch (_) {
      emitLine(raw);
    }
  };

  // Fallback text-based rate limit detection (catches messages in assistant text)
  const checkForTextRateLimit = (text) => {
    if (!state.rateLimitDetected &&
        (/you'?ve hit your (rate )?limit/i.test(text) || /resets\s+\d+[:\d]*[ap]m\s*\(/i.test(text))) {
      detectRateLimit(text);
    }
  };

  // When the orchestrator signals it finished a phase, send /compact then the
  // next iteration prompt (or close stdin if all iterations are done).
  const checkForCompletion = (text) => {
    if (!text.includes(COMPLETION_MARKER)) return;
    if (state.stopped) return;

    if (state.currentIteration < state.iterations) {
      state.currentIteration++;
      const iterMsg = `\n--- Iteration ${state.currentIteration} of ${state.iterations} starting ---\n`;
      pushControllerLine(iterMsg);
      broadcast("controller", { line: iterMsg });
      broadcast("status", { running: true, currentIteration: state.currentIteration, iterations: state.iterations });

      const compactMsg = "[Sending /compact to reduce context before next iteration]";
      pushControllerLine(compactMsg);
      broadcast("controller", { line: compactMsg });
      sendToController("/compact");

      // Fire when compact_boundary event arrives — no polling, no guessing
      state.onCompactComplete = () => {
        if (state.stopped || !state.controllerProcess) return;
        state.watchdogNudges = 0;
        state.lastControllerOutputAt = Date.now();
        sendToController(buildIterationPrompt(state.currentIteration, state.goal));
      };
      // 30s fallback in case compact_boundary never arrives
      state.compactFallbackTimer = setTimeout(() => {
        state.compactFallbackTimer = null;
        if (state.onCompactComplete) {
          const fallbackMsg = "[/compact: no compact_boundary event — proceeding after 30s fallback]";
          pushControllerLine(fallbackMsg);
          broadcast("controller", { line: fallbackMsg });
          const cb = state.onCompactComplete; state.onCompactComplete = null; cb();
        }
      }, 30000);

    } else {
      const doneMsg = "[All tasks complete — closing orchestrator session]";
      pushControllerLine(doneMsg);
      broadcast("controller", { line: doneMsg });
      try { child.stdin.end(); } catch (_) {}
    }
  };

  const handleStdout = (chunk) => {
    state.lastControllerOutputAt = Date.now();
    state.watchdogNudges = 0;
    lineBuf += chunk.toString();
    const parts = lineBuf.split("\n");
    lineBuf = parts.pop();
    for (const line of parts) { processJsonLine(line); }
  };

  const handleStderr = (chunk) => {
    state.lastControllerOutputAt = Date.now();
    state.watchdogNudges = 0;
    const text = stripAnsi(chunk.toString());
    for (const line of text.split("\n")) {
      if (line.trim()) {
        pushControllerLine(line);
        broadcast("controller", { line });
        checkForTextRateLimit(line);
      }
    }
  };

  child.stdout.on("data", handleStdout);
  child.stderr.on("data", handleStderr);

  child.on("exit", (code) => {
    stopWatchdog();
    if (state.compactFallbackTimer) { clearTimeout(state.compactFallbackTimer); state.compactFallbackTimer = null; }
    state.onCompactComplete = null;
    if (lineBuf.length > 0) { processJsonLine(lineBuf); lineBuf = ""; }
    state.controllerProcess = null;
    stopPolling();

    // If rate limit detected and not manually stopped, start the recovery timer
    if (state.rateLimitDetected && !state.stopped) {
      const exitLine = `[Controller exited (code ${code}) — rate limit recovery timer started]`;
      pushControllerLine(exitLine);
      broadcast("controller", { line: exitLine });
      startRateLimitTimer();
      return;
    }

    try { runTmux("--stop-all"); } catch (_) {}
    state.sessions = [];
    broadcast("terminals", { sessions: [] });

    state.running = false;
    const reason = state.stopped ? "Stopped by user" : `Controller exited (code ${code})`;
    pushControllerLine(`\n[${reason}]`);
    broadcast("controller", { line: `\n[${reason}]` });
    if (state.iterations > 0 && !state.stopped) {
      pushControllerLine(`[Completed ${state.currentIteration} of ${state.iterations} iteration(s)]`);
      broadcast("controller", { line: `[Completed ${state.currentIteration} of ${state.iterations} iteration(s)]` });
    }
    broadcast("status", { running: false });
    state.stopped = false;
    closeLog();
  });

  startPolling();
  startWatchdog();
}

function stopController() {
  state.stopped = true;

  // Cancel any pending rate limit timers
  if (state.rateLimitTimer) {
    clearTimeout(state.rateLimitTimer);
    state.rateLimitTimer = null;
    broadcast("ratelimit", { active: false });
  }
  if (state.rateLimitBackupTimer) {
    clearInterval(state.rateLimitBackupTimer);
    state.rateLimitBackupTimer = null;
  }
  state.rateLimitDetected = false;
  state.rateLimitResetTime = null;

  // Cancel any pending /compact callback and fallback timer
  if (state.compactFallbackTimer) {
    clearTimeout(state.compactFallbackTimer);
    state.compactFallbackTimer = null;
  }
  state.onCompactComplete = null;

  stopWatchdog();

  if (state.controllerProcess) {
    // Ask the process to exit cleanly by closing stdin first
    try { state.controllerProcess.stdin.end(); } catch (_) {}
    state.controllerProcess.kill("SIGTERM");
    setTimeout(() => {
      if (state.controllerProcess) {
        try { state.controllerProcess.kill("SIGKILL"); } catch (_) {}
      }
    }, 3000);
  }
  try { runTmux("--stop-all"); } catch (_) {}
  stopPolling();
  state.running = false;
  state.sessions = [];

  broadcast("status", { running: false });
  broadcast("terminals", { sessions: [] });

  closeLog();
}

// --- HTTP Server ---

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch (_) { resolve({}); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // --- API Routes ---

  if (pathname === "/api/start" && req.method === "POST") {
    if (state.running || state.rateLimitTimer) {
      return sendJson(res, 400, { error: "Already running" });
    }
    const body = await parseBody(req);
    const goal = (body.goal || "").trim();
    if (!goal) {
      return sendJson(res, 400, { error: "Goal is required" });
    }
    const terminalCount = body.terminalCount === "auto" || !body.terminalCount
      ? "auto"
      : parseInt(body.terminalCount, 10);
    const model = body.model || "sonnet";
    const workerModel = body.workerModel || model;
    const iterations = Math.min(Math.max(parseInt(body.iterations) || 0, 0), 5);

    // Resolve working directory (clone GitHub repo if provided)
    let workDir = (body.workDir || "").trim();
    const githubRepo = (body.githubRepo || "").trim();
    if (githubRepo) {
      try {
        workDir = cloneOrPullRepo(githubRepo, workDir || undefined);
      } catch (err) {
        return sendJson(res, 500, { error: "Git clone failed: " + err.message });
      }
    }

    state.iterations = iterations;
    state.currentIteration = 0;
    state.stopped = false;
    state.githubRepo = githubRepo;

    // Open log file for this run
    const logPath = openLog(workDir || "", goal, githubRepo, terminalCount, model, workerModel, iterations);

    spawnController(goal, terminalCount, model, 0, workerModel, workDir);
    return sendJson(res, 200, { ok: true, workDir, logPath });
  }

  if (pathname === "/api/stop" && req.method === "POST") {
    stopController();
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/cancel-timer" && req.method === "POST") {
    if (!state.rateLimitTimer && !state.rateLimitDetected) {
      return sendJson(res, 400, { error: "No active rate limit timer" });
    }
    cancelRateLimitTimer();
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/send-message" && req.method === "POST") {
    const body = await parseBody(req);
    const message = (body.message || "").trim();
    if (!message) return sendJson(res, 400, { error: "Message is required" });

    const delivered = sendToController(message);

    if (delivered) {
      // Message went straight into the live conversation
      const displayLine = `[User → orchestrator: ${message}]`;
      pushControllerLine(displayLine);
      broadcast("controller", { line: displayLine });
      // A user message is fresh output — reset the watchdog
      state.lastControllerOutputAt = Date.now();
      state.watchdogNudges = 0;
    } else {
      // No live controller — queue for the next spawn
      state.pendingMessages.push({ text: message, time: new Date() });
      const displayLine = `[User message queued: ${message}]`;
      pushControllerLine(displayLine);
      broadcast("controller", { line: displayLine });
    }

    return sendJson(res, 200, { ok: true, delivered });
  }

  if (pathname === "/api/shutdown" && req.method === "POST") {
    if (state.running) stopController();
    sendJson(res, 200, { ok: true });
    setTimeout(() => {
      console.log("[supervibes] Shutdown requested via web UI — exiting.");
      process.exit(0);
    }, 400);
    return;
  }

  if (pathname === "/api/status" && req.method === "GET") {
    return sendJson(res, 200, {
      running: state.running,
      goal: state.goal,
      terminalCount: state.terminalCount,
      model: state.model,
      workerModel: state.workerModel,
      githubRepo: state.githubRepo,
      workDir: state.workDir,
      iterations: state.iterations,
      currentIteration: state.currentIteration,
      sessions: state.sessions,
      logFilePath: state.logFilePath,
      rateLimitActive: !!state.rateLimitTimer,
      rateLimitResetTime: state.rateLimitResetTime ? state.rateLimitResetTime.toISOString() : null,
    });
  }

  if (pathname === "/api/stream" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    state.sseClients.push(res);

    const resumeTime = state.rateLimitResetTime
      ? new Date(state.rateLimitResetTime.getTime() + 20000).toISOString()
      : null;

    const initData = {
      running: state.running,
      goal: state.goal,
      terminalCount: state.terminalCount,
      model: state.model,
      workerModel: state.workerModel,
      githubRepo: state.githubRepo,
      workDir: state.workDir,
      iterations: state.iterations,
      currentIteration: state.currentIteration,
      controllerOutput: state.controllerOutput,
      sessions: state.sessions,
      logFilePath: state.logFilePath,
      rateLimitActive: !!state.rateLimitTimer,
      rateLimitResetTime: state.rateLimitResetTime ? state.rateLimitResetTime.toISOString() : null,
      rateLimitResumeTime: resumeTime,
    };
    res.write(`event: init\ndata: ${JSON.stringify(initData)}\n\n`);

    req.on("close", () => {
      const idx = state.sseClients.indexOf(res);
      if (idx !== -1) state.sseClients.splice(idx, 1);
    });
    return;
  }

  // --- Static Files ---

  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch (_) {
    res.writeHead(404);
    res.end("Not Found");
  }
});

// --- Port conflict helpers ---

function getPortOwnerPid(port) {
  try {
    const out = execSync(`fuser ${port}/tcp 2>/dev/null`, { encoding: "utf-8" });
    return out.trim().split(/\s+/)[0] || null;
  } catch (_) { return null; }
}

function isOwnProcess(pid) {
  try {
    const cmd = execSync(`ps -p ${pid} -o args=`, { encoding: "utf-8" }).trim();
    return cmd.includes("server.cjs");
  } catch (_) { return false; }
}

function startListening() {
  server.listen(PORT, () => {
    console.log(`Dashboard: http://localhost:${PORT}`);
  });
}

server.on("error", (err) => {
  if (err.code !== "EADDRINUSE") throw err;

  const pid = getPortOwnerPid(PORT);
  const isOwn = pid && isOwnProcess(pid);

  if (!isOwn) {
    console.error(
      `[supervibes] Port ${PORT} is in use by another process` +
      (pid ? ` (PID ${pid})` : "") + `.\n` +
      `  Run on a different port:  PORT=3457 node server.cjs`
    );
    process.exit(1);
  }

  console.warn(
    `\n[supervibes] A previous server is already running on port ${PORT} (PID ${pid}).` +
    `\n  It may have an active orchestration run in progress.`
  );

  if (!process.stdin.isTTY) {
    console.error(
      `  Cannot prompt in non-interactive mode.\n` +
      `  Stop PID ${pid} manually, or set PORT=<other> to use a different port.`
    );
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("  Kill it and start fresh? [y/N] ", (answer) => {
    rl.close();
    if (answer.trim().toLowerCase() === "y") {
      try { execSync(`kill ${pid}`); } catch (_) {}
      setTimeout(startListening, 1500);
    } else {
      console.log(
        "  Exiting. Stop the other server first, or run:\n" +
        `    PORT=3457 node server.cjs`
      );
      process.exit(0);
    }
  });
});

startListening();
