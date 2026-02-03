# AI Personal Assistant — Project Plan

> Name: **Shard**
> Stack: Bun.js + TypeScript + SurrealDB

---

## 0. Terminology

| Term | Definition |
|------|-----------|
| **Runtime** | The core process that boots the system, loads plugins, and manages the lifecycle of all components. |
| **Plugin** | A self-contained npm package that extends the system. Channels, model providers, tools, and agent definitions are all plugins. Each plugin is its own publishable package that depends on `@shard/sdk` for type contracts. |
| **Plugin Registry** | The in-process registry where loaded plugins register themselves at runtime. Handles initialization order, dependency resolution, and lifecycle. |
| **Package Manager** | Core subsystem that resolves, installs, updates, and removes plugin packages. Wraps `bun install` under the hood. Reads desired plugins from config, diffs against what's installed, and reconciles on startup. |
| **Plugin Manifest** | The standardized `package.json` fields and default export contract that a package must satisfy to be recognized as a valid plugin. Includes a `"plugin"` field declaring the plugin type. |
| **SDK Package** | `@shard/sdk` — the shared types package that all plugins depend on. Contains interfaces (`Plugin`, `Channel`, `ModelProvider`, `Tool`, `AgentDefinition`), base classes, and utilities. Published to the same registry as the core. |
| **Scope** | The npm scope `@shard` used for first-party packages. Third-party plugins can use any scope or be unscoped. |
| **Event Bus** | Typed pub/sub system for decoupled communication between plugins and core components. |
| **Channel** | A plugin that connects to an external messaging platform (Telegram, Discord, etc.) and translates between platform-native messages and the internal `IncomingMessage`/`OutgoingMessage` types. |
| **Model Provider** | A plugin that wraps an LLM API (Anthropic, OpenAI, Ollama, etc.) behind a common `chat()`/`stream()` interface. |
| **Tool** | A plugin that exposes a capability (shell, browser, filesystem, HTTP) the agent can invoke. Defined by a name, description, JSON Schema for parameters, and an `execute()` function. |
| **Agent Definition** | A declarative template describing an agent's role: its system prompt, allowed tools, model override, output schema, and iteration limits. Can be defined in TOML or TypeScript. |
| **Agent Instance** | A running agent created from an Agent Definition. Has its own message history, status, and result. |
| **Primary Agent** | The top-level agent that directly handles user messages from channels. Has `parentId: null`. |
| **Sub-Agent** | An agent spawned by another agent (the parent) to handle a specific subtask. Runs its own agent loop with scoped context and tools. |
| **Delegation** | The act of a parent agent spawning one or more sub-agents via the `delegate` meta-tool. |
| **Agent Scheduler** | Controls concurrency, queuing, depth limits, and token budgets for all running agent instances. |
| **Orchestration Strategy** | The execution pattern for a group of delegated sub-agents: **parallel** (fan-out/fan-in), **sequential** (chained), or **pipeline** (typed data flow). |
| **Fan-Out / Fan-In** | Parallel pattern where N agents run concurrently (fan-out) and their results are collected and merged by the parent (fan-in). |
| **Pipeline** | Sequential pattern where each agent's structured output (conforming to an `outputSchema`) becomes the input for the next agent. |
| **Supervisor** | A meta-agent whose only tool is `delegate`. It dynamically decides which sub-agents to spawn based on reasoning, rather than following a hardcoded plan. |
| **Agent Run** | A SurrealDB record tracking a single agent execution — its definition, parent, status, result, and token usage. Linked to other runs via the `spawned` relation. |
| **Scratchpad** | Agent-local key-value working state that persists across tool-call iterations within a single agent run but is not shared with other agents. |
| **Shared Memory** | Read access a sub-agent has to the parent's `MemoryService`, allowing it to query the knowledge graph and conversation history without duplicating data. |
| **Context Builder** | Assembles the LLM prompt for an agent by combining conversation history, relevant facts from SurrealDB, system prompt, user preferences, and (for sub-agents) the parent's instruction. |
| **Knowledge Graph** | The SurrealDB-backed graph of entities and their relations/facts. Entities (people, projects, topics) are linked by typed edges (`knows`, `belongs_to`, `has_fact`). |
| **Fact** | A discrete piece of learned information attached to an entity, with a confidence score and a source message reference. |
| **Artifact** | A file, screenshot, or other output produced by a tool or agent as a side-effect of execution. |
| **Heartbeat** | A proactive behavior where the system wakes on a schedule (cron) to check conditions and potentially spawn agents without user prompting. |

---

## 1. Architecture Overview

Plugin-first architecture where channels, model providers, tools, and capabilities are all **separate npm packages** that register with a central runtime. The core auto-installs plugins declared in config from any npm-compatible registry.

