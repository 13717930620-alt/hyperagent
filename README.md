# JX-Agent — Open-Source AI Agent Framework

<div align="center">

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/JX-Agent/JX-Agent/pulls)
[![GitHub stars](https://img.shields.io/github/stars/JX-Agent/JX-Agent?style=social)](https://github.com/JX-Agent/JX-Agent)

</div>

> **I am a Chinese lawyer who loves AI. I don't know how to code.**
>
> I used publicly available AI coding assistants to translate my vision of what a true intelligent agent should be into a working framework.
>
> This is a skeleton — a foundation. I am opening it up so that everyone who shares this vision can come together and make it real.
>
> **Everyone is welcome.**

---

## What Is This?

JX-Agent is an open-source framework that gives your computer its own AI agent. Tell it what you want, and it makes it happen.

```
You say: "Organize my desktop files by type into folders"
→ JX-Agent: Scans desktop → Identifies file types → Creates folders → Moves files → Reports results
```

It works with DeepSeek, GLM, Qwen, MiniMax, or entirely offline using its built-in engine.

---

## Quick Start

```bash
npm install
cp .env.example .env     # Optional — built-in model works without it
node HyperAgent_Main.js
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
JX-Agent/
├── HyperAgent_Main.js             # Entry point
├── HyperAgent_Config.js           # Configuration
├── HyperAgent_Learning.js         # Self-learning system
├── HyperAgent_Core/               # Core system
│   ├── cc_mode/                   # Query engine + tool system
│   ├── cognitive_core/            # Cognitive framework
│   ├── llm_adapter/               # 5 LLM adapters
│   └── infra/                     # Infrastructure
├── HyperAgent_Implementation/     # Implementation layer
│   ├── conversation/              # Conversation engine
│   ├── orchestrator/              # Task orchestration
│   ├── atomic_executor/           # Tool executor
│   ├── memory_engine/             # Memory + vector search
│   └── device_abstraction/        # Device abstraction + security
├── HyperAgent_Monitoring/         # Metrics and logging
├── services/                      # Web search, config, tunnel
├── extensions/                    # Productivity extensions
├── docs/                          # Documentation
├── 安装程序.bat                   # Windows setup script
├── 启动命令行.bat                 # CLI mode launcher
├── 启动网页版.bat                 # Web UI launcher
└── .github/                       # Issue templates & CI
```

---

## The Four Pillars — Core Framework Challenges

This skeleton implements basic scaffolding for four critical systems. Each one needs **your genius ideas and creativity** to become truly intelligent:

### 🧠 Pillar 1: Fully Intrinsic (完全内在)

The agent must be completely self-contained — no cloud dependency, no API key required, no external model needed. It should think, reason, and act using only its own built-in engine.

**What needs your brilliance:**
- A truly capable local reasoning engine that rivals cloud LLMs
- Zero external dependency architecture — everything ships in one package
- On-device intelligence that improves without phoning home
- Resource-efficient models that run on any hardware

### 🔄 Pillar 2: Auto-Evolution (自动进化)

The agent must grow smarter every single day. It should learn from every task, every mistake, every interaction — and never make the same error twice.

**What needs your brilliance:**
- Self-modifying code that improves its own algorithms
- Experience databases that distill raw history into wisdom
- Meta-cognitive systems that reflect on and optimize their own thinking
- Cross-session memory that compounds knowledge over months

### 🔍 Pillar 3: Anti-Hallucination (防止幻想)

An agent that confidently does the wrong thing is worse than one that does nothing. The agent must know what it knows, recognize what it doesn't, and verify everything before acting.

**What needs your brilliance:**
- Truth-anchoring mechanisms that separate inference from fact
- Self-verification loops that challenge every conclusion
- Uncertainty quantification — the agent must say "I don't know"
- Adversarial validation that stress-tests its own outputs

### 🛡️ Pillar 4: Security System (安全体系)

An agent with device control is powerful — and dangerous. The security model must be ironclad, transparent, and adaptive.

**What needs your brilliance:**
- Multi-level authorization that adapts to context and risk
- Sandboxed execution that contains damage from any single failure
- Behavioral anomaly detection — the agent watches itself for compromise
- Transparent audit trails that make every action explainable

---

## The Vision: A True Intelligent Agent Robot

I believe a true intelligent agent robot should possess:

| Capacity | Meaning |
|----------|---------|
| **Understand** | Natural language, goals, and context — not just commands |
| **Plan** | Decompose complex objectives into executable steps |
| **Execute** | Take safe, real action on any device |
| **Remember** | Store everything it has experienced, retrieve what matters |
| **Learn** | Extract patterns from success and failure |
| **Evolve** | Rewrite its own capabilities over time |
| **Collaborate** | Work with humans and other agents as a team |
| **Verify** | Challenge its own conclusions before acting |
| **Contain** | Operate within strict security boundaries by design |

These nine capacities define the framework's roadmap. Each one is a moonshot. No single person — especially not a lawyer who cannot code — can build them alone.

**That is why this project needs you.**

---

## How You Can Help

I don't know how to code, so **every part of this codebase needs improvement**:

### 🎯 High-Impact Areas

- **Bring your ideas** — If you have a brilliant approach to any of the Four Pillars above, open an Issue or submit a PR. Revolutionary ideas are welcome here.
- **Fix bugs and optimize** — The code was generated by AI assistants. It needs human eyes. Make it faster, cleaner, more reliable.
- **Add new tools and capabilities** — Extend what the agent can do. Browser automation, code analysis, device control — anything goes.
- **Improve the built-in AI engine** — Make the local model smarter, faster, more capable. This is the heart of the system.
- **Write tests** — Help us know the framework actually works. Start with unit tests, build toward integration tests.
- **Port to more platforms** — Linux, macOS, embedded devices, mobile. This skeleton needs to run everywhere.
- **Improve documentation** — Clear docs attract contributors. Better docs = better contributions.
- **Architectural innovation** — If you see a better way to structure the whole system, propose it. This is a skeleton — bones can be rearranged.

### 🤝 How to Participate

1. **Open an Issue** — Bug report, feature request, architectural idea, or just a question
2. **Submit a PR** — Code speaks louder than words
3. **Fork it** — Build your own vision on this foundation
4. **Share it** — The more minds, the better the result

This project is not "mine." It belongs to everyone who wants to see intelligent agents become real. **Your genius idea could be the breakthrough this skeleton needs.**

---

## The Story Behind This

I am a lawyer. I spend my days reading, writing, and reasoning with words — not code.

But I have always believed that a truly intelligent machine should be more than a chatbot. It should be able to **see** your computer, **understand** what you need, **plan** how to do it, and **execute** the task with its own hands (or rather, its own tools). It should learn from experience, remember what it has learned, and grow smarter over time.

I couldn't write a single line of code to make this real. So I used AI coding assistants — the same tools available to anyone — to describe my vision, piece by piece, and let them help me build it.

This is not a finished product. This is a **framework** — a skeleton — that captures my understanding of what an intelligent agent should be. The muscles, the nerves, the skin — those are for the community to add.

---

## Version

**Current release: v5.2.0** — This is an early-stage skeleton. The architecture is foundational and every component is open for rethinking. See the [Releases page](https://github.com/JX-Agent/JX-Agent/releases) for changelog.

---

## License

MIT License — use it, modify it, share it. Free for everyone, forever.

---

> **A Chinese lawyer who cannot code built the skeleton.**
> **Now the world can breathe life into it.**
