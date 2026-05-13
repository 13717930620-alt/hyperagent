# JingxuanAgent — Open-Source AI Agent Framework

> **I am a Chinese lawyer who loves AI. I don't know how to code.**
>
> This project is 30,000+ lines of code, 60+ modules, and 45+ built-in tools — all built by talking to Claude.
> If a lawyer can build this without writing a single line of code manually, imagine what *we* can do together.
>
> **Everyone is welcome. Let's make this a true intelligent agent.**

---

## What Is This?

JingxuanAgent is an open-source framework that gives your computer its own AI agent. Tell it what you want, and it makes it happen.

```
You say: "Organize my desktop files by type into folders"
→ JingxuanAgent: Scans desktop → Identifies file types → Creates folders → Moves files → Reports results
```

It works with DeepSeek, GLM, Qwen, MiniMax, or entirely offline using its built-in engine.

---

## Quick Start

```bash
npm install
cp .env.example .env     # Optional — built-in model works without it
node JingxuanAgent_Main.js
```

Then just talk to it: "Check my CPU usage" or "Create a file called test.txt"

---

## Features

| Feature | Description |
|---------|-------------|
| **File Operations** | Read, write, edit, search, copy, move, delete |
| **Command Execution** | cmd / PowerShell with safety restrictions |
| **System Control** | Process manager, clipboard, notifications, power management |
| **Browser Automation** | Puppeteer-powered |
| **Desktop GUI** | Mouse, keyboard, screenshot |
| **Code Tools** | Diff/Apply patches, AST analysis, LSP intelligence |
| **Memory System** | 4-layer memory (L0→L1→L2→L3) + semantic search |
| **Self-Learning** | Continuously learns user habits and system patterns |
| **Multi-LLM** | DeepSeek / GLM / Qwen / MiniMax / Built-in engine |
| **Remote Access** | Public tunnel — use it from anywhere |
| **Security** | 5-level authorization, dangerous operations require confirmation |
| **MCP Protocol** | Model Context Protocol compatible |

---

## Project Structure

```
JingxuanAgent/
├── JingxuanAgent_Main.js          # Entry point
├── JingxuanAgent_Config.js        # Configuration
├── JingxuanAgent_Learning.js      # Self-learning system
├── JingxuanAgent_Core/            # Core system
│   ├── cc_mode/                # Query engine + tool system
│   ├── cognitive_core/         # Cognitive framework (reasoning/evolution/patterns)
│   ├── llm_adapter/            # 5 LLM adapters
│   └── infra/                  # Infrastructure (logging/storage/security)
├── JingxuanAgent_Implementation/  # Implementation layer
│   ├── conversation/           # Conversation engine
│   ├── orchestrator/           # Task orchestration + checkpoints
│   ├── atomic_executor/        # Tool executor + code tools
│   ├── memory_engine/          # Memory engine + vector search
│   └── device_abstraction/     # Device abstraction + safety engine
├── docs/                       # Documentation
├── tests/                      # Tests
└── web/                        # Web console
```

---

## Why I Built This

I am a lawyer. My job is words, not code. But I believe AI agents will change everything — how we work, how we create, how we solve problems.

I didn't want to wait for someone else to build the agent I dreamed of. So I used AI to build it myself.

**If I can do this, anyone can. And if everyone contributes, this can become something truly remarkable.**

---

## How You Can Help

I don't know how to code, so there is a lot of room for improvement:

- Fix bugs and optimize code
- Add new tools and features
- Improve documentation
- Port to more platforms
- Write tests
- Anything you think would make it better

Just open an Issue or submit a PR. **This project belongs to everyone.**

---

## License

MIT License — use it, modify it, share it.

---

> **A Chinese lawyer who cannot code built this with AI.**
> **There is nothing you cannot do if you really want to.**
