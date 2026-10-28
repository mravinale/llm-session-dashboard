# Design: Codex (OpenAI Codex CLI) Session Tracking — Full Parity with Claude

> Status: Implementation-ready architecture plan. Hand to `implementer` agents phase-by-phase.
> Author: architect agent. Grounded against repo state on 2026-06-18.
> Revised 2026-06-18 (design-quality pass — see Section 0 and the Revision Changelog).
> All file paths below are absolute or rooted at `apps/web/src/` (import alias `@/`).

---

## 0. Design-Principles Review (SOLID / KISS / DRY / SOC)

This section is the verdict of a focused design-quality pass over the first draft of this plan. Each row cites the
plan section and/or the real repo file that motivated the decision. **Accepted changes are applied throughout
Sections 2–8** — this is not an appendix; the rest of the document already reflects these decisions.

The guiding tension: this is a **two-provider** system. Abstractions must pay for themselves *now*, not in a
hypothetical provider #3. Where a "purer" design only helps an imaginary third provider, KISS wins. Where duplication
or mixed responsibilities already bite us at two providers, we fix them.

| # | Principle | Finding (with reference) | Decision |
|---|---|---|---|
| P1 | **SRP / SOC** | First draft's `codex-parser.ts` owned three read strategies *and* envelope→domain mapping *and* file I/O (Section 5.6). Claude's `session-parser.ts` is the same mixed bag (1000+ lines: I/O + mapping + context-window math + subagent merge). | **SPLIT the Codex side only; do NOT churn the Claude side.** Codex gets a pure `codex-mapper.ts` (raw envelope objects → normalized domain types, zero `fs`) and a thin `codex-parser.ts` (I/O + readline + head/tail, calls the mapper). The mapper is unit-testable from in-memory fixtures with no filesystem. We deliberately leave `session-parser.ts` as-is: it is proven, tested, and re-mapping it buys nothing for parity. See P-note below on asymmetry. |
| P2 | **OCP / DRY — single source of truth for "provider"** | First draft hardcoded `provider: 'claude' \| 'codex'` in domain types, the route Zod schema, the server-fn `paginatedSessionsInputSchema`, `ProviderBadge`, the filter dropdown, and copy — six+ edit sites (Sections 3.1, 6.1, 6.3). Adding provider #3 = shotgun surgery, and the values would drift (badge color vs filter option vs enum). | **ADD a single `provider-registry.ts` descriptor**, but keep it minimal. One module exports `PROVIDERS` (array of `{ id, label, badgeClass }`) and derived `PROVIDER_IDS` / `ProviderId` (a `z.enum` built from the array). Backend Zod enums, frontend badge, and filter options all derive from it. This removes real, present-tense duplication (the enum literally appears 4×). It is **not** the heavy "adapter-registry + root resolver + availability probe in one mega-descriptor" the prompt floated — root resolution and availability live with the adapters (they need `fs`/`os`), the *presentation* descriptor stays a pure, client-safe constant. Two registries, each with one job (see P5). |
| P3 | **DRY — shared low-level utilities** | First draft re-implemented per provider: JSONL streaming, head+tail bounded reads, mtime cache, project-name extraction (Sections 5.5, 5.6, 5.7). `extractProjectName` is reused, but `readHeadLines`/`readTailLines`/`safeParse`/the mtime-cache pattern are private to `session-parser.ts` / `session-scanner.ts`. | **EXTRACT the three genuinely-shared, generic primitives to `lib/adapters/shared/jsonl-io.ts`**: `readHeadLines`, `readTailLines`, `safeParseLine` (a generic `(line) => T \| null`). These are pure text/byte plumbing with zero Claude/Codex knowledge — true DRY. Refactor `session-parser.ts` to import them (small, safe, covered by existing tests). **Do NOT** extract a shared "summary cache" or "scanner walker": Claude walks `projects/<enc>/<id>.jsonl`, Codex walks `sessions/Y/M/D/rollout-*.jsonl` — the directory logic only *looks* similar (false DRY). Each adapter keeps its own walk + its own `Map` cache; the cache is ~8 lines and forcing a shared generic over two different key/parse shapes adds more indirection than it removes. |
| P4 | **ISP / KISS** | First draft's `SessionSourceAdapter` had 5 methods: `getSources`, `scanSummaries`, `parseDetail`, `isActive`, `findSessionFile` (Section 2.1). Prompt asks: segregate into smaller interfaces? | **KEEP it as one cohesive interface.** Its single role is "expose one provider's sessions to the generic pipeline." All five methods are used together by the scanner/detail/stats layer; no consumer wants a subset. Splitting into `Scannable`/`Detailable`/`Locatable` would be ISP theater for two implementations that both implement all of it — pure ceremony, a KISS violation. **However**, `isActive` and `findSessionFile` are *folded in as adapter methods, not separate files* (see P6) — that is the real simplification. |
| P5 | **File-count / KISS** | First draft proposed 9 new backend files including `codex-active.ts` and `codex-session-index.ts` as standalone modules (Sections 5.4–5.8). For two providers, several are single-function files. | **COLLAPSE.** `codex-active.ts` → a method on `CodexAdapter` (it is one `stat` + one tail-read; it needs the adapter's own constants anyway). `codex-session-index.ts` (title lookup) → fold into `codex-scanner.ts` as a small cached helper (it is one cached `Map`). Net backend new files drop from 9 to **6**: `provider-registry.ts`, `adapter.ts` (types+registry merged — see below), `codex-path.ts`, `codex-mapper.ts`, `codex-parser.ts`, `codex-scanner.ts`, plus `codex-raw.types.ts` for the Zod line schemas. Merge `adapters/types.ts` + `adapters/registry.ts` into one `lib/adapters/adapter.ts` (the interface and the 4-line registry are the same concern: "the adapter seam"). `ClaudeAdapter` and `CodexAdapter` are one file each. |
| P6 | **DIP** | First draft left `find-session-file.ts` and `stats-parser.ts` calling concrete Claude functions directly (Sections 5.11, 5.12), then bolted provider-routing on top. `session-detail.api.ts` imports the concrete `parseDetail` from `session-parser.ts` and the concrete `findSessionFile`. | **ROUTE through the adapter abstraction.** Detail resolution becomes: pick adapter by `provider` (carried on the summary / passed from the card), call `adapter.parseDetail` / `adapter.findSessionFile`. `stats-parser`'s per-session `parseDetail` call becomes `getAdapter(session.provider).parseDetail(...)`. No layer above the registry names a concrete provider function. The legacy `find-session-file.ts` becomes the Claude adapter's `findSessionFile` implementation (moved, not duplicated). |
| P7 | **LSP** | Codex degrades fields: skills `[]`, agent sub-tokens `undefined`, branch `null` (Sections 4.6, 4.7). Are consumers safely substitutable? | **Optional-field degradation is sufficient (KISS) — with one guard.** The domain types already make `agents[].tokens`, `.skills`, `.durationMs` optional and `branch` nullable; panels already render Claude sessions that lack these (verified: `AgentInvocation` fields are all optional in `types.ts`, `branch` is `string \| null`). So Codex `[]`/`undefined`/`null` are honest, in-contract values — no consumer asserts presence. We do **not** add a heavier "capability unsupported vs no-data-this-session" discriminator: for these panels the UI treatment is identical ("show nothing"), so the distinction is invisible to the user and would only add type noise. **Guard:** a parity test (Section 8) asserts every required `SessionDetail` field is present and correctly typed for a Codex fixture, so a silent `undefined` in a *required* slot fails CI. |
| P8 | **Readability / naming** | First draft renamed `claudeDir`→`rootDir` at the generic layer (good) but the rename only lived in `ProviderSource`. The envelope state machine had no described shape. | **KEEP `rootDir` at the generic `ProviderSource` layer; keep `claudeDir` inside `claude-path.ts`** (zero churn to proven WSL code — the Claude adapter maps `claudeDir → rootDir` at the boundary). Document the Codex envelope dispatch as an explicit `switch (line.type)` in the mapper (Section 4.0). Co-locate every `*.test.ts` with its source. Acceptance check for maintainability: **adding provider #3 touches exactly `provider-registry.ts` (1 line) + `adapter.ts` registry (1 line) + a new `lib/adapters/<provider>/` folder** — nothing else. This is the litmus test the file layout in Section 5 is designed to pass. |

> **P-note on intentional asymmetry (SRP).** We split the *Codex* parser into mapper + I/O but leave *Claude*'s
> `session-parser.ts` monolithic. This is deliberate, not inconsistent: the Claude parser is battle-tested with a
> large test suite, and the parity goal does not require touching it. Re-architecting working code to satisfy
> symmetry is gold-plating (and risk). New code (Codex) is built clean; old code (Claude) is wrapped, not rewritten.
> If Claude's parser later needs changes for unrelated reasons, *that* is the time to extract its mapper.

**Net effect of the review:** fewer files (9→6 new backend modules), one present-tense duplication removed
(provider enum), three genuinely-shared primitives extracted (head/tail/safeParse), the Codex mapper made
filesystem-free and unit-testable, and the detail/stats path made DIP-clean — all without churning the proven
Claude parser or inventing abstractions for a third provider that does not exist yet.

---

## 1. Executive Summary

**What.** Add OpenAI Codex CLI sessions (`~/.codex/sessions/**`) as a first-class data source alongside Claude
(`~/.claude/projects/**`), so the dashboard shows the **same** Sessions list, Session detail, Stats, and Project
Analytics pages — with the same metrics, charts, and dark-theme design — for Codex sessions. Each session gains a
`provider: ProviderId` dimension surfaced as a badge and a filter.

**Why.** Users run both Codex and Claude Code locally and want one read-only observability surface. The on-disk
formats differ (Codex stores one envelope-style JSONL per session under date folders; Claude stores one JSONL per
session under dash-encoded project folders), but the *domain* the user cares about — sessions, turns, tokens, tools,
agents, tasks, costs, daily stats — is identical.

**Core architectural idea.** Introduce a `SessionSourceAdapter` interface (`getSources`, `scanSummaries`,
`parseDetail`, `isActive`, `findSessionFile`) with two implementations — `ClaudeAdapter` (wrapping today's logic
verbatim) and `CodexAdapter` (new) — both emitting the **shared, normalized domain types** from
`lib/parsers/types.ts`, each tagged with `provider`. The existing single-source `scanAllSessions()` read path becomes
a **provider × source** loop over the adapter registry. Server functions, React Query, and ~90% of UI stay unchanged
because they only ever see normalized `SessionSummary` / `SessionDetail`. The only widening of the domain is one new
`provider` field and a handful of optional Codex-friendly fields (`title`, `reasoningOutputTokens`). Provider
identity (id, label, badge color) lives in **one** `provider-registry.ts`; provider I/O lives in the adapters.

---

## 2. Architecture & Approach

### 2.1 The chosen abstraction: a provider adapter behind a generalized source seam

The repo has a **multi-source** type in `apps/web/src/lib/utils/claude-path.ts`:

```
interface DataSource { id; label; claudeDir; platform; available }
getDataSources() -> [primary, ...wslDistros]
```

**Ground-truth correction (verified):** the *live* read path used by every server function is the single-source
`scanAllSessions()` in `session-scanner.ts` (called by `sessions.api.ts`, `project-analytics.api.ts`). The
multi-source `scanAllSessionsMultiSource()` / `scanSessionsFromSource()` functions exist but are **not** wired into
the public APIs today. So this is not "every scanner already loops over `DataSource[]`" — we are generalizing the
*single-source* `scanAllSessions()` into an adapter loop. (The WSL multi-source code is reused inside `ClaudeAdapter`
to enumerate its sources, so no WSL logic is lost.)

`DataSource` bakes in Claude assumptions: the field is literally `claudeDir`, and every consumer assumes Claude's
`projects/<dash-encoded-cwd>/<id>.jsonl` + lock-dir layout. Codex uses a different root (`~/.codex`), a different
tree (`sessions/YYYY/MM/DD/rollout-*.jsonl`), and a different active rule (no lock dir). So the layout-specific logic
moves **behind an adapter**, while the cross-source merge/dedup becomes generic.

**Adapter seam** (one new file `lib/adapters/adapter.ts` — interface + registry, per P5):

```
// provider id type/enum comes from provider-registry.ts (P2) — NOT redeclared here
import type { ProviderId } from '@/lib/adapters/provider-registry'

interface SessionSourceAdapter {
  provider: ProviderId
  getSources(): Promise<ProviderSource[]>                       // enumerate roots on this machine
  scanSummaries(source: ProviderSource): Promise<SessionSummaryWithPath[]>  // -> normalized + provider tag
  parseDetail(filePath, sessionId, projectPath, projectName): Promise<SessionDetail>
  isActive(filePath, sessionId, source): Promise<boolean>       // folded in (P5) — no separate file
  findSessionFile(sessionId, projectPath): Promise<{ path: string } | null>
}

interface ProviderSource {
  provider: ProviderId
  id: string          // 'codex-primary' | 'primary' | 'wsl-ubuntu-user'
  label: string       // 'Codex' | 'macOS' | 'WSL - Ubuntu'
  rootDir: string     // ~/.codex or ~/.claude   (generic name; claudeDir maps to this at the Claude boundary)
  platform: 'windows' | 'wsl' | 'macos' | 'linux'
  available: boolean
}

// 4-line registry lives in the same file (same concern: "the adapter seam"):
getAdapters(): SessionSourceAdapter[]   // [claudeAdapter] + (codex root exists ? [codexAdapter] : [])
getAdapter(provider: ProviderId): SessionSourceAdapter | undefined
```

`getAdapters()` includes `CodexAdapter` only when `~/.codex` exists (probed via `codex-path.ts`), mirroring
`available`.

### 2.2 Two registries, one job each (P2 / P5)

```
provider-registry.ts   (pure, client-safe constant — NO fs/os)
  PROVIDERS: [{ id:'claude', label:'Claude', badgeClass:'...orange' },
              { id:'codex',  label:'Codex',  badgeClass:'...teal'   }]
  ProviderId  = 'claude' | 'codex'         (type derived from PROVIDERS)
  providerIdEnum = z.enum([...ids])        (Zod enum derived from PROVIDERS)
        |                                   |
   used by: ProviderBadge,            used by: route search schema,
   filter dropdown, dynamic copy             paginatedSessionsInputSchema, getSessionDetail input

adapter.ts             (server-only — interface + registry of concrete adapters)
  getAdapters() / getAdapter(provider)     resolves roots + I/O via codex-path / claude-path
```

Rationale: the *presentation* facts (label, color) must be importable by client components and must not drag `fs`
into the bundle; the *I/O* facts (root dir, availability, parse functions) are server-only. Splitting along the
client/server boundary keeps each registry single-purpose and avoids a god-descriptor. Both are still "one place to
add a provider" — see the P8 litmus test.

### 2.3 Data-flow diagram (both providers feed one normalized pipeline)

```
  ~/.claude/projects/<enc>/<id>.jsonl          ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  ~/.claude/stats-cache.json                   ~/.codex/session_index.jsonl (titles)
  (lock dir = active)                           (config.toml, history.jsonl)
            |                                              |
            v                                              v
   +------------------+                           +------------------+
   |  ClaudeAdapter   |  wraps existing fns       |  CodexAdapter    |  new
   |  getSources      |  (claudeDir -> rootDir)   |  getSources      |
   |  scanSummaries   |                           |  scanSummaries --+--> codex-scanner (walk + cache + title)
   |  parseDetail     |                           |  parseDetail   --+--> codex-parser (I/O) -> codex-mapper (pure)
   |  isActive        |                           |  isActive        |
   |  findSessionFile |                           |  findSessionFile |
   +--------+---------+                           +---------+--------+
            |   { ...SessionSummary, provider:'claude' }    |   { ..., provider:'codex' }
            +----------------------+------------------------+
                                   v
                  +-------------------------------------+
                  |   provider x source merge / dedup   |   <- generalized scanAllSessions()
                  |   (lib/scanner/session-scanner.ts)  |      iterates getAdapters()
                  +------------------+------------------+
                                     v
              SessionSummary[] / SessionDetail  (shared domain types, +provider)
                                     v
        +------------------------------------------------------------+
        |  Server functions (features/*/*.api.ts, createServerFn)    |  UNCHANGED signatures
        |  getPaginatedSessions / getSessionDetail / getStats / ...  |  (+provider filter on pagination)
        +-----------------------------+------------------------------+
                                      v
              React Query (*.queries.ts)  — UNCHANGED (sessionDetailQuery gains provider in key)
                                      v
        UI (features/*, routes/_dashboard/*)  — +ProviderBadge, +provider filter, dynamic copy
                                                  (badge/filter/copy all derive from provider-registry)
```

Note the Codex internal layering (P1): `scanSummaries → codex-scanner`, `parseDetail → codex-parser (I/O) →
codex-mapper (pure)`. The mapper never touches `fs`.

### 2.4 Why this over the alternatives

| Alternative | Why rejected |
|---|---|
| **Parallel parser branches** (`if provider === 'codex'` scattered in `session-parser.ts`, `stats-parser.ts`, `session-scanner.ts`) | Spreads provider knowledge across every layer; every new field/quirk touches many files; violates Vertical Slice + SRP. No clean test seam. |
| **Separate routes / pages for Codex** (`/codex/sessions`) | Contradicts the parity requirement; doubles UI surface; fragments cross-provider stats. |
| **A second app / second port** | Maximal isolation, zero shared UX; rejected by the parity goal. |
| **Adapter behind a generalized source seam (CHOSEN)** | Localizes all Codex I/O + mapping to `CodexAdapter`; server fns / queries / 90% of UI never learn Codex exists; reuses the working dedup/merge and the proven WSL enumeration; matches the established multi-source pattern the team maintains. |
| **One god provider-descriptor (id+label+color+rootDir+probe+adapter)** | Rejected per P2: drags `fs`/`os` into client bundle and couples presentation to I/O. Split into a client-safe `provider-registry` + a server-only `adapter` registry. |

**Reuse vs. generalize the `DataSource` seam:** *Generalize.* Keep `DataSource` and `getDataSources()` as the
**Claude-specific** producer used internally by `ClaudeAdapter` (zero churn to the proven WSL logic), and present the
broader `ProviderSource`/`SessionSourceAdapter` layer on top. `ClaudeAdapter.getSources()` maps each `DataSource` →
`ProviderSource` (`rootDir = claudeDir`, `provider = 'claude'`). This avoids touching the 160-line `claude-path.ts`
WSL detection while presenting a provider-neutral interface upward.

---

## 3. Data Model Changes

One new dimension plus a few optional Codex-friendly fields. All additive and backward-compatible.

### 3.1 `lib/adapters/provider-registry.ts` (NEW — single source of truth for provider identity, P2)

```
PROVIDERS = [
  { id: 'claude', label: 'Claude', badgeClass: '<brand/orange classes>' },
  { id: 'codex',  label: 'Codex',  badgeClass: '<teal/green classes>'   },
] as const

type ProviderId = (typeof PROVIDERS)[number]['id']        // 'claude' | 'codex'
PROVIDER_IDS = PROVIDERS.map(p => p.id)                     // for iteration
providerIdEnum = z.enum(PROVIDER_IDS)                       // for Zod schemas
providerFilterEnum = z.enum(['all', ...PROVIDER_IDS])      // for the filter
getProviderMeta(id): { label; badgeClass }                 // for the badge
```

This file is **the only place** that knows the set of providers and their presentation. It is pure (no `fs`/`os`),
so client components import it freely.

### 3.2 `lib/parsers/types.ts`

```
import type { ProviderId } from '@/lib/adapters/provider-registry'   // NO local 'claude'|'codex' literal

SessionSummary {                       // add:
  provider: ProviderId                 //   REQUIRED (set 'claude' in ClaudeAdapter)
  title?: string                       //   OPTIONAL — Codex session_index thread_name; Claude undefined
  reasoningOutputTokens?: number       //   OPTIONAL — Codex reasoning tokens (display only)
}

SessionDetail {                        // add:
  provider: ProviderId                 //   REQUIRED
  title?: string                       //   OPTIONAL
}

TokenUsage {                           // OPTIONAL add (non-breaking):
  reasoningOutputTokens?: number       //   Codex-only; undefined for Claude
}
```

The `provider` *type* comes from `provider-registry.ts` — `types.ts` never hardcodes the union (P2). **No change** to
`Turn`, `ToolCall`, `AgentInvocation`, `SkillInvocation`, `TaskItem`, `ContextWindowData`, `SessionError` shapes —
Codex maps onto them (Section 4). `RawJsonlMessage` stays Claude-specific in `lib/parsers/`; Codex gets its own raw
line schemas in `lib/adapters/codex/codex-raw.types.ts`.

### 3.3 Stats types

`StatsCache` (Zod schemas) is **unchanged in shape**. Codex has no `stats-cache.json`, so the merged stats path
already computes from sessions. `tokensByModel` and `modelUsage` are keyed by model id — Codex ids (`gpt-5.5`,
`gpt-5-codex`) coexist with Claude ids with no collision.

### 3.4 Settings types (`features/settings/settings.types.ts`)

- `DEFAULT_PRICING` gains Codex/OpenAI model entries (e.g. `gpt-5.5`, `gpt-5-codex`, `gpt-5.3-codex`).
- **`normalizeModelId()` needs NO change (ground-truth correction).** It strips an 8-digit date suffix via
  `/-\d{8}$/`. Verified against `settings.types.test.ts`: 7- and 9-digit suffixes and non-date strings pass through
  untouched, so `gpt-5.5` is already safe. The first draft's "add a provider-agnostic guard" was over-engineering
  (YAGNI) — **dropped.** A unit test asserting `normalizeModelId('gpt-5-codex') === 'gpt-5-codex'` is the only
  addition.
- `subscriptionTier` stays Claude-oriented; Codex cost is API/usage-based. The cost panel already supports an `api`
  tier.

---

## 4. Codex → Domain Mapping Tables

Source of truth: REFERENCE B (verified on machine, `~/.codex`, 24 sessions, 8 projects). Each rollout line is an
envelope `{ timestamp, type, payload }`.

### 4.0 Envelope dispatch shape (mapper, P1/P8)

`codex-mapper.ts` exposes **pure** functions over already-parsed line arrays (no `fs`):

```
mapSummary(headLines: CodexLine[], tailLines: CodexLine[], ctx): SessionSummary
mapDetail(lines: CodexLine[], ctx): SessionDetail        // ctx = { sessionId, projectPath, projectName, title? }
```

Internally each is a single explicit `switch (line.type)` (and `line.payload.type` where needed) over the envelope:
`session_meta | turn_context | response_item | event_msg | token_count | ...`. The `codex-parser.ts` layer owns
`fs`/`readline`/head-tail and feeds parsed `CodexLine[]` (validated by `codex-raw.types.ts`) into the mapper. This is
the one structural difference from Claude's parser, and it is what makes Codex mapping unit-testable without disk.

### 4.1 SessionSummary (lightweight parse — head + token tail)

| Domain field | Codex source | Notes |
|---|---|---|
| `sessionId` | `session_meta.payload.id` (or uuid in filename) | First `session_meta` line is canonical. |
| `provider` | constant `'codex'` | Set by adapter. |
| `projectPath` | `session_meta.payload.cwd` | **Absolute already** — no dash-decoding. |
| `projectName` | `basename(cwd)` | Reuse `extractProjectName()` from `claude-path.ts` (pure, provider-neutral). |
| `branch` | `null` | Graceful degrade — in contract (`branch: string \| null`). |
| `cwd` | `session_meta.payload.cwd` | Same as projectPath. |
| `startedAt` | `session_meta.payload.timestamp` (fallback: first line `timestamp`) | ISO. |
| `lastActiveAt` | last line `timestamp` | From tail read. |
| `durationMs` | `lastActiveAt - startedAt` | |
| `messageCount` | count `response_item.message` (or `event_msg` user/agent_message) | total. |
| `userMessageCount` / `assistantMessageCount` | count `message` role | |
| `isActive` | adapter `isActive()` (4.x / 5.7) | mtime < 2 min AND last event != `task_complete`. |
| `toolCallCount` | count `function_call` + `custom_tool_call` | |
| `model` | most-recent `turn_context.payload.model` (fallback `config.toml`/`session_meta`) | varies per turn. |
| `version` | `session_meta.payload.cli_version` | e.g. `0.36.0`, `0.140.0-alpha.2`. |
| `fileSizeBytes` | `stat.size` | |
| `outputTokens` | last `token_count.payload.info.total_token_usage.output_tokens` | Cumulative — take last. |
| `reasoningOutputTokens?` | last `total_token_usage.reasoning_output_tokens` | Codex-only display. |
| `title?` | `session_index.jsonl` `thread_name` by id (fallback first user msg / cwd basename) | Bonus. |
| `isInteractive` | `originator !== spawned-agent` heuristic; default `true` | Best-effort. |
| `sourceId/Label/Platform` | from `ProviderSource` | e.g. `codex-primary` / `Codex` / platform. |

> **Summary read strategy.** Codex token totals are on the **last** `token_count` line; `lastActiveAt` is the last
> line — both at the tail. `session_meta` is at the head. So `parseSummary` reads head lines + a larger tail window
> than Claude's 15 (Codex constants live on `CodexAdapter`). The head/tail *reading* uses the shared
> `lib/adapters/shared/jsonl-io.ts` primitives (P3); the *interpretation* is the mapper. Counts requiring a full scan
> are approximated from head+tail in the summary and made exact in `parseDetail` (matching how Claude's summary
> already approximates).

### 4.2 SessionDetail (full streaming parse)

| Domain field | Codex source |
|---|---|
| `sessionId`/`projectPath`/`projectName` | as 4.1 |
| `provider` | `'codex'` |
| `title?` | `session_index` thread_name |
| `branch` | `null` |
| `isInteractive` | as 4.1 |
| `turns: Turn[]` | one `Turn` per `response_item.message` / assistant turn; see 4.3 |
| `totalTokens: TokenUsage` | from **last** `token_count.info.total_token_usage` (cumulative) — see 4.5 |
| `tokensByModel` | per-turn `last_token_usage` deltas attributed to active `turn_context.model` — see 4.5 |
| `toolFrequency` | count by `function_call`/`custom_tool_call` `name` |
| `errors` | `turn_aborted`, non-zero exec exit codes (best-effort from `function_call_output`) |
| `models: string[]` | distinct `turn_context.payload.model` |
| `agents: AgentInvocation[]` | from `spawn_agent`/`wait_agent` — see 4.6 |
| `skills: SkillInvocation[]` | **degrade to `[]`** — no per-session skill events (see 4.7) |
| `tasks: TaskItem[]` | from `update_plan` tool calls — see 4.8 |
| `contextWindow` | from `task_started.model_context_window` / `token_count.info.model_context_window` — see 4.9 |

### 4.3 Turn

| Turn field | Codex source | Notes |
|---|---|---|
| `uuid` | `turn_context.payload.turn_id` or synthesized `codex-<index>` | stable index. |
| `type` | `message.role`: user→`user`, assistant→`assistant`, developer→`system` | `reasoning` folded into the owning assistant turn. |
| `timestamp` | envelope `timestamp` | |
| `message` | `message.content[].text` where type ∈ `input_text`/`output_text` (truncate 500) | mirrors Claude `extractTextContent`. |
| `model` | active `turn_context.model` | |
| `toolCalls: ToolCall[]` | `function_call`/`custom_tool_call` between this turn and the next | see 4.4 |
| `tokens?` | per-turn delta from `last_token_usage` if available | optional. |
| `stopReason?` | `task_complete` / `turn_aborted` mapped to a string | optional. |

### 4.4 ToolCall

| ToolCall field | Codex source |
|---|---|
| `toolName` | `function_call.payload.name` / `custom_tool_call.payload.name` (`exec_command`, `apply_patch`, `update_plan`, `view_image`, `spawn_agent`, `mcp__Air__*`, …) |
| `toolUseId` | `payload.call_id` |
| `input?` | `JSON.parse(payload.arguments)` (function_call) or raw custom payload; try/catch → `{}` on failure |

### 4.5 TokenUsage

| TokenUsage field | Codex source | Notes |
|---|---|---|
| `inputTokens` | `total_token_usage.input_tokens` | From **last** `token_count` (cumulative). |
| `outputTokens` | `total_token_usage.output_tokens` | |
| `cacheReadInputTokens` | `total_token_usage.cached_input_tokens` | |
| `cacheCreationInputTokens` | `0` | **No analog** — Codex has no cache-write metric. |
| `reasoningOutputTokens?` | `total_token_usage.reasoning_output_tokens` | Codex-only; separate TokenSummary line, NOT folded into `outputTokens` (Risk R4). |

> **Critical: cumulative, not additive.** Unlike Claude (per-call `usage` summed with `requestId` dedup), Codex
> `token_count` is a **running cumulative total**. The mapper takes the **last** `token_count` line as session
> totals. Per-model attribution uses `last_token_usage` deltas keyed to the active `turn_context.model`. This rule
> lives in the **pure mapper** and is covered by an in-memory unit test (no disk).

### 4.6 AgentInvocation (Codex sub-agents)

| AgentInvocation field | Codex source | Notes |
|---|---|---|
| `subagentType` | `spawn_agent` args | |
| `description` | `spawn_agent` args (prompt/description) | |
| `timestamp` | envelope timestamp | |
| `toolUseId` | `spawn_agent` `call_id` | |
| `durationMs?` | `wait_agent` ts − `spawn_agent` ts | best-effort pairing by call_id. |
| `model?` | active `turn_context.model` | |
| `tokens?` / `totalTokens?` / `totalToolUseCount?` / `toolCalls?` / `skills?` | **undefined** | Codex emits no sub-agent JSONL (no analog to Claude's `subagents/agent-*.jsonl`); only spawn/wait events. **In contract** — all optional (P7). |

> Codex agents render in the **same** `AgentsSkillsPanel`/`AgentDispatchesPanel` with fewer enrichments — the panel
> already handles optional fields. No subagent-discovery filesystem step for Codex.

### 4.7 SkillInvocation

| Field | Codex source |
|---|---|
| (all) | **Degrade to `[]`.** No per-session "Skill" events in the rollout. Panel shows its existing "No skills" empty state. In contract (`skills: SkillInvocation[]`, empty array is valid). |

### 4.8 TaskItem (Codex plan items)

| TaskItem field | Codex source (`update_plan` args) | Notes |
|---|---|---|
| `taskId` | synthesized `codex-plan-<index>` | no stable id. |
| `subject` | plan step text | |
| `description?` / `activeForm?` | undefined | |
| `status` | map step status → `pending`/`in_progress`/`completed` | `update_plan` overwrites whole plan; take the **latest**. |
| `timestamp` | envelope ts of latest `update_plan` | |

> Renders in the **same** `TasksPanel`. Optional Phase-4 stretch: derive transitions by diffing successive plans.

### 4.9 ContextWindowData

| Field | Codex source | Notes |
|---|---|---|
| `contextLimit` | `token_count.info.model_context_window` (fallback `task_started.model_context_window`) | **Real value** — better than Claude's hardcoded 200K. |
| `modelName` | active model | |
| `currentContextSize` | last `total_token_usage.input_tokens + cached_input_tokens` | mirrors Claude (cacheCreation=0). |
| `systemOverhead` / `messagesEstimate` / `freeSpace` / `autocompactBuffer` / `usagePercent` / `snapshots` | computed by the **shared** `buildContextWindowData()` from per-`token_count` snapshots | snapshots from each `token_count` cumulative input side. |

> **Note (P3 boundary):** `buildContextWindowData()` is currently a private function in `session-parser.ts` that
> hardcodes the 200K limit via `getContextLimit()`. To reuse it for Codex (which supplies a *real* limit), promote it
> to a small shared helper `lib/adapters/shared/context-window.ts` that accepts `contextLimit` as a parameter, and
> have Claude pass `200_000` and Codex pass the value from data. This is a *genuine* shared primitive (identical math,
> only the limit differs) — true DRY, unlike the scanner walk. Small, test-covered move.

### 4.10 Project / Stats aggregates

| Aggregate | Codex behavior |
|---|---|
| `ProjectAnalytics` (per `projectPath`) | Works unchanged — `aggregateProjectAnalytics()` groups by `projectPath` (verified). Cross-provider: same repo cwd merges into one project row (desirable). |
| `dailyActivity` / `dailyModelTokens` / `modelUsage` / `hourCounts` | Computed via `computeStatsFromSessions()` (no Codex stats-cache). Codex ids land in the same maps; charts render side by side. |
| `longestSession` / `totalSessions` / `totalMessages` | Summed across providers by the existing merge. |

### 4.11 Panel parity summary

| Panel / page | Claude | Codex | Degradation |
|---|---|---|---|
| Sessions list + card | full | full | branch omitted; +provider badge; +title if present |
| Session detail / Timeline | full | full | reasoning turns folded into assistant |
| TokenSummary | full | full | +reasoning line; cacheWrite shows 0 |
| ToolUsagePanel | full | full | Codex tool names |
| ContextWindowPanel | full | **better** | real context limit from data |
| Agents/Skills panel | full | partial | agents (spawn/wait, no sub-tokens); skills empty |
| TasksPanel | full | full | from `update_plan` (latest snapshot) |
| ErrorPanel | full | partial | from `turn_aborted` / nonzero exec |
| CostEstimationPanel | full | full | needs OpenAI pricing rows (Section 3.4) |
| Stats (all charts) | from stats-cache | computed | same charts |
| Project Analytics | full | full | shared by cwd |

---

## 5. Backend Changes, File-by-File

New slice: `lib/adapters/` (shared library code; lib must not import from features). **6 new modules + Codex folder**
(down from 9 per P5), plus targeted MODIFY edits.

```
lib/adapters/
  provider-registry.ts          NEW  pure constant: PROVIDERS, ProviderId, providerIdEnum, getProviderMeta (P2)
  adapter.ts                    NEW  SessionSourceAdapter interface + getAdapters()/getAdapter() registry (P5 merge)
  claude/claude-adapter.ts      NEW  thin wrapper over existing Claude fns (no logic change)
  codex/codex-path.ts           NEW  single source of truth for ~/.codex paths (mirrors claude-path)
  codex/codex-raw.types.ts      NEW  Zod envelope + payload union schemas; safeParse per line
  codex/codex-mapper.ts         NEW  PURE: CodexLine[] -> SessionSummary/SessionDetail (no fs) (P1)
  codex/codex-parser.ts         NEW  I/O: readline/head-tail -> CodexLine[] -> calls mapper (P1)
  codex/codex-scanner.ts        NEW  walk sessions/Y/M/D, mtime cache, + cached title lookup (folds index, P5)
  codex/codex-adapter.ts        NEW  implements SessionSourceAdapter incl. isActive (folds codex-active, P5)
  shared/jsonl-io.ts            NEW  readHeadLines / readTailLines / safeParseLine<T> (extracted, P3)
  shared/context-window.ts      NEW  buildContextWindowData(snapshots, contextLimit) (promoted from parser, P3)
```

### 5.1 `lib/adapters/provider-registry.ts` (NEW) — Section 3.1
Pure, client-safe. Single source of truth for provider id/label/badge + derived Zod enums.

### 5.2 `lib/adapters/adapter.ts` (NEW) — interface + registry (P5 merge)
Defines `SessionSourceAdapter`, `ProviderSource`, and the 4-line `getAdapters()`/`getAdapter(provider)`. Probes
`~/.codex` via `getCodexHome()`; includes `CodexAdapter` only when present. No provider-specific I/O here — delegates
to the concrete adapters.

### 5.3 `lib/adapters/claude/claude-adapter.ts` (NEW — thin wrapper, no logic change)
Implements `SessionSourceAdapter` by delegating to existing functions:
- `getSources()` → maps `getDataSources()` `DataSource[]` → `ProviderSource[]` (`rootDir = claudeDir`, `provider='claude'`).
- `scanSummaries(source)` → reuses `scanSessionsFromSource()` (stamps `provider='claude'`).
- `parseDetail(...)` → existing `parseDetail()` from `session-parser.ts` (stamp `provider`).
- `isActive(...)` → existing `isSessionActive()`.
- `findSessionFile(...)` → the existing `find-session-file.ts` logic, **moved here** (it becomes the Claude adapter's
  method, not a free function consumed directly — P6/DIP).

> Net effect on Claude code: stamp `provider:'claude'`; relocate `findSessionFile` behind the adapter. Zero
> behavioral change.

### 5.4 `lib/adapters/codex/codex-path.ts` (NEW — mirrors `claude-path.ts`)
```
getCodexHome(): string                 // CODEX_HOME env || ~/.codex   (computed once at module load)
getCodexSessionsDir(home)              // <home>/sessions
getCodexSessionIndexPath(home)         // <home>/session_index.jsonl
getCodexConfigPath(home)               // <home>/config.toml
getCodexSources(): Promise<ProviderSource[]>   // primary + (Phase 7) WSL parity
```
Single source of truth for all `~/.codex` paths. Does **not** decode dir names (Codex cwd is absolute).

### 5.5 `lib/adapters/codex/codex-raw.types.ts` (NEW)
Zod schemas for the envelope + payload unions; `safeParseLine` (from `shared/jsonl-io.ts`) returns a typed
`CodexLine | null` per line. Permissive unions + catch-all `unknown` branch for forward-compat (Risk R1).

### 5.6 `lib/adapters/codex/codex-mapper.ts` (NEW — PURE, P1)
No `fs`. Two functions over already-parsed/validated lines:
- `mapSummary(headLines, tailLines, ctx) → SessionSummary` (Section 4.1).
- `mapDetail(lines, ctx) → SessionDetail` (Sections 4.2–4.9), including the cumulative-token rule (last
  `token_count` wins) and per-model delta attribution.
Unit-tested entirely from in-memory `CodexLine[]` fixtures — this is the SRP win called out in P1.

### 5.7 `lib/adapters/codex/codex-parser.ts` (NEW — I/O only, P1)
- `parseSummary(filePath, ...)` → `readHeadLines` + large `readTailLines` (shared P3) → validate → `mapSummary`.
- `parseDetail(filePath, ...)` → `readline` stream → validate per line → `mapDetail`. No subagent file discovery.
- `parseOutputTokens(filePath)` → tail-only read of last `token_count.output_tokens` (cheap; list/project columns).

### 5.8 `lib/adapters/codex/codex-scanner.ts` (NEW)
- Walk `sessions/YYYY/MM/DD/` recursively, collect `rollout-*.jsonl`.
- mtime in-memory `Map` cache keyed by `codex:<sessionId>` (same *pattern* as `session-scanner.ts`, **not** a shared
  abstraction — P3).
- **Title lookup folded in (P5):** a small cached `Map<sessionId, thread_name>` loaded from
  `session_index.jsonl` (mtime-guarded, tolerates missing file). No separate `codex-session-index.ts`.
- For each file: call `codex-parser.parseSummary`; returns `SessionSummaryWithPath[]`.

### 5.9 `lib/adapters/codex/codex-adapter.ts` (NEW)
Implements `SessionSourceAdapter`:
- `getSources()` → `getCodexSources()`.
- `scanSummaries(source)` → `codex-scanner`.
- `parseDetail(...)` → `codex-parser.parseDetail`.
- `isActive(filePath)` → **folded in (P5):** `stat.mtimeMs < 120_000` AND last parsed envelope is NOT `event_msg`
  with `payload.type === 'task_complete'`. Imports `ACTIVE_THRESHOLD_MS` from `active-detector.ts` (P3 — no duplicate
  constant). No separate `codex-active.ts`.
- `findSessionFile(sessionId, projectPath)` → walk `sessions/**` for the matching `rollout-*<sessionId>*.jsonl`.

### 5.10 `lib/adapters/shared/jsonl-io.ts` (NEW — extracted primitives, P3)
`readHeadLines(filePath, n)`, `readTailLines(filePath, n)`, `safeParseLine<T>(line): T | null`. Pure text/byte
plumbing, no provider knowledge. **`session-parser.ts` is refactored to import these** (removing its private copies) —
small, covered by existing parser tests.

### 5.11 `lib/adapters/shared/context-window.ts` (NEW — promoted helper, P3)
`buildContextWindowData(snapshots, contextLimit)`. Claude passes `200_000`; Codex passes the real value from data.
Identical math, parameterized limit. `session-parser.ts` imports it (removing its private copy).

### 5.12 `lib/scanner/session-scanner.ts` (MODIFY — generalize to provider × source)
- `scanAllSessions()` → iterate `getAdapters()`; for each adapter iterate `adapter.getSources()`; call
  `adapter.scanSummaries(source)`; concatenate; dedup; sort. **This replaces the current single-source body.**
- Dedup key becomes `${provider}:${sessionId}` (provider-scoping is future-proof and prevents any cross-provider
  uuid collision). Keep newest `lastActiveAt` on dedup.
- `scanAllSessionsWithPaths()`, `getActiveSessions()` unchanged in signature; they consume the generalized scan.
- Keep `scanSessionsFromSource()` (Claude) as the Claude adapter's worker — minimal churn. The legacy
  `scanAllSessionsMultiSource()` is superseded by the adapter loop and removed (or left unused/deprecated).

### 5.13 `lib/scanner/active-detector.ts` (MODIFY — minor)
Export `ACTIVE_THRESHOLD_MS` for reuse by `CodexAdapter.isActive` (P3). No behavior change to Claude detection.

### 5.14 `features/session-detail/session-detail.api.ts` (MODIFY — DIP routing, P6)
**Ground-truth correction:** the current input validator is a passthrough `(input) => input`, not a Zod schema.
Replace it with a Zod schema `{ sessionId, projectPath, provider: providerIdEnum.optional() }` (from
`provider-registry`).
Resolution:
- If `provider` present → `getAdapter(provider).findSessionFile(...)` then `getAdapter(provider).parseDetail(...)`.
- If absent (old bookmarked links) → probe adapters in order via `findSessionFile` (back-compat, Risk R8).
No direct import of the concrete `parseDetail`/`findSessionFile` — everything goes through the adapter (P6). The
free-function `find-session-file.ts` is absorbed into `ClaudeAdapter` (5.3).

### 5.15 `lib/parsers/stats-parser.ts` (MODIFY — provider-aware via the adapter, P6)
- `parseDetailsInBatches()` currently imports and calls the concrete `parseDetail`. Change it to
  `getAdapter(session.provider).parseDetail(...)` so each session is parsed by its own provider's adapter (the
  summary carries `provider`). This makes Stats automatically include Codex with no provider `if` anywhere.
- `parseStats()` reads Claude's `stats-cache.json` for Claude history; recent sessions (now including Codex) fold in
  via `mergeRecentSessions()` (which uses the generalized scan). To guarantee **full** Codex history (older than
  Claude's `lastComputedDate`), compute the Codex portion via `computeStatsFromSessions()` filtered to
  `provider==='codex'` and `mergeStatsCaches([claudeStatsCache, codexComputed])`. `mergeStatsCaches()` already sums
  per-date/per-model — reuse verbatim.

### 5.16 `features/settings/app-info.api.ts` (MODIFY — cosmetic)
`appPath` currently hardcodes `~/.claude`. Add `codexPath?` + `providers: ProviderId[]` (derived from which adapters
are available), or generalize the footer string. Low-risk.

### 5.17 Server functions that need NO change
`features/project-analytics/project-analytics.api.ts`, `features/stats/stats.api.ts`,
`features/settings/settings.api.ts` — all consume normalized types and are provider-agnostic.
`features/sessions/sessions.api.ts` needs only the provider **filter** addition (6.3) — the `scanAllSessions()` call
is unchanged because the generalization is inside the scanner.

---

## 6. Frontend Changes, File-by-File

### 6.1 `components/ui/ProviderBadge.tsx` (NEW — derives from registry, P2)
Reads label + `badgeClass` from `getProviderMeta(provider)` (`provider-registry.ts`) — **no hardcoded
claude/codex literals or colors in the component.** Mirrors `SourceBadge` styling. Show both badges (provider +
source) when relevant. Adding provider #3 needs zero edits here.

### 6.2 `features/sessions/SessionCard.tsx` (MODIFY)
- Render `<ProviderBadge provider={session.provider} />` next to `StatusBadge`.
- If `session.title` present, show it as the card heading (fallback to `projectName`).
- **Resume command must be provider-aware (DIP-lite via registry).** Current `handleCopy` hardcodes
  `claude --resume <id>`. Drive the template from the provider: `claude --resume <id>` for Claude,
  `codex resume <id>` for Codex (confirm exact invocation in Q1). Keep the per-provider command string in
  `provider-registry.ts` (e.g. `resumeCommand(id)`) so it is one place, not scattered in the card.
- Model abbrev: `model.replace(/^claude-/, '').split('-202')[0]` leaves `gpt-5.5` untouched — safe (verified).

### 6.3 `features/sessions/SessionFilters.tsx` + `routes/_dashboard/sessions/index.tsx` (MODIFY)
- Add a **provider filter** dropdown whose options are generated from `PROVIDERS` (P2) — `All` + one per provider.
  Only render when `getAdapters()` would yield >1 provider (mirrors the existing `projects.length > 1` guard).
- Extend `sessionsSearchSchema` (route) and `paginatedSessionsInputSchema` (server fn) with
  `provider: providerFilterEnum.default('all')` — **both import the enum from `provider-registry.ts`** (no duplicate
  `z.enum(['all','claude','codex'])`).
- `paginateAndFilterSessions()` adds one clause: `if (provider !== 'all') filtered = filtered.filter(s => s.provider === provider)`.
- Page subtitle copy: replace hardcoded "All Claude Code sessions from ~/.claude" with copy derived from available
  providers (e.g. "All Claude Code and Codex sessions").

### 6.4 `components/AppShell.tsx` (MODIFY — copy)
Header "Claude Dashboard" → keep brand or rename to provider-neutral (e.g. "Agent Sessions"). Decide in Q2.

### 6.5 `features/session-detail/*` (MOSTLY UNCHANGED)
- `AgentsSkillsPanel` — already handles optional agent fields and empty skills; verify Codex renders cleanly (P7).
- `TokenSummary` — add an optional "Reasoning" line when `reasoningOutputTokens` present.
- `ContextWindowPanel` — unchanged; now shows real Codex limit.
- Detail header — `ProviderBadge` + `title` if present.

### 6.6 `features/cost-estimation/*` (MODIFY data, not logic)
- `cost-calculator.ts` matches `tokensByModel` keys against `DEFAULT_PRICING` via `normalizeModelId` (verified import
  at `cost-calculator.ts:3,42`). Adding OpenAI rows (Section 3.4) makes Codex costs compute with **zero logic
  change**. `cacheWritePerMTok` for OpenAI = 0. Reasoning-as-output cost: decide per Risk R4 / Q3.

### 6.7 `features/settings/SettingsPage.tsx` + `PricingTableEditor.tsx` (MINOR)
Pricing editor iterates `DEFAULT_PRICING` — automatically lists new OpenAI rows. Optionally group by provider.

### 6.8 "Claude-ness" copy hotspots (grep targets)
- `routes/_dashboard/sessions/index.tsx`: "All Claude Code sessions from ~/.claude" (verified).
- `components/AppShell.tsx`: title string.
- `features/settings/app-info.api.ts`: `~/.claude` appPath.
- `SessionCard.tsx` resume command (→ registry).
- Any "No sessions found in ~/.claude" empty-state string.
- README / product spec (out of code scope; note for product-owner).

### 6.9 What stays UNCHANGED
Queries (`*.queries.ts`) — only `sessionDetailQuery` gains an optional `provider` in its key; pagination passes
`provider` through params (already generic). All Recharts components, `ProjectTable`, `StatusBadge`, `RunningTimer`,
`PaginationControls`, privacy/theme — untouched.

---

## 7. Phased Implementation Roadmap

Each phase is a vertical slice that compiles and passes the gates. Quality gate after every phase:
`npm run typecheck && npm run lint && npm test && npm run build` (in `apps/web`).

**Phase 0 — Adapter seam + registries (no Codex yet, pure refactor).**
- Create `provider-registry.ts` (P2) and `adapter.ts` (interface + registry, P5).
- Add `provider` (typed from registry) to `SessionSummary`/`SessionDetail` (default `'claude'`).
- Create `claude-adapter.ts` wrapping existing logic; move `find-session-file.ts` behind it (P6).
- Extract `shared/jsonl-io.ts` + `shared/context-window.ts`; refactor `session-parser.ts` to import them (P1/P3).
- Generalize `session-scanner.ts` to iterate adapters (only Claude registered).
- **Outcome:** Identical behavior; provider field present; shared primitives in place; tests green. De-risks the
  refactor before Codex.

**Phase 1 — Codex read path (summaries only).**
- `codex-path.ts`, `codex-raw.types.ts`, `codex-mapper.ts` (`mapSummary`), `codex-parser.ts`
  (`parseSummary`/`parseOutputTokens`), `codex-scanner.ts` (walk + title), `codex-adapter.ts` (incl. `isActive`);
  register in `adapter.ts`.
- **Outcome:** Codex sessions appear in the list with correct summary fields, active status, output tokens, title.
  Project Analytics works (consumes summaries).

**Phase 2 — Provider badge + filter + copy.**
- `ProviderBadge` (registry-driven), SessionCard badge/title/resume, provider filter (route + server fn +
  `paginateAndFilterSessions`, enum from registry), dynamic copy.
- **Outcome:** Mixed-provider UX is navigable and filterable.

**Phase 3 — Codex Session detail.**
- `codex-mapper.mapDetail` + `codex-parser.parseDetail` (turns, cumulative tokens, tokensByModel, toolFrequency,
  context window via shared helper, errors).
- `session-detail.api.ts` provider routing (Zod input + adapter dispatch, P6); `sessionDetailQuery` provider key.
- TokenSummary reasoning line.
- **Outcome:** Codex detail page reaches parity (sans agents/skills/tasks).

**Phase 4 — Codex agents, tasks, errors enrichment.**
- `spawn_agent`/`wait_agent` → AgentInvocation; `update_plan` → TaskItem; `turn_aborted`/exec exit → errors (all in
  the mapper).
- **Outcome:** Agents/Tasks panels populated; skills degrade gracefully.

**Phase 5 — Stats parity.**
- `stats-parser.ts`: route per-session `parseDetail` through `getAdapter(session.provider)` (P6); compute Codex
  stats and `mergeStatsCaches` with Claude.
- **Outcome:** Stats charts include Codex models/activity.

**Phase 6 — Cost + settings.**
- OpenAI pricing rows in `DEFAULT_PRICING`; `normalizeModelId` no-op test; reasoning-cost decision; pricing editor
  grouping.
- **Outcome:** CostEstimationPanel renders Codex costs.

**Phase 7 — Polish + cross-provider edge cases.**
- WSL parity for Codex (optional), app-info copy, empty/error states, README/spec (product-owner).

---

## 8. Testing Strategy

**Fixtures.** Add `apps/web/e2e/fixtures/.codex/sessions/2026/06/01/rollout-<ts>-<uuid>.jsonl` covering: (a) normal
completed (ends `task_complete`), (b) active (no `task_complete`, fresh mtime), (c) `spawn_agent`/`wait_agent`, (d)
`update_plan`, (e) old vs new `cli_version` schemas. Add `session_index.jsonl` with partial title coverage. Point
tests at `CODEX_HOME` env (mirroring Claude's `CLAUDE_HOME`).

**Unit tests (co-located `*.test.ts`).**
- `codex-mapper.test.ts` (**pure, no filesystem — the P1 payoff**): feed in-memory `CodexLine[]`; assert summary
  field mapping; cumulative-token correctness (last `token_count` wins, not summed); per-model attribution across
  `turn_context.model` changes; reasoning tokens captured; tool taxonomy counts; `update_plan` → tasks (latest
  snapshot); spawn/wait → agents with duration; degraded skills `[]`; context window from data.
- `codex-parser.test.ts` (I/O): head/tail reads produce the right `CodexLine[]`; malformed line skipped; old vs new
  `cli_version` both parse; `parseOutputTokens` tail-only correctness.
- `codex-adapter.test.ts`: `isActive` (fresh+no-complete → active; fresh+complete → inactive; stale → inactive);
  `findSessionFile` locates by id.
- `codex-scanner.test.ts`: recursive date-folder walk; mtime cache hit/miss; title lookup with/without index file.
- `claude-adapter.test.ts`: stamps `provider:'claude'`, otherwise identical output to legacy functions (snapshot
  equivalence).
- `provider-registry.test.ts`: enum/ids/meta derive consistently; adding a provider to `PROVIDERS` flows to the Zod
  enum (guards P2).
- `shared/jsonl-io.test.ts`: head/tail/safeParse primitives (covers the extraction, P3).
- `shared/context-window.test.ts`: parameterized limit math (Claude 200K vs Codex real value).
- `session-scanner.test.ts` (extend): provider × source dedup; cross-provider same-`sessionId` does NOT collide.
- `paginateAndFilterSessions` (extend): provider filter.
- `settings.types.test.ts` (extend): `normalizeModelId('gpt-5-codex') === 'gpt-5-codex'` (confirms no-op, replaces
  the dropped "guard").

**Parity test (LSP guard, P7).** Table-driven: for each required `SessionDetail`/`SessionSummary` field, assert both
adapters produce a correctly-typed value for a representative fixture — catches a Codex field silently `undefined` in
a *required* slot, and asserts panels' required props are present.

**E2E (Playwright).** Extend `sessions.spec.ts`/`session-detail.spec.ts`: Codex cards render, provider badge shows,
provider filter narrows the list, a Codex detail page renders token/tool/context panels.

---

## 9. Risks & Mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Schema evolution across `cli_version`.** | Zod-validate each line with permissive unions + catch-all `unknown`; `safeParseLine` per line, skip on failure. Fixtures for old+new versions. The **mapper** is the single change point when Codex adds fields. |
| R2 | **Cumulative-token mis-handling** (summing vs last). | "Last `token_count` wins" lives in the pure mapper; dedicated in-memory unit test. Documented in 4.5. |
| R3 | **Performance over many session files.** | mtime in-memory cache keyed by `codex:<id>`; summary = head + bounded tail (shared `jsonl-io`); `parseDetail` streamed via `readline`; stats batch concurrency (existing `parseDetailsInBatches`, batch 10); lazy date-folder walk. |
| R4 | **Reasoning tokens & cost correctness.** | Keep `reasoningOutputTokens` separate for display; in `cost-calculator`, bill reasoning at the output rate (configurable). Document; expose in pricing editor. (Q3.) |
| R5 | **Mixed-provider UX confusion.** | Provider badge (registry-driven) on every card + provider filter; provider-scoped dedup key; shared project rows by cwd is intentional (UI tooltip). |
| R6 | **Active detection false positives** (no lock dir). | mtime < 2 min AND last event != `task_complete`. Most sessions end with `task_complete`, making this reliable. |
| R7 | **Title coverage partial / index missing.** | Title optional; fallback chain thread_name → first user message → cwd basename. No hard dependency. |
| R8 | **`getSessionDetail` back-compat** (old links lack `provider`). | `provider` optional in input; when absent, probe adapters in order via `findSessionFile`. |
| R9 | **Cost panel shows $0 for Codex models** if pricing missing. | Phase 6 adds OpenAI rows; calculator no-ops unknown models gracefully. |
| R10 | **Read-only invariant** must extend to `~/.codex`. | Codex path is read-only (scan/stat/read only). Lint/review checklist item. Settings writes remain in `~/.claude-dashboard`. |
| R11 | **Refactor regressions from extracting shared primitives** (P1/P3 touch the proven Claude parser). | Extraction is mechanical (move `readHeadLines`/`readTailLines`/`safeParse`/`buildContextWindowData` out, import them back); existing `session-parser.test.ts` must stay green unchanged. Done in Phase 0, isolated from Codex, so any regression surfaces before Codex code exists. |

---

## 10. Open Questions & Confidence

### Open Questions (none are blockers; all have safe defaults)
- **Q1 (resume command).** Exact Codex resume invocation for the copy button. **Default:** `codex resume <id>` in
  `provider-registry.resumeCommand`; verify against installed Codex CLI in Phase 2. Cosmetic.
- **Q2 (app/brand naming).** Keep "Claude Dashboard" or rename provider-neutral? **Default:** keep brand, change only
  the Sessions subtitle. Product/UX call.
- **Q3 (reasoning-token cost).** Bill `reasoning_output_tokens` at output rate or exclude? **Default:** bill at
  output rate (matches OpenAI), surfaced separately, configurable.
- **Q4 (Codex WSL parity).** Mirror WSL multi-distro detection for `~/.codex`? **Default:** Phase 7 stretch; primary
  source first.

These are deferred with documented defaults; none change the adapter architecture, type model, or phase plan.

### Final Confidence: **0.97** (was 0.96)

**Why it moved up (+0.01).** The design-principles pass replaced *inferred* claims with *verified* ones and removed
two latent defects that the first draft would have shipped:
- Corrected the false "every scanner already loops over `DataSource[]`" assumption — the live path is single-source
  `scanAllSessions()`; the generalization target is now stated precisely (Section 2.1), removing an integration
  surprise.
- Corrected the `normalizeModelId` over-engineering — verified via `settings.types.test.ts` that the 8-digit guard
  already protects `gpt-5.5`/`gpt-5-codex`, so a needless code change was dropped (YAGNI) and replaced with a
  one-line confirming test.
- Corrected the `getSessionDetail` input validator (passthrough, not Zod) — the routing change is now stated against
  the real signature.
- Made the Codex mapper filesystem-free (P1), which converts the riskiest logic (cumulative tokens, per-model
  attribution) into pure, in-memory unit tests — directly shrinking the residual-uncertainty surface.
- Reduced new backend files 9→6 and removed the duplicated provider enum, lowering the maintenance/error surface.

**The residual 0.03** is honest uncertainty that only live data can close: (a) `cli_version` schema drift may surface
payload shapes not in the 24 sampled sessions (mitigated by permissive Zod + per-line `safeParse`); (b) exact
per-turn token-delta attribution to `turn_context.model` may need tuning against real multi-model sessions; (c) the
four Open Questions carry minor cosmetic/cost decisions. None threaten the architecture, the type model, or the phase
plan.

---

## Revision Changelog

**2026-06-18 — Design-quality pass (SOLID / KISS / DRY / SOC).**

1. **Added Section 0** — principle-by-principle review table (P1–P8) with explicit keep/change decisions and a note
   on the intentional Claude/Codex asymmetry.
2. **P2 (DRY/OCP):** Introduced `lib/adapters/provider-registry.ts` as the single source of truth for provider
   id/label/badge + derived Zod enums. Removed the provider enum duplication across `types.ts`, the route schema, the
   server-fn schema, the badge, and the filter (Sections 3.1, 3.2, 5.14, 6.1, 6.3).
3. **P1 (SRP/SOC):** Split the Codex parser into a **pure** `codex-mapper.ts` (no `fs`) + a thin I/O
   `codex-parser.ts`; left Claude's `session-parser.ts` intentionally monolithic (documented rationale).
4. **P3 (DRY):** Extracted three genuinely-shared primitives — `shared/jsonl-io.ts` (head/tail/safeParse) and
   `shared/context-window.ts` (parameterized `buildContextWindowData`) — and refactored `session-parser.ts` to use
   them; explicitly declined to share the scanner walk / summary cache (false DRY).
5. **P5 (KISS/file-count):** Reduced new backend files 9→6 — merged `types.ts`+`registry.ts` into `adapter.ts`;
   folded `codex-active.ts` and `codex-session-index.ts` into `codex-adapter.ts` / `codex-scanner.ts`.
6. **P6 (DIP):** Routed `session-detail.api.ts` and `stats-parser.ts` through `getAdapter(provider)` instead of
   concrete provider functions; absorbed `find-session-file.ts` into `ClaudeAdapter`.
7. **P4/P7 (ISP/LSP):** Kept the 5-method adapter interface (cohesive, KISS over ISP theater); confirmed optional-
   field degradation is in-contract and added a parity test as the LSP guard instead of a heavier capability
   discriminator.
8. **Ground-truth corrections:** the live read path is single-source `scanAllSessions()` (not the multi-source
   merge); `normalizeModelId` already guards non-date suffixes (dropped the needless guard, added a confirming test);
   `getSessionDetail`'s validator is a passthrough (Zod input now specified against the real signature).
9. **Confidence recalibrated 0.96 → 0.97** with justification for the move.

**Net:** simpler (fewer files), DRYer (one provider registry, three shared primitives), cleaner separation (pure
mapper, adapter-routed detail/stats) — without churning the proven Claude parser or abstracting for a non-existent
third provider.