```
                        ┌─────────────────────┐
                        │   npm / registry     │
                        │   (npmjs, GitHub,    │
                        │    private, etc.)    │
                        └─────────┬───────────┘
                                  │ bun install
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│                        Core Runtime                           │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────────┐  │
│  │  Package    │  │  Plugin    │  │  Config                │  │
│  │  Manager    │  │  Registry  │  │  Manager               │  │
│  └────────────┘  └────────────┘  └────────────────────────┘  │
│  ┌────────────┐                                              │
│  │  Event Bus  │                                              │
│  └────────────┘                                              │
├──────────────────────────────────────────────────────────────┤
│                     Agent Orchestrator                         │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────────┐  │
│  │  Message    │  │  Agent     │  │  Context               │  │
│  │  Router     │  │  Scheduler │  │  Builder               │  │
│  └────────────┘  └────────────┘  └────────────────────────┘  │
│                                                               │
│  ┌───────────────────────────────────────────────────────┐    │
│  │              Agent Execution Engine                    │    │
│  │                                                       │    │
│  │  Primary Agent                                        │    │
│  │    ├── Sub-Agent A  ──┐                               │    │
│  │    ├── Sub-Agent B  ──┼── parallel group (fan-out)    │    │
│  │    ├── Sub-Agent C  ──┘                               │    │
│  │    │       ▼                                          │    │
│  │    │   fan-in (merge results)                         │    │
│  │    │       ▼                                          │    │
│  │    └── Sub-Agent D  ── sequential (depends on above)  │    │
│  │                                                       │    │
│  └───────────────────────────────────────────────────────┘    │
├──────────┬──────────┬──────────┬─────────────────────────────┤
│ Channels │ Models   │ Tools    │ Memory                       │
│ (npm pkg)│ (npm pkg)│ (npm pkg)│ (SurrealDB)                  │
│          │          │          │                               │
│ @scope/  │ @scope/  │ @scope/  │ Conversations                 │
│ channel- │ model-   │ tool-    │ Facts (graph)                 │
│ telegram │ anthropic│ shell    │ Preferences                   │
│          │          │          │ Sessions                      │
│ community│ community│ community│ Agent Runs (parent ↔ child)   │
│ packages │ packages │ packages │                               │
└──────────┴──────────┴──────────┴─────────────────────────────┘

Shared:  @scope/sdk  (types, base classes, utilities)
```

---

## 2. Core Abstractions

### 2.1 Plugin System (npm Packages)

Every plugin is a **standalone npm package** that exports a default conforming to the `Plugin` interface from `@shard/sdk`. First-party plugins live under the project's npm scope (e.g., `@shard/channel-telegram`). Third-party plugins can use any package name.

#### SDK Package (`@shard/sdk`)

Published as a separate package. All plugins list it as a `peerDependency`:

```typescript
// @shard/sdk — the shared contract

export interface Plugin {
  name: string;
  version: string;
  type: "channel" | "model" | "tool" | "agent";
  dependencies?: string[];              // other plugin names this depends on
  init(ctx: PluginContext): Promise<void>;
  destroy?(): Promise<void>;
}

export interface PluginContext {
  events: EventBus;
  config: ConfigManager;
  memory: MemoryService;
  logger: Logger;
}

// Re-exports all interfaces: Channel, ModelProvider, Tool, AgentDefinition, etc.
```

#### Plugin Package Contract

A valid plugin package must:

1. **Default-export** a factory function or Plugin object
2. **Declare its type** in `package.json` via a `"plugin"` field
3. **Peer-depend** on `@shard/sdk`

```jsonc
// Example: package.json for @shard/channel-telegram
{
  "name": "@shard/channel-telegram",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "plugin": {
    "type": "channel",                   // channel | model | tool | agent
    "displayName": "Telegram",
    "configSchema": {                    // JSON Schema for this plugin's config
      "type": "object",
      "properties": {
        "token": { "type": "string", "env": "TELEGRAM_BOT_TOKEN" }
      },
      "required": ["token"]
    }
  },
  "peerDependencies": {
    "@shard/sdk": "^1.0.0"
  }
}
```

```typescript
// Example: src/index.ts for a plugin package
import { Channel, PluginContext, IncomingMessage, OutgoingMessage } from "@shard/sdk";

const plugin: Channel = {
  name: "telegram",
  version: "1.0.0",
  type: "channel",

  async init(ctx: PluginContext) {
    const token = ctx.config.get("channels.telegram.token");
    // ... set up grammy bot
  },

  async send(conversationId, message) { /* ... */ },
  onMessage(handler) { /* ... */ },

  async destroy() { /* ... */ },
};

export default plugin;
```

#### Package Manager

