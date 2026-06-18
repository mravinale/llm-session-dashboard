# LLM Session Dashboard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

See exactly where your context window goes. Trace every agent delegation. Understand how your **Claude Code** and **OpenAI Codex** sessions actually execute — all from your local `~/.claude` and `~/.codex`, no data sent anywhere.

Both CLIs show up side by side: when `~/.codex` is present, Codex sessions appear alongside your Claude sessions across the list, detail, stats, and cost views — each tagged with a provider badge and filterable by provider.

```bash
npx llm-session-dashboard
```

## Why?

If you run AI coding agents like Claude Code or OpenAI Codex with agentic workflows and custom skills, you've probably felt this: sessions that start sharp and gradually get worse. The agent repeats itself, misses earlier context, gives shallower answers. The context window is filling up silently and you have no way to see it.

The fix is agent delegation — each subagent starts with a fresh context, keeping your main session lean. But most people do this by instinct, not by design. You can't optimize what you can't see.

This dashboard makes it visible. It reads your local session files, parses the JSONL logs from both Claude Code and Codex, and shows you what's actually happening inside your workflows — which agents were dispatched, in what order, how much context each step consumed, and where your tokens are going.

Everything runs entirely on your machine. Read-only — it never modifies any Claude Code or Codex data.

## Features

**Agent delegation timeline** ← the unique one
- Gantt-style diagram showing every subagent dispatch in a session, in sequence
- See the full delegation chain: which agents ran, in what order, how long each took (Claude's `Task`/`Agent` dispatches and Codex's `spawn_agent`)
- Token usage per agent — understand exactly how each delegation affects context consumption
- Zoom controls for detailed inspection of complex multi-agent workflows

**Context window visualization**
- Live breakdown of how your context window is being used: input, output, cache reads, cache writes — plus reasoning tokens for Codex
- Real per-model context limits (e.g. Claude 200K, Codex 258K) read straight from the session data
- See at a glance whether your main session is staying lean or accumulating context
- Per-session and per-agent cost estimates with per-model and per-category breakdowns

![Session Detail](screenshots/session-detail-full.png)

**Session browsing and search**
- Browse Claude and Codex sessions together, each tagged with a provider badge
- Filter by provider (Claude / Codex), status (active / completed), project, model, and date range
- Full-text search across session names, projects, and branches
- Sortable columns with pagination
- Active session indicator with real-time status polling

**Analytics and stats**
- GitHub-style contribution heatmap showing token usage intensity over the past year
- Token usage over time -- stacked area chart with daily/weekly toggle, top models + "Other"
- Model usage distribution across all providers, colored by provider (Anthropic warm, OpenAI cool)
- Hourly activity distribution chart
- Aggregate metrics across both providers: total sessions, messages, tokens, estimated cost

![Stats Overview](screenshots/stats-overview-full.png)

**Per-project analytics**
- Dedicated "Projects" tab with sortable table
- Sessions, messages, tokens, and duration aggregated per project (Claude and Codex work in the same repo merge into one row)
- Drill-down links to filtered session lists

![Per-Project Analytics](screenshots/stats-projects.png)

**Cost estimation**
- Configurable API pricing per model -- Anthropic (Opus, Sonnet, Haiku) and OpenAI / Codex (GPT-5 family)
- Reasoning tokens billed at the output rate for Codex
- Override any rate to match your negotiated pricing
- Settings persisted to `~/.llm-dashboard/settings.json`

![Settings Page](screenshots/settings-page.png)

**Data export**
- Export stats and session data in CSV or JSON format
- Four export formats: session summaries, model usage, daily activity, project analytics
- Client-side export -- no server round-trip needed

**Real-time monitoring**
- Active sessions badge in the sidebar with 3-second status polling
- Active session banner on detail pages with adaptive refresh intervals
- Automatic data refresh for in-progress sessions

**Privacy mode**
- Toggle to anonymize project names, file paths, branch names, and usernames
- Analytics data anonymized consistently across all views
- Safe for screenshot sharing and presentations

## Quick Start

### Using npx (recommended)

```bash
npx llm-session-dashboard
```

### Using npm (global install)

```bash
npm install -g llm-session-dashboard
llm-dashboard
```

### From source

```bash
git clone https://github.com/mravinale/llm-session-dashboard.git
cd llm-session-dashboard/apps/web
npm install
npm run build
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Updating

**npx** — always fetches the latest published version automatically. No action needed.

**Global install** — check your current version and update:

```bash
llm-dashboard --version           # see current version
npm install -g llm-session-dashboard@latest
```

**From source** — pull the latest changes and rebuild:

```bash
cd llm-session-dashboard
git pull
cd apps/web && npm install && npm run build
```

## CLI Options

```
  -p, --port <number>   Port to listen on (default: 3000)
  --host <hostname>     Host to bind to (default: localhost)
  -o, --open            Open browser after starting
  -v, --version         Show version number
  -h, --help            Show this help message
