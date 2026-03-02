# SUBARU — Local AI Assistant Agent

A fully local, agentic AI assistant that runs on your machine. Subaru receives requests from multiple interfaces (CLI, Web Dashboard, Telegram), reasons about what to do using an LLM, executes tasks through a modular tool system, and returns results back to you autonomously.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment template and configure
cp .env.example .env

# Start Subaru
npm start
```

Subaru will start with the default configuration using Ollama as the LLM provider. Make sure Ollama is running locally with a model pulled:

```bash
ollama pull llama3
ollama serve
```

Then visit **http://localhost:3131** for the web dashboard, or use the CLI directly.

## Configuration

Edit `subaru.config.json` to customize:

- **LLM Provider**: Switch between `ollama`, `openai`, or `anthropic`
- **Interfaces**: Enable/disable CLI, Web Dashboard, or Telegram bot
- **Tools**: Configure allowed paths, blocked commands, timeouts
- **Memory**: Adjust conversation history limits and vector similarity
- **Safety**: Toggle command confirmation and sandboxing

Environment variables in `.env` override config file values for sensitive data like API keys.

### Web Authentication

Set `WEB_AUTH_PASSWORD` in `.env` to protect the web dashboard with a password. Leave blank to disable.

### Speech-to-Text

Telegram voice messages are transcribed via any OpenAI-compatible Whisper endpoint. Configure `STT_API_URL`, `STT_API_KEY`, and `STT_MODEL` in `.env`. Supports Groq (free), OpenAI, or local whisper.cpp.

## Interfaces

### CLI
Interactive terminal REPL with streaming responses and tool event display. Slash commands:
- `/clear` — Clear conversation
- `/history` — Show recent turns
- `/config` — Show configuration
- `/tools` — List loaded tools
- `/help` — Show commands
- `/exit` — Shutdown

### Web Dashboard
Dark terminal-aesthetic web UI at `http://localhost:3131` with:
- Real-time streaming responses via SSE
- Collapsible tool event cards
- Sidebar with system info and tool status
- Optional password authentication
- Rate limiting (30 requests/minute per IP)

### Telegram Bot
Set `TELEGRAM_BOT_TOKEN` in `.env` and enable in config. Supports:
- Text messages, voice messages (via STT), and photo analysis
- `/start` — Welcome message
- `/status` — System status
- `/clear` — Clear conversation

## Tools

| Tool | Description |
|------|-------------|
| **Filesystem** | |
| `read_file` | Read file contents |
| `write_file` | Write content to file |
| `append_file` | Append to file |
| `list_directory` | List directory contents |
| `delete_file` | Delete file or directory |
| `create_directory` | Create directory tree |
| `move_file` | Move/rename files |
| `file_exists` | Check path and get metadata |
| `search_files` | Glob search in directory |
| **Shell** | |
| `run_command` | Execute shell command |
| `run_script` | Run temp script file |
| **HTTP** | |
| `http_request` | Make HTTP requests (GET/POST/PUT/PATCH/DELETE) |
| **Code** | |
| `execute_node` | Run sandboxed JS code |
| `evaluate_expression` | Evaluate math expressions |
| **Database** | |
| `db_query` | SQL SELECT queries |
| `db_execute` | SQL write operations |
| `db_schema` | Get database schema |
| **Git** | |
| `git_status` | Git status |
| `git_diff` | Git diff |
| `git_log` | Git commit log |
| `git_pull` | Git pull |
| `git_push` | Git push |
| `git_commit` | Stage and commit |
| `git_checkout` | Checkout branch |
| `git_clone` | Clone repository |
| **Browser** | |
| `browser_navigate` | Navigate to URL and read page |
| `browser_click` | Click elements on page |
| `browser_type` | Type into input fields |
| `browser_read` | Read page content and elements |
| `browser_screenshot` | Take page screenshots |
| `browser_script` | Execute JS in browser context |
| `browser_wait` | Wait for conditions on page |
| `browser_tabs` | Manage browser tabs |
| `browser_cookies` | Manage cookies |
| `browser_close` | Close browser |
| **Display** | |
| `display_image` | Send images to the user |

Custom tools can be added via the plugin system — place `.js` files in a `plugins/` directory.

## Architecture

```
User → Interface (CLI/Web/Telegram)
         ↓
      Agent Loop
         ↓
    Planner → Reasoner (LLM) → Executor → Tools
         ↑       ↓                    ↓
      Memory ← Tool Results ← Filesystem/Shell/HTTP/etc.
```

The agent loops autonomously: it plans, reasons with the LLM, calls tools, feeds results back to the LLM, and continues until the task is resolved (max 25 iterations).

## Memory

- **Short-term**: In-memory conversation history (configurable max messages)
- **Long-term**: Semantic vector similarity using LLM embeddings (with bag-of-words fallback)
- **Preferences**: Persistent user preferences in SQLite

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
```

## Docker

```bash
docker build -t subaru .
docker run -p 3131:3131 --env-file .env subaru
```

## Requirements

- Node.js 20+
- Ollama (for local LLM) or OpenAI/Anthropic API key
- Git (for git tools)
- Chromium (auto-installed by Puppeteer for browser tools)

## License

MIT