The core runtime includes a **Package Manager** that automatically installs, updates, and loads plugins declared in config:

```typescript
interface PackageManager {
  // Reconcile installed packages against config on startup
  sync(): Promise<SyncResult>;

  // Install a plugin package (calls `bun add` under the hood)
  install(packageName: string, version?: string): Promise<void>;

  // Remove a plugin package
  remove(packageName: string): Promise<void>;

  // Update all plugins or a specific one
  update(packageName?: string): Promise<void>;

  // Load and validate a plugin from node_modules
  load(packageName: string): Promise<Plugin>;

  // List installed plugin packages with their metadata
  list(): Promise<InstalledPlugin[]>;
}

interface SyncResult {
  installed: string[];    // newly installed packages
  updated: string[];      // packages that were updated
  removed: string[];      // packages that were uninstalled
  failed: Array<{ package: string; error: string }>;
}

interface InstalledPlugin {
  packageName: string;
  version: string;
  type: "channel" | "model" | "tool" | "agent";
  displayName: string;
  status: "loaded" | "disabled" | "error";
}
```

#### Startup Flow

```
1. Read config → extract [plugins] section
2. PackageManager.sync()
   ├── Diff declared plugins vs installed packages (node_modules)
   ├── `bun add <pkg>@<version>` for missing / outdated
   ├── `bun remove <pkg>` for plugins removed from config
   └── Validate each package has a valid plugin manifest
3. For each installed plugin:
   ├── import(packageName) → get default export
   ├── Validate it conforms to Plugin interface
   ├── Resolve dependencies (topological sort)
   └── Call plugin.init(ctx) in dependency order
4. Runtime is ready
```

#### Naming Convention

| Type | First-party pattern | Example |
|------|-------------------|---------|
| Channel | `@shard/channel-<name>` | `@shard/channel-telegram` |
| Model | `@shard/model-<name>` | `@shard/model-anthropic` |
| Tool | `@shard/tool-<name>` | `@shard/tool-shell` |
| Agent | `@shard/agent-<name>` | `@shard/agent-researcher` |
| SDK | `@shard/sdk` | `@shard/sdk` |
| Core | `@shard/core` | `@shard/core` |

Third-party plugins can use any name — the `"plugin"` field in `package.json` is what identifies them, not the name.

### 2.2 Channel Interface

```typescript
interface Channel extends Plugin {
  type: "channel";
  send(conversationId: string, message: OutgoingMessage): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
}

interface IncomingMessage {
  id: string;
  conversationId: string;
  senderId: string;
  content: MessageContent;  // text, media, location, etc.
  timestamp: Date;
  channel: string;
  raw: unknown;  // original platform payload
}

interface OutgoingMessage {
  content: MessageContent;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

type MessageContent =
  | { type: "text"; text: string }
  | { type: "media"; url: string; mimeType: string; caption?: string }
  | { type: "rich"; blocks: RichBlock[] };  // for structured UI
```

### 2.3 Model Provider Interface

```typescript
interface ModelProvider extends Plugin {
  type: "model";
  models: ModelInfo[];

  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncGenerator<ChatChunk>;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  finishReason: "stop" | "tool_use" | "max_tokens";
}
```

### 2.4 Agent Definition & Sub-Agent Interface

Agents are defined declaratively. The primary agent can spawn sub-agents to delegate work — either sequentially or in parallel. Each sub-agent gets its own isolated context, tool set, and optionally a different model.

```typescript
// An agent definition is a reusable template
interface AgentDefinition {
  name: string;
  description: string;                 // used by parent agent to decide when to delegate
  systemPrompt: string;                // role & instructions for this agent
  model?: string;                      // override model (e.g. use haiku for simple tasks)
  tools?: string[];                    // allowed tool names (scoped subset)
  maxIterations?: number;              // tool-call loop limit
  outputSchema?: JSONSchema;           // structured output the agent must return
}

// A running agent instance
interface AgentInstance {
  id: string;
  definition: AgentDefinition;
  parentId: string | null;             // null = primary agent
  status: "running" | "completed" | "failed" | "cancelled";
  context: AgentContext;
  result?: AgentResult;
}

interface AgentContext {
  conversationId: string;
  senderId: string;
  messages: ChatMessage[];             // this agent's own message history
  sharedMemory: MemoryService;         // read access to parent's memory
  scratchpad: Record<string, unknown>; // agent-local working state
}

interface AgentResult {
  output: string;                      // natural language summary
  structured?: unknown;                // parsed against outputSchema if defined
  artifacts?: Artifact[];
  tokenUsage: { input: number; output: number };
}
```

#### Spawning Sub-Agents

The primary agent spawns sub-agents via a built-in `delegate` tool:

