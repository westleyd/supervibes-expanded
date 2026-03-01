# How Nested Claude Code Works

## The Simple Version

You give a goal to Claude Code. Instead of doing the work itself, it spins up multiple other Claude Code instances and tells each one what to build. They all work at the same time.

## Step By Step

**1. You type a goal**

"Build me a weather app with a React frontend and Express backend"

**2. A controller Claude Code starts**

This is a regular Claude Code instance, but its instructions say: "You're a tech lead. Don't write code. Delegate everything."

**3. The controller breaks the goal into pieces**

It thinks: "I need someone on the frontend, someone on the backend, someone on the database, and someone to write tests."

**4. The controller opens terminals**

It runs shell commands to create tmux sessions. Each one opens as a real Terminal window on your screen.

**5. The controller launches Claude Code in each terminal**

Now there are 4 independent Claude Code instances running, each in its own terminal. They have no idea they were started by another Claude Code.

**6. The controller sends each one a task**

- Terminal "ui": "Build React components in src/components/. You own this folder only."
- Terminal "api": "Build Express routes in src/api/. You own this folder only."
- Terminal "db": "Set up the database in src/db/. You own this folder only."
- Terminal "tests": "Write tests. Don't edit any source files."

Each terminal gets one job with clear boundaries so they don't step on each other's files.

**7. They all work in parallel**

All 4 Claude Code instances are coding simultaneously. The controller checks in on each one periodically by reading their terminal output.

**8. The controller verifies everything works**

Once everyone's done, the controller runs the project, checks for errors, and makes sure it actually works.

**9. Done**

The controller shuts down all the terminals and reports back.

## How They Talk To Each Other

They don't. Not directly.

The controller "talks" to each child by literally typing into its terminal (tmux send-keys). It "listens" by reading what's on the terminal screen (tmux capture-pane). It's the same as if you had 4 terminals open and were copy-pasting instructions into each one — just automated.

## Why It's Fast

One Claude Code instance works on one thing at a time. Four instances work on four things at once. If a project takes 10 minutes with one instance, splitting it across 4 can get it done in closer to 3.

## The Trick That Makes It Possible

Claude Code normally won't start inside another Claude Code session — it detects the parent and blocks it. The system works around this by unsetting the environment variable (`CLAUDECODE`) that triggers this check. Each child runs in an isolated tmux session, so from its perspective, it's a fresh standalone Claude Code.
