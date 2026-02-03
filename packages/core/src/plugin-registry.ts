import type {
  Plugin,
  PluginContext,
  Channel,
  ModelProvider,
  Tool,
  ConfigManager,
  Logger,
} from "@shard/sdk";
import { createLogger } from "./logger";

export class PluginRegistry {
  private plugins = new Map<string, Plugin>();
  private initialized = false;
  private log: Logger;

  constructor(private config: ConfigManager) {
    this.log = createLogger("plugin-registry");
  }

  async loadAll(): Promise<void> {
    const pluginsConfig = this.config.get<Record<string, unknown>>("plugins") ?? {};

    for (const packageName of Object.keys(pluginsConfig)) {
      try {
        const mod = await import(packageName);
        const plugin: Plugin = mod.default ?? mod;

        if (!this.validatePlugin(plugin)) {
          this.log.error(`Invalid plugin contract: ${packageName}`);
          continue;
        }

        this.plugins.set(plugin.name, plugin);
        this.log.info(`Loaded plugin: ${plugin.name} (${plugin.type}) v${plugin.version}`);
      } catch (err) {
        this.log.error(`Failed to load plugin "${packageName}":`, err);
      }
    }
  }

  async initAll(context: PluginContext): Promise<void> {
    const sorted = this.topologicalSort();

    for (const plugin of sorted) {
      try {
        await plugin.init(context);
        this.log.info(`Initialized plugin: ${plugin.name}`);
      } catch (err) {
        this.log.error(`Failed to init plugin "${plugin.name}":`, err);
      }
    }

    this.initialized = true;
  }

  async destroyAll(): Promise<void> {
    const sorted = this.topologicalSort().reverse();

    for (const plugin of sorted) {
      try {
        await plugin.destroy();
        this.log.info(`Destroyed plugin: ${plugin.name}`);
      } catch (err) {
        this.log.error(`Failed to destroy plugin "${plugin.name}":`, err);
      }
    }

    this.plugins.clear();
    this.initialized = false;
  }

  getChannels(): Channel[] {
    return this.getByType<Channel>("channel");
  }

  getModels(): ModelProvider[] {
    return this.getByType<ModelProvider>("model");
  }

  getTools(): Tool[] {
    return this.getByType<Tool>("tool");
  }

  getPlugin(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  private getByType<T extends Plugin>(type: string): T[] {
    const result: T[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.type === type) result.push(plugin as T);
    }
    return result;
  }

  private validatePlugin(plugin: unknown): plugin is Plugin {
    if (plugin === null || typeof plugin !== "object") return false;
    const p = plugin as Record<string, unknown>;
    return (
      typeof p.name === "string" &&
      typeof p.version === "string" &&
      typeof p.type === "string" &&
      typeof p.init === "function" &&
      typeof p.destroy === "function"
    );
  }

  private topologicalSort(): Plugin[] {
    const visited = new Set<string>();
    const result: Plugin[] = [];

    const visit = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);

      const plugin = this.plugins.get(name);
      if (!plugin) return;

      for (const dep of plugin.dependencies ?? []) {
        visit(dep);
      }

      result.push(plugin);
    };

    for (const name of this.plugins.keys()) {
      visit(name);
    }

    return result;
  }
}