```typescript
// The "delegate" meta-tool available to any agent
interface DelegateTool {
  name: "delegate";
  description: "Spawn one or more sub-agents to handle subtasks";
  parameters: {
    tasks: DelegateTask[];
    strategy: "parallel" | "sequential" | "pipeline";
  };
}

interface DelegateTask {
  agent: string;           // name of an AgentDefinition
  instruction: string;     // what to do (becomes the user message)
  context?: string;        // additional context from the parent
  dependsOn?: string[];    // task IDs this must wait for (for sequential/pipeline)
}
```

#### Orchestration Patterns

```
┌─────────────────────────────────────────────────────────┐
│                   Parallel (fan-out / fan-in)             │
│                                                          │
│  Instruction: "Research X from 3 angles"                 │
│                                                          │
│     ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│     │ Agent A   │  │ Agent B   │  │ Agent C   │           │
│     │ (angle 1) │  │ (angle 2) │  │ (angle 3) │           │
│     └─────┬────┘  └─────┬────┘  └─────┬────┘            │
│           └──────────┬───┴─────────────┘                 │
│                      ▼                                   │
│              Merge / Summarize                           │
│              (parent agent)                              │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                   Sequential                             │
│                                                          │
│     ┌──────────┐      ┌──────────┐      ┌──────────┐    │
│     │ Agent A   │ ──►  │ Agent B   │ ──►  │ Agent C   │   │
│     │ (gather)  │      │ (analyze) │      │ (draft)   │   │
│     └──────────┘      └──────────┘      └──────────┘    │
│                                                          │
│  Each agent receives the previous agent's output         │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                   Pipeline                               │
│                                                          │
│  Same as sequential, but each agent transforms the       │
│  output into a specific schema consumed by the next.     │
│  Enables typed data flow between agents.                 │
│                                                          │
│     Agent A ──[SchemaX]──► Agent B ──[SchemaY]──► Agent C │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                   Supervisor (dynamic)                    │
│                                                          │
│  A meta-agent that decides at runtime which sub-agents   │
│  to spawn, in what order, and how to combine results.    │
│  The supervisor itself is an AgentDefinition whose only   │
│  tool is "delegate".                                     │
│                                                          │
│     ┌────────────────┐                                   │
│     │   Supervisor    │                                   │
│     │   Agent         │ ◄── decides dynamically           │
│     └───┬───┬───┬────┘                                   │
│         │   │   │                                        │
│         ▼   ▼   ▼                                        │
│        A?  B?  C?   ── spawned based on reasoning        │
└─────────────────────────────────────────────────────────┘
```

#### Concurrency & Resource Management

```typescript
interface AgentSchedulerConfig {
  maxConcurrentAgents: number;         // global limit (e.g., 5)
  maxDepth: number;                    // how deep sub-agents can nest (e.g., 3)
  maxTotalTokenBudget: number;         // combined token limit for a delegation tree
  timeoutMs: number;                   // per-agent timeout
}

interface AgentScheduler {
  // Submit a delegation request, returns when all tasks complete
  execute(tasks: DelegateTask[], strategy: string): Promise<AgentResult[]>;

  // Monitor running agents
  getRunningAgents(): AgentInstance[];
  cancel(agentId: string): Promise<void>;

  // Events
  on(event: "agent:started", handler: (agent: AgentInstance) => void): void;
  on(event: "agent:completed", handler: (agent: AgentInstance) => void): void;
  on(event: "agent:failed", handler: (agent: AgentInstance, error: Error) => void): void;
}
```

### 2.5 Tool Interface

```typescript
interface Tool extends Plugin {
  type: "tool";
  description: string;
  parameters: JSONSchema;  // JSON Schema for input validation
  execute(params: unknown, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolContext {
  conversationId: string;
  senderId: string;
  memory: MemoryService;
  events: EventBus;
}

interface ToolResult {
  success: boolean;
  output: string;
  artifacts?: Artifact[];  // files, screenshots, etc.
}
```

---

## 3. Memory Layer (SurrealDB)

### 3.1 Schema Design

Leverage SurrealDB's graph capabilities for a knowledge graph of facts:

