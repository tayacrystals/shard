import type {
  PluginContext,
  MemoryService,
  StoredMessage,
  Entity,
  Fact,
  SearchOptions,
  SearchResult,
} from "@tayacrystals/shard-sdk";
import { Config } from "./config";
import { dirname, join } from "node:path";
import { createLogger } from "./logger";
import { TypedEventBus } from "./event-bus";
import { PackageManager } from "./package-manager";
import { PluginRegistry } from "./plugin-registry";

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
    await this.events.emit("runtime:ready", {});

    this.log.info("Shard runtime is ready");

    this.keepAlive = setInterval(() => {}, 1 << 30);
    this.setupSignalHandlers();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;

    this.log.info("Shutting down...");

    clearInterval(this.keepAlive);
    await this.events.emit("runtime:shutdown", {});
    await this.registry.destroyAll();
    this.events.removeAll();

    this.log.info("Shutdown complete");
  }

  private setupSignalHandlers(): void {
    const handler = () => {
      this.shutdown().then(() => process.exit(0));
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  }
}