```

> **Note:** The dashboard runs entirely on localhost and only reads files from `~/.claude` and `~/.codex`. It never modifies any Claude Code or Codex data and never sends data over the network.

## Tech Stack

- [TanStack Start](https://tanstack.com/start) -- SSR framework on Vite
- [TanStack Router](https://tanstack.com/router) -- file-based routing with type-safe search params
- [TanStack Query](https://tanstack.com/query) -- data fetching with caching and automatic background refetch
- [Tailwind CSS v4](https://tailwindcss.com/) -- utility-first styling with CSS-first configuration
- [Recharts](https://recharts.org/) -- composable charting library for timeline, heatmap, and stats visualizations
- [Zod](https://zod.dev/) -- runtime validation for server functions and URL params
- Node.js >= 18

## Provider Architecture

The dashboard is provider-agnostic at its core. Each provider has a thin **adapter** that knows how to read and normalize its own on-disk format, and everything above the adapter — server functions, queries, UI — only ever sees shared, normalized domain types.

- **Claude** sessions live under `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
- **Codex** sessions live under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.

Adding another provider is localized to one `lib/adapters/<provider>/` folder plus a one-line entry in the provider registry. Each session carries a `provider` tag that drives the badge, the filter, and provider-aware behavior (resume command, color, pricing).

## Project Structure

```
apps/web/src/
  routes/                        # File-based routes (TanStack Router)
    _dashboard/
      sessions/
        index.tsx                # Sessions list page
        $sessionId.tsx           # Session detail page
      stats.tsx                  # Stats + per-project analytics page
      settings.tsx               # Settings page
  features/                      # Vertical Slice Architecture
    sessions/                    # Session list, filters, provider badge, active badge
    session-detail/              # Session detail, timeline, context window
    stats/                       # Activity chart, heatmap, token trends, model usage
    project-analytics/           # Per-project aggregated metrics
    cost-estimation/             # Cost calculation and display
    settings/                    # Pricing editor, privacy mode
    privacy/                     # Privacy mode toggle and anonymization
  lib/
    adapters/                    # Provider adapters (Claude, Codex) → normalized domain types
      provider-registry.ts       #   Single source of truth for provider identity
      claude/  codex/  shared/   #   Per-provider scan/parse + shared JSONL primitives
    scanner/                     # Filesystem scanners for ~/.claude and ~/.codex
    parsers/                     # Domain types + Claude JSONL parsers
    cache/                       # Persistent disk cache (heatmap data)
    utils/                       # Formatting, export utilities
  components/                    # Shared UI components (ProviderBadge, ExportDropdown, etc.)
```

## How It Works

1. **Scanning** -- The server discovers sessions through per-provider adapters: Claude from `~/.claude/projects/` and Codex from `~/.codex/sessions/`. An mtime-based cache avoids re-parsing unchanged files.
2. **Normalizing** -- Each adapter parses its own JSONL format and emits the same shared domain types (sessions, turns, tool calls, agents, tasks, token usage), tagged with a `provider`. The rest of the app never branches on provider.
3. **Server Functions** -- TanStack Start server functions (`createServerFn`) expose parsed data to the client via type-safe RPC. All file I/O stays on the server.
4. **React Query** -- The UI fetches data through React Query with automatic background refetch for live updates. Active sessions use adaptive polling intervals.
5. **Caching** -- Parsed session summaries and heatmap data are cached in memory (mtime-based invalidation) and on disk (`~/.llm-dashboard/cache/`) for fast startup.

## Development

```bash
cd apps/web

npm run dev          # Dev server on localhost:3000
npm run build        # Production build
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
npm run test         # Unit tests (Vitest)
npm run e2e          # End-to-end tests (Playwright)
```

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and conventions. Check [good first issues](https://github.com/mravinale/llm-session-dashboard/labels/good%20first%20issue) for beginner-friendly tasks.

If you find this project useful, consider giving it a star -- it helps others discover it.

## Links

- [GitHub](https://github.com/mravinale/llm-session-dashboard)
- [npm](https://www.npmjs.com/package/llm-session-dashboard)
- [Issues](https://github.com/mravinale/llm-session-dashboard/issues)
- [Discussions](https://github.com/mravinale/llm-session-dashboard/discussions)

## License

MIT