```surql
-- Conversations
DEFINE TABLE conversation SCHEMAFULL;
DEFINE FIELD channel     ON conversation TYPE string;
DEFINE FIELD started_at  ON conversation TYPE datetime;
DEFINE FIELD metadata    ON conversation TYPE object;

-- Messages within conversations
DEFINE TABLE message SCHEMAFULL;
DEFINE FIELD conversation ON message TYPE record<conversation>;
DEFINE FIELD role         ON message TYPE string;  -- user | assistant | system | tool
DEFINE FIELD content      ON message TYPE string;
DEFINE FIELD tool_calls   ON message TYPE option<array>;
DEFINE FIELD timestamp    ON message TYPE datetime;
DEFINE INDEX idx_msg_conv ON message FIELDS conversation;
DEFINE INDEX idx_msg_time ON message FIELDS timestamp;

-- Entities (people, places, topics, projects)
DEFINE TABLE entity SCHEMAFULL;
DEFINE FIELD name        ON entity TYPE string;
DEFINE FIELD kind        ON entity TYPE string;  -- person | place | project | topic | ...
DEFINE FIELD attributes  ON entity TYPE object;
DEFINE FIELD created_at  ON entity TYPE datetime;
DEFINE FIELD updated_at  ON entity TYPE datetime;

-- Facts as relations between entities
DEFINE TABLE knows SCHEMAFULL;       -- entity -> entity (person knows person)
DEFINE TABLE belongs_to SCHEMAFULL;  -- entity -> entity (project belongs_to org)
DEFINE TABLE has_fact SCHEMAFULL;    -- entity -> fact
DEFINE FIELD value ON has_fact TYPE string;
DEFINE FIELD confidence ON has_fact TYPE float;
DEFINE FIELD source ON has_fact TYPE record<message>;
DEFINE FIELD learned_at ON has_fact TYPE datetime;

-- Agent runs (tracks sub-agent execution trees)
DEFINE TABLE agent_run SCHEMAFULL;
DEFINE FIELD definition   ON agent_run TYPE string;      -- AgentDefinition name
DEFINE FIELD parent_run   ON agent_run TYPE option<record<agent_run>>;
DEFINE FIELD conversation ON agent_run TYPE record<conversation>;
DEFINE FIELD status       ON agent_run TYPE string;      -- running | completed | failed | cancelled
DEFINE FIELD strategy     ON agent_run TYPE option<string>; -- parallel | sequential | pipeline
DEFINE FIELD instruction  ON agent_run TYPE string;
DEFINE FIELD result       ON agent_run TYPE option<object>;
DEFINE FIELD token_usage  ON agent_run TYPE option<object>;
DEFINE FIELD started_at   ON agent_run TYPE datetime;
DEFINE FIELD finished_at  ON agent_run TYPE option<datetime>;
DEFINE INDEX idx_run_parent ON agent_run FIELDS parent_run;
DEFINE INDEX idx_run_conv   ON agent_run FIELDS conversation;

-- Relation: agent_run spawned agent_run
DEFINE TABLE spawned SCHEMAFULL;  -- agent_run -> agent_run
DEFINE FIELD order ON spawned TYPE int;
DEFINE FIELD depends_on ON spawned TYPE option<array<record<agent_run>>>;

-- User preferences
DEFINE TABLE preference SCHEMAFULL;
DEFINE FIELD user_id  ON preference TYPE string;
DEFINE FIELD key      ON preference TYPE string;
DEFINE FIELD value    ON preference TYPE string;
DEFINE INDEX idx_pref ON preference FIELDS user_id, key UNIQUE;
```

### 3.2 Memory Operations

```typescript
interface MemoryService {
  // Conversation history
  saveMessage(msg: StoredMessage): Promise<void>;
  getHistory(conversationId: string, limit?: number): Promise<StoredMessage[]>;

  // Knowledge graph
  upsertEntity(entity: Entity): Promise<string>;
  addFact(entityId: string, fact: Fact): Promise<void>;
  relate(from: string, relation: string, to: string, data?: object): Promise<void>;
  query(surql: string, vars?: Record<string, unknown>): Promise<unknown>;

  // Semantic search (future: embed + vector index)
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;

  // Preferences
  getPreference(userId: string, key: string): Promise<string | null>;
  setPreference(userId: string, key: string, value: string): Promise<void>;
}
```

---

## 4. Agent Loop

The central orchestrator — now with sub-agent delegation:

