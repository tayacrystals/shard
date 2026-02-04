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
