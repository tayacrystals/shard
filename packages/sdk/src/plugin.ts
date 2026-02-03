import type { Logger } from "./logger";
import type { ConfigManager } from "./config";
import type { EventBus } from "./events";
import type { MemoryService } from "./memory";

export type PluginType = "channel" | "model" | "tool" | "memory" | "custom";

export interface PluginContext {
  config: ConfigManager;
  logger: Logger;
  events: EventBus;
  memory: MemoryService;
}

export interface Plugin {
  readonly name: string;
  readonly version: string;
  readonly type: PluginType;
  readonly dependencies?: string[];
  readonly instanceId?: string;

  init(context: PluginContext): Promise<void>;
  destroy(): Promise<void>;
}