```
User Message (from any channel)
       │
       ▼
┌──────────────┐
│ Message       │  ─── Identify user, load session
│ Router        │
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Context       │  ─── Pull conversation history
│ Builder       │  ─── Retrieve relevant facts from SurrealDB
│               │  ─── Inject system prompt + user preferences
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Model         │  ─── Send to active model provider
│ Provider      │  ─── Stream response back
└──────┬───────┘
       │
       ▼
  ┌────┴─────────┐
  │ Tool calls?   │
  └──┬────┬───┬──┘
     │    │   │
     │    │   └── "delegate" tool ──────────────────────┐
     │    │                                             │
     │    └── regular tool                              ▼
     │         │                              ┌──────────────────┐
     │         ▼                              │ Agent Scheduler   │
     │    ┌──────────┐                        │                  │
     │    │ Tool     │                        │  Resolve strategy │
     │    │ Executor │                        │  (parallel /     │
     │    └────┬─────┘                        │   sequential /   │
     │         │                              │   pipeline)      │
     │         │                              └───────┬──────────┘
     │         │                                      │
     │         │                           ┌──────────┴──────────┐
     │         │                           │  Spawn sub-agents   │
     │         │                           │                     │
     │         │                      ┌────┴────┐  ┌────┴────┐   │
     │         │                      │ Agent A  │  │ Agent B  │  │ ...
     │         │                      │ (own     │  │ (own     │  │
     │         │                      │  loop)   │  │  loop)   │  │
     │         │                      └────┬────┘  └────┬────┘   │
     │         │                           │            │        │
     │         │                           └─────┬──────┘        │
     │         │                                 ▼               │
     │         │                        Collect results          │
     │         │                                 │               │
     │         │                                 ▼               │
     │    ┌────┴─────────────────────────────────┘               │
     │    │                                                      │
     │    ▼                                                      │
     no tool calls                                               │
     │                                                           │
     ▼                                                           │
┌──────────────┐                                                 │
│ Send reply   │ ◄──── or loop back to Model Provider ◄──────────┘
│ to channel   │       with tool / sub-agent results
└──────────────┘
```

Each sub-agent runs its own full agent loop (context → model → tool calls → response) with:
- Its own scoped message history
- A restricted tool set defined by its `AgentDefinition`
- Read access to the parent's memory via `sharedMemory`
- An optional different model (e.g., cheaper model for simple subtasks)

Sub-agents can themselves spawn further sub-agents, up to the configured `maxDepth`.

---

## 5. Project Structure

The project is a **monorepo** during development, but each package is independently publishable to npm. Users only install `@shard/core` — plugin packages are auto-installed by the Package Manager based on their config.

### 5.1 Development Monorepo

```
project-root/                          # bun workspace monorepo
├── packages/
│   ├── sdk/                           # @shard/sdk — shared types & utilities
│   │   ├── src/
│   │   │   ├── index.ts               # Re-exports everything
│   │   │   ├── plugin.ts              # Plugin, PluginContext interfaces
│   │   │   ├── channel.ts             # Channel, Message interfaces
│   │   │   ├── model.ts               # ModelProvider, ChatRequest interfaces
│   │   │   ├── tool.ts                # Tool, ToolResult interfaces
│   │   │   ├── agent.ts               # AgentDefinition, AgentInstance, AgentResult
│   │   │   ├── memory.ts              # MemoryService interface
│   │   │   ├── events.ts              # EventBus interface + typed event map
│   │   │   └── utils/                 # Shared utilities (retry, validation, etc.)
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── core/                          # @shard/core — the runtime
│   │   ├── src/
│   │   │   ├── index.ts               # Entry point, CLI
│   │   │   ├── runtime.ts             # Boot, lifecycle, shutdown
│   │   │   ├── package-manager.ts     # Install/update/remove plugin packages
│   │   │   ├── plugin-registry.ts     # Load, validate, init plugins
│   │   │   ├── event-bus.ts           # Typed event emitter implementation
│   │   │   ├── config.ts              # TOML loading, env interpolation, validation
│   │   │   ├── logger.ts              # Structured logging
│   │   │   ├── agent/
│   │   │   │   ├── loop.ts            # Single agent loop
│   │   │   │   ├── context-builder.ts # Builds LLM context from history + memory
│   │   │   │   ├── tool-executor.ts   # Validates and executes tool calls
│   │   │   │   ├── router.ts          # Routes messages to agent sessions
│   │   │   │   ├── scheduler.ts       # Agent concurrency, queuing, lifecycle
│   │   │   │   └── orchestrator.ts    # Delegation strategies (parallel/seq/pipeline)
│   │   │   └── memory/
│   │   │       ├── service.ts         # MemoryService implementation
│   │   │       ├── surreal-client.ts  # SurrealDB connection + helpers
│   │   │       └── schema.surql       # Database schema definitions
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── channel-telegram/              # @shard/channel-telegram
│   │   ├── src/
│   │   │   ├── index.ts               # Default export: Channel plugin
│   │   │   ├── client.ts              # grammy bot wrapper
│   │   │   └── mappers.ts             # Map Telegram types ↔ internal types
│   │   ├── package.json               # includes "plugin" manifest field
│   │   └── tsconfig.json
│   │
│   ├── model-anthropic/               # @shard/model-anthropic
│   │   ├── src/
│   │   │   ├── index.ts               # Default export: ModelProvider plugin
│   │   │   └── client.ts              # Anthropic SDK wrapper
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── tool-shell/                    # @shard/tool-shell
│   │   ├── src/
│   │   │   └── index.ts               # Default export: Tool plugin
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── tool-filesystem/               # @shard/tool-filesystem
│   │   ├── src/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── tool-browser/                  # @shard/tool-browser
│   │   ├── src/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── tool-http/                     # @shard/tool-http
│   │   ├── src/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── tool-cron/                     # @shard/tool-cron
│   │   ├── src/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── agent-researcher/              # @shard/agent-researcher
│   │   ├── src/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── agent-coder/                   # @shard/agent-coder
│   │   └── ...
│   │
│   ├── agent-planner/                 # @shard/agent-planner
│   │   └── ...
│   │
│   └── agent-reviewer/               # @shard/agent-reviewer
│       └── ...
│
├── config/
│   └── default.toml                   # Default configuration
│
├── agents/                            # User's local agent definitions (TOML/TS)
│   ├── summarizer.toml
│   └── custom-agent.ts
│
├── tests/
│   ├── core/
│   ├── sdk/
│   ├── integration/                   # End-to-end tests across packages
│   └── plugins/
│
├── package.json                       # Workspace root
├── bunfig.toml                        # Bun workspace config
└── tsconfig.json                      # Shared TS config
```

