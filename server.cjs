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
2. Start ALL terminals at once with descriptive names (e.g. "ui", "api", "tests")
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

ALWAYS default to running multiple terminals in parallel. Speed is the priority. Start all terminals upfront and give each one its task immediately — do NOT wait for one to finish before starting the next.

There are NO conflicts as long as your instructions to each terminal are precise about what files and directories it owns. This is easy — just be explicit in every prompt.

**How to split work:**
- Give each terminal a distinct area (e.g. "ui" owns src/components/, "api" owns src/api/, "tests" only reads and runs tests)
- In each prompt, state exactly: "You own <directory>. Do NOT create or edit files outside this directory."
- Start ALL terminals at once and send their tasks immediately
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
- Start ALL terminals at once and send tasks immediately, don't serialize unnecessarily
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
};

// --- Helpers ---

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

function startRateLimitTimer() {
  if (!state.rateLimitResetTime || state.rateLimitTimer) return;

  const resumeTime = new Date(state.rateLimitResetTime.getTime() + 20000);
  const delayMs = Math.max(resumeTime.getTime() - Date.now(), 5000);

  const timerMsg = `[Rate limit timer started — will resume at ${resumeTime.toLocaleString()}]`;
  pushControllerLine(timerMsg);
  broadcast("controller", { line: timerMsg });

  state.rateLimitTimer = setTimeout(() => {
    state.rateLimitTimer = null;

    const resumeMsg = "[Rate limit reset — spawning new orchestrator to continue work...]";
    pushControllerLine(resumeMsg);
    broadcast("controller", { line: resumeMsg });
    broadcast("ratelimit", { active: false });

    // Spawn new controller in continuation mode
    state.rateLimitDetected = false;
    state.rateLimitResetTime = null;
    spawnController(
      state.goal,
      state.terminalCount,
      state.model,
      state.currentIteration,
      state.workerModel,
      state.workDir,
      true // continuationMode
    );
  }, delayMs);
}

