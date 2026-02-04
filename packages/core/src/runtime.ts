import type {
  PluginContext,
  MemoryService,
  StoredMessage,
  Entity,
  Fact,
  SearchOptions,
  SearchResult,
  AgentDefinition,
  ModelProvider,
} from "@tayacrystals/shard-sdk";
import { Config } from "./config";
import { dirname, join } from "node:path";
import { createLogger } from "./logger";
import { TypedEventBus } from "./event-bus";
import { PackageManager } from "./package-manager";
import { PluginRegistry } from "./plugin-registry";
import { AgentLoop } from "./agent/loop";
import { ToolExecutor } from "./agent/tool-executor";
import { MessageRouter } from "./agent/router";

class StubMemoryService implements MemoryService {
  private log = createLogger("memory-stub");

  async storeMessage(_message: StoredMessage): Promise<void> {
    this.log.warn("MemoryService not implemented — storeMessage is a no-op");
  }

  async getMessages(_channelId: string, _limit?: number): Promise<StoredMessage[]> {
    this.log.warn("MemoryService not implemented — getMessages returns empty");
    return [];
  }

  async search(_options: SearchOptions): Promise<SearchResult[]> {
    this.log.warn("MemoryService not implemented — search returns empty");
    return [];
  }

  async storeEntity(_entity: Entity): Promise<void> {
    this.log.warn("MemoryService not implemented — storeEntity is a no-op");
  }

  async getEntity(_id: string): Promise<Entity | undefined> {
    this.log.warn("MemoryService not implemented — getEntity returns undefined");
    return undefined;
  }

  async storeFact(_fact: Fact): Promise<void> {
    this.log.warn("MemoryService not implemented — storeFact is a no-op");
  }

  async getFacts(_subject: string): Promise<Fact[]> {
    this.log.warn("MemoryService not implemented — getFacts returns empty");
    return [];
  }
}

export class Runtime {
  private config!: Config;
  private events!: TypedEventBus;
  private packageManager!: PackageManager;
  private registry!: PluginRegistry;
  private memory!: MemoryService;
  private log = createLogger("runtime");
  private shutdownRequested = false;
  private keepAlive: Timer | undefined;
  private router: MessageRouter | undefined;

  async boot(configPath: string): Promise<void> {
    this.log.info("Booting Shard runtime...");

    // Config
    this.config = await Config.fromFile(configPath);
    this.log.info(`Config loaded from ${configPath}`);

    const configDir = dirname(configPath);
    const modulesDir = join(configDir, "node_modules");

    // Event bus
    this.events = new TypedEventBus();

    // Memory (stub)
    this.memory = new StubMemoryService();

    // Package manager — sync plugins
    this.packageManager = new PackageManager(this.config);
    const autoUpdate = this.config.get<boolean>("runtime.pluginAutoUpdate", false);
    const updateIntervalHours = this.config.get<number>("runtime.pluginUpdateIntervalHours", 24);
    const statePath = join(configDir, "plugin-update.json");
    const syncResult = await this.packageManager.sync({
      autoUpdate,
      updateIntervalHours,
      statePath,
      installDir: configDir,
      modulePaths: [modulesDir],
    });
    if (syncResult.installed.length > 0) {
      this.log.info(`Installed ${syncResult.installed.length} new package(s)`);
    }
    if (syncResult.updated.length > 0) {
      this.log.info(`Updated ${syncResult.updated.length} plugin package(s)`);
    }

    // Plugin registry
    this.registry = new PluginRegistry(this.config, { modulePaths: [modulesDir] });
    await this.registry.loadAll();

    const context: PluginContext = {
      config: this.config,
      logger: createLogger("plugin"),
      events: this.events,
      memory: this.memory,
    };

    await this.registry.initAll(context);

    // Wire up agent system
    const models = this.registry.getModels();
    const channels = this.registry.getChannels();
    const tools = this.registry.getTools();

    if (models.length > 0) {
      const modelProvider = this.resolveModelProvider(models);
      const toolExecutor = new ToolExecutor(tools, createLogger("tool-executor"));
      const agentLoop = new AgentLoop(modelProvider, toolExecutor, this.events, createLogger("agent-loop"));
      const agentDef = this.buildAgentDefinition(models);

      if (channels.length > 0) {
        this.router = new MessageRouter(agentLoop, channels, agentDef, this.events, createLogger("router"));
        this.router.start();
        this.log.info(`Agent router started — ${channels.length} channel(s), ${tools.length} tool(s)`);
      } else {
        this.log.warn("No channel plugins loaded — agent loop ready but no message routing");
      }
    } else {
      this.log.warn("No model plugins loaded — agent loop not started");
    }

    await this.events.emit("runtime:ready", {});

    this.log.info("Shard runtime is ready");

    this.keepAlive = setInterval(() => {}, 1 << 30);
    this.setupSignalHandlers();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;

    this.log.info("Shutting down...");

    this.router?.stop();
    clearInterval(this.keepAlive);
    await this.events.emit("runtime:shutdown", {});
    await this.registry.destroyAll();
    this.events.removeAll();

    this.log.info("Shutdown complete");
  }

  private resolveModelProvider(models: ModelProvider[]): ModelProvider {
    return models[0];
  }

  private buildAgentDefinition(models: ModelProvider[]): AgentDefinition {
    const defaultModel = models.length > 0 ? models[0].name : "gpt-4o";

    return {
      id: this.config.get<string>("agents.id") ?? "default",
      name: this.config.get<string>("agents.name") ?? "Default Agent",
      description: this.config.get<string>("agents.description") ?? "Primary agent",
      systemPrompt:
        this.config.get<string>("agents.systemPrompt") ??
        "You are a helpful AI assistant.",
      model: this.config.get<string>("agents.defaultModel") ?? defaultModel,
      maxTurns: this.config.get<number>("agents.maxTurns") ?? 10,
      strategy: "single",
      tools: this.config.get<string[]>("agents.tools"),
    };
  }

  private setupSignalHandlers(): void {
    const handler = () => {
      this.shutdown().then(() => process.exit(0));
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  }
}