### 5.2 User's Install (what end-users see)

End-users don't clone the monorepo. They install the core and write a config:

```
my-assistant/
├── config.toml                        # Declares which plugins to use
├── agents/                            # Optional: local agent definitions
│   └── my-agent.toml
├── node_modules/                      # Auto-managed by Package Manager
│   ├── @shard/core/
│   ├── @shard/sdk/
│   ├── @shard/channel-telegram/ # auto-installed from config
│   ├── @shard/model-anthropic/  # auto-installed from config
│   ├── @shard/tool-shell/       # auto-installed from config
│   └── cool-community-plugin/         # third-party, also auto-installed
├── data/                              # SurrealDB data directory
├── package.json                       # only has @shard/core as dependency
└── bun.lockb
```

Setup is:
```bash
mkdir my-assistant && cd my-assistant
bun init -y
bun add @shard/core
# Edit config.toml to declare plugins
bunx shard                       # starts runtime, auto-installs plugins
```

---

## 6. Implementation Phases

### Phase 1 — Foundation
- [ ] Bun workspace monorepo scaffolding + shared tsconfig + linting
- [ ] `@shard/sdk` package: all interfaces (Plugin, Channel, ModelProvider, Tool, AgentDefinition)
- [ ] `@shard/core` package: runtime, event bus, config manager (TOML + env interpolation), logger
- [ ] Package Manager: resolve plugins from config, `bun add`/`bun remove`, validate plugin manifests
- [ ] Plugin Registry: load from node_modules, dependency sort, init lifecycle
- [ ] SurrealDB setup + schema + MemoryService implementation
- [ ] Basic agent loop (message → context → model → response)
- [ ] Single-agent tool calling loop (multi-turn)

### Phase 2 — First Plugin Packages
- [ ] `@shard/model-anthropic` — Claude model provider
- [ ] `@shard/channel-telegram` — Telegram via grammy
- [ ] `@shard/tool-shell` — sandboxed command execution
- [ ] `@shard/tool-filesystem` — scoped read/write
- [ ] End-to-end test: install core + plugins from config → Telegram message → AI response
- [ ] Publish first-party packages to npm (or GitHub Packages)

### Phase 3 — Sub-Agents & Orchestration
- [ ] AgentDefinition loading (TOML + programmatic)
- [ ] Agent scheduler: concurrency limits, depth limits, token budgets
- [ ] `delegate` meta-tool: primary agent can spawn sub-agents
- [ ] Parallel strategy (fan-out / fan-in): run N agents concurrently, merge results
- [ ] Sequential strategy: chain agents where each receives prior output
- [ ] Pipeline strategy: typed data flow between agents via output schemas
- [ ] Agent run tracking in SurrealDB (parent ↔ child relations)
- [ ] Built-in agent definitions: researcher, coder, planner, reviewer
- [ ] Supervisor pattern: meta-agent that dynamically decides delegation

### Phase 4 — Intelligence
- [ ] Context builder: inject conversation history + relevant facts
- [ ] Fact extraction: LLM extracts entities/facts from conversations, stores in SurrealDB graph
- [ ] User preference learning and retrieval
- [ ] Cross-agent memory: sub-agents contribute facts back to the knowledge graph
- [ ] Agent result caching: avoid re-running identical sub-agent tasks

### Phase 5 — Expanded Capabilities
- [ ] `@shard/tool-browser` — Playwright browser automation
- [ ] `@shard/tool-http` — HTTP request tool
- [ ] `@shard/tool-cron` — scheduling / proactive behaviors
- [ ] `@shard/model-openai` — OpenAI provider
- [ ] `@shard/model-ollama` — local model provider
- [ ] Background agents: long-running agents that operate on schedules