function cancelRateLimitTimer() {
  if (state.rateLimitTimer) {
    clearTimeout(state.rateLimitTimer);
    state.rateLimitTimer = null;
  }
  state.rateLimitDetected = false;
  state.rateLimitResetTime = null;

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
    if (!state.rateLimitDetected && sessions.length > 0) {
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

  return `${SYSTEM_PROMPT}\n\n## Terminal count\n\n${terminalInstruction}\n\n## Model\n\n${modelInstruction}${workDirInstruction}\n\n${goalSection}`;
}

function spawnController(goal, terminalCount, model, iteration, workerModel, workDir, continuationMode) {
  const prompt = buildPrompt(goal, terminalCount, model, iteration || 0, workerModel, workDir, continuationMode || false);

  const env = Object.assign({}, process.env);
  delete env.CLAUDECODE;

  const child = spawn("claude", [
    "--dangerously-skip-permissions",
    "-p", prompt,
    "--model", model || "sonnet",
    "--output-format", "stream-json",
    "--verbose",
  ], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
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

  broadcast("status", { running: true, goal, terminalCount });

  // Emit log file path as first line so UI and log both show it
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

  let lineBuf = "";

  const processJsonLine = (raw) => {
    if (!raw.trim()) return;
    try {
      const msg = JSON.parse(raw);
      let line = null;

      if (msg.type === "assistant" && msg.message) {
        const content = msg.message.content || [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            line = block.text;
          } else if (block.type === "tool_use") {
            const input = block.input || {};
            if (input.command) {
              line = "$ " + input.command;
            } else {
              line = "[tool: " + block.name + "]";
            }
          }
          if (line) {
            for (const l of line.split("\n")) {
              pushControllerLine(l);
              broadcast("controller", { line: l });
              checkForRateLimit(l);
            }
            line = null;
          }
        }
      } else if (msg.type === "result" && msg.result) {
        const text = typeof msg.result === "string" ? msg.result : (msg.result.text || "");
        if (text) {
          for (const l of text.split("\n")) {
            pushControllerLine(l);
            broadcast("controller", { line: l });
            checkForRateLimit(l);
          }
        }
      } else if (msg.type === "content_block_delta" && msg.delta) {
        const text = msg.delta.text || "";
        if (text) {
          for (const l of text.split("\n")) {
            if (l) {
              pushControllerLine(l);
              broadcast("controller", { line: l });
              checkForRateLimit(l);
            }
          }
        }
      }
    } catch (_) {
      // Not valid JSON, emit raw
      pushControllerLine(raw);
      broadcast("controller", { line: raw });
      checkForRateLimit(raw);
    }
  };

  const checkForRateLimit = (text) => {
    if (!state.rateLimitDetected &&
        (/you'?ve hit your (rate )?limit/i.test(text) || /resets\s+\d+[:\d]*[ap]m\s*\(/i.test(text))) {
      detectRateLimit(text);
    }
  };

  const handleStdout = (chunk) => {
    lineBuf += chunk.toString();
    const parts = lineBuf.split("\n");
    lineBuf = parts.pop();
    for (const line of parts) {
      processJsonLine(line);
    }
  };

  const handleStderr = (chunk) => {
    const text = stripAnsi(chunk.toString());
    for (const line of text.split("\n")) {
      if (line.trim()) {
        pushControllerLine(line);
        broadcast("controller", { line });
        checkForRateLimit(line);
      }
    }
  };

  child.stdout.on("data", handleStdout);
  child.stderr.on("data", handleStderr);

  child.on("exit", (code) => {
    // Flush remaining buffer
    if (lineBuf.length > 0) {
      processJsonLine(lineBuf);
      lineBuf = "";
    }
    state.controllerProcess = null;
    stopPolling();

    // If rate limit was detected, don't stop workers — start the resume timer
    if (state.rateLimitDetected && !state.stopped) {
      const exitLine = `[Controller exited with code ${code} — rate limit recovery timer started]`;
      pushControllerLine(exitLine);
      broadcast("controller", { line: exitLine });
      // Keep workers alive; start timer to resume
      startRateLimitTimer();
      return;
    }

    // Normal exit: clean up tmux sessions
    try { runTmux("--stop-all"); } catch (_) {}
    state.sessions = [];
    broadcast("terminals", { sessions: [] });

    // Check if we should start the next iteration
    if (code === 0 && state.currentIteration < state.iterations && !state.stopped) {
      state.currentIteration++;
      const iterMsg = `\n--- Iteration ${state.currentIteration} of ${state.iterations} starting ---\n`;
      pushControllerLine(iterMsg);
      broadcast("controller", { line: iterMsg });
      broadcast("status", { running: true, currentIteration: state.currentIteration, iterations: state.iterations });

      setTimeout(() => {
        spawnController(state.goal, state.terminalCount, state.model, state.currentIteration, state.workerModel, state.workDir);
      }, 2000);
    } else {
      state.running = false;
      const reason = state.stopped ? "Stopped by user" : `Controller exited with code ${code}`;
      pushControllerLine(`\n[${reason}]`);
      broadcast("controller", { line: `\n[${reason}]` });
      if (state.iterations > 0 && code === 0 && !state.stopped) {
        pushControllerLine(`[All ${state.iterations} iteration(s) complete]`);
        broadcast("controller", { line: `[All ${state.iterations} iteration(s) complete]` });
      }
      broadcast("status", { running: false });
      state.stopped = false;
      closeLog();
    }
  });

  startPolling();
}

function stopController() {
  state.stopped = true;

  // Cancel any pending rate limit timer
  if (state.rateLimitTimer) {
    clearTimeout(state.rateLimitTimer);
    state.rateLimitTimer = null;
    broadcast("ratelimit", { active: false });
  }
  state.rateLimitDetected = false;
  state.rateLimitResetTime = null;

  if (state.controllerProcess) {
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
