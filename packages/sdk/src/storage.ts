import { join } from "node:path";
import type { Plugin } from "./plugin";
import type {
  MemoryService,
  StoredMessage,
  Entity,
  Fact,
  SearchOptions,
  SearchResult,
} from "./memory";

/**
 * Returns the default data directory for shard storage.
 *
 * - Windows: %APPDATA%/shard
 * - macOS:   $HOME/Library/Application Support/shard
 * - Linux:   $XDG_CONFIG_HOME/shard  (falls back to ~/.config/shard)
 */
export function defaultDataDir(): string {
  const platform = process.platform;

  if (platform === "win32") {
    return join(process.env["APPDATA"] ?? join(process.env["USERPROFILE"] ?? "", "AppData", "Roaming"), "shard");
  }

  if (platform === "darwin") {
    return join(process.env["HOME"] ?? "", "Library", "Application Support", "shard");
  }

  // Linux / other
  return join(process.env["XDG_CONFIG_HOME"] ?? join(process.env["HOME"] ?? "", ".config"), "shard");
}

/**
 * A StorageProvider is a plugin that implements persistent storage
 * for chat history, entities, facts, and search.
 *
 * Implementations should handle connection lifecycle in init/destroy
 * and provide the MemoryService data operations.
 *
 * Example implementations: shard-storage-surrealdb, shard-storage-sqlite
 */
export interface StorageProvider extends Plugin, MemoryService {
  readonly type: "storage";

  /** Check whether the backing store is reachable. */
  ping(): Promise<boolean>;
}