### Phase 6 — Polish
- [ ] Web-based control UI / dashboard
- [ ] Agent execution visualizer (tree view of delegation chains)
- [ ] Conversation management (list, search, delete)
- [ ] Security: permission system for tools, sandboxing
- [ ] Additional channel plugins (Discord, Slack, web chat)

---

## 7. Key Dependencies

| Package | Used in | Purpose |
|---------|---------|---------|
| `surrealdb` | `core` | SurrealDB JavaScript driver |
| `zod` | `sdk` | Runtime type validation + schema generation |
| `consola` | `core` | Structured logging |
| `smol-toml` | `core` | TOML config parsing |
| `grammy` | `channel-telegram` | Telegram Bot API framework |
| `@anthropic-ai/sdk` | `model-anthropic` | Claude API client |
| `openai` | `model-openai` | OpenAI API client |
| `playwright` | `tool-browser` | Browser automation |

---

## 8. Configuration

TOML-based config with env var overrides. Plugins are declared by **npm package name** — the Package Manager installs them automatically on startup.

```toml
# ─── Plugin Registry ─────────────────────────────────────────
# Where to install plugin packages from.
# Defaults to npm public registry. Can point to GitHub Packages,
# Verdaccio, or any npm-compatible registry.
[registry]
url = "https://registry.npmjs.org"
# For private registries:
# url = "https://npm.pkg.github.com"
# token_env = "NPM_TOKEN"             # env var holding auth token

# Auto-update plugins on startup (checks for newer versions)
auto_update = true

# ─── Plugins ─────────────────────────────────────────────────
# Each plugin is an npm package. Specify the package name and
# optional version constraint. The PackageManager runs
# `bun add <package>@<version>` to install/update them.
#
# Config for each plugin goes under [plugins.<package-name>].

[plugins."@shard/channel-telegram"]
version = "^1.0.0"                     # semver range, default "latest"
enabled = true
# Plugin-specific config (validated against the plugin's configSchema):
token = "${TELEGRAM_BOT_TOKEN}"        # env var interpolation

[plugins."@shard/model-anthropic"]
version = "^1.0.0"
enabled = true
api_key = "${ANTHROPIC_API_KEY}"

[plugins."@shard/tool-shell"]
version = "^1.0.0"
enabled = true
allowed_commands = ["*"]               # restrict in production
working_directory = "~"

[plugins."@shard/tool-filesystem"]
version = "^1.0.0"
enabled = true
allowed_paths = ["~/Documents", "~/Projects"]

[plugins."@shard/tool-browser"]
version = "^1.0.0"
enabled = false                        # enable when ready

# Third-party / community plugins work the same way:
# [plugins."some-community-tool"]
# version = "^2.1.0"
# enabled = true
# custom_option = "value"

# ─── Agent ───────────────────────────────────────────────────
[agent]
default_model = "claude-sonnet-4-20250514"
max_tool_iterations = 10
system_prompt_path = "./config/system-prompt.md"
definitions_dir = "./agents"           # local agent definitions (TOML/TS)

[agent.scheduler]
max_concurrent_agents = 5
max_depth = 3
max_total_token_budget = 500_000
agent_timeout_ms = 120_000

# ─── Memory ──────────────────────────────────────────────────
[memory]
surreal_url = "ws://localhost:8000/rpc"
surreal_namespace = "assistant"
surreal_database = "main"
```

#### Environment Variable Interpolation

Any config value of the form `"${ENV_VAR}"` is resolved from the environment at load time. This keeps secrets out of the config file.

#### Adding a New Plugin

Users just add a section to their config and restart:

```toml
[plugins."cool-community-plugin"]
version = "^3.0.0"
enabled = true
some_option = "value"
```

On next startup the Package Manager will:
1. Detect the package isn't in `node_modules`
2. Run `bun add cool-community-plugin@^3.0.0`
3. Validate the package exports a valid `Plugin`
4. Call `plugin.init()` with the config values as context

---

## 9. Design Principles

1. **Plugin-first** — Every feature is a plugin. Core stays minimal.
2. **Packages, not folders** — Plugins are real npm packages, installable from any registry. Third parties can publish their own.
3. **Interface-driven** — Depend on abstractions (`@shard/sdk`), not implementations.
4. **Local-first** — Runs on your machine, your data stays yours.
5. **Explicit over magic** — Clear configuration, no hidden behaviors. Env vars for secrets.
6. **Gradual complexity** — Start with core + 2 plugins. Add more as needed via config.
7. **Zero-config plugin install** — Declare a package name in config, restart, done.
