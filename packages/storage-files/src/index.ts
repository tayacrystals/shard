import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { defaultDataDir } from "@tayacrystals/shard-sdk";
import type {
  StorageProvider,
  PluginContext,
  StoredMessage,
  Entity,
  Fact,
  SearchOptions,
  SearchResult,
} from "@tayacrystals/shard-sdk";

interface FileStorageData {
  messages: StoredMessage[];
  entities: Entity[];
  facts: Fact[];
}

function emptyData(): FileStorageData {
  return { messages: [], entities: [], facts: [] };
}

/**
 * Reviver for JSON.parse that restores Date objects
 * for known timestamp fields.
 */
function dateReviver(_key: string, value: unknown): unknown {
  if (
    (_key === "timestamp") &&
    typeof value === "string"
  ) {
    return new Date(value);
  }
  return value;
}

export class FileStorageProvider implements StorageProvider {
  readonly name = "shard-storage-files";
  readonly version = "0.1.0";
  readonly type = "storage" as const;

  private dataDir = "";
  private data: FileStorageData = emptyData();
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | undefined;

  async init(context: PluginContext): Promise<void> {
    this.dataDir = context.config.get<string>(
      "storage-files.dataDir",
      defaultDataDir(),
    );

    await mkdir(this.dataDir, { recursive: true });

    const filePath = this.filePath();
    try {
      const raw = await readFile(filePath, "utf-8");
      this.data = JSON.parse(raw, dateReviver) as FileStorageData;
    } catch {
      // File doesn't exist yet or is corrupted – start fresh
      this.data = emptyData();
    }

    // Periodically flush dirty data every 5 seconds
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, 5_000);
  }

  async destroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  async ping(): Promise<boolean> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  // ── Messages ──────────────────────────────────────────────

  async storeMessage(message: StoredMessage): Promise<void> {
    this.data.messages.push(message);
    this.dirty = true;
  }

  async getMessages(
    channelId: string,
    limit?: number,
  ): Promise<StoredMessage[]> {
    const filtered = this.data.messages.filter(
      (m) => m.channelId === channelId,
    );
    if (limit !== undefined && limit > 0) {
      return filtered.slice(-limit);
    }
    return filtered;
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const query = options.query.toLowerCase();
    const results: SearchResult[] = [];

    for (const message of this.data.messages) {
      if (options.channelId && message.channelId !== options.channelId) {
        continue;
      }
      if (options.before && message.timestamp >= options.before) {
        continue;
      }
      if (options.after && message.timestamp <= options.after) {
        continue;
      }

      const content = message.content.toLowerCase();
      if (!content.includes(query)) {
        continue;
      }

      // Simple relevance score based on how much of the content matches
      const score = query.length / content.length;

      if (options.threshold !== undefined && score < options.threshold) {
        continue;
      }

      results.push({ message, score });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    if (options.limit !== undefined && options.limit > 0) {
      return results.slice(0, options.limit);
    }
    return results;
  }

  // ── Entities ──────────────────────────────────────────────

  async storeEntity(entity: Entity): Promise<void> {
    const idx = this.data.entities.findIndex((e) => e.id === entity.id);
    if (idx >= 0) {
      this.data.entities[idx] = entity;
    } else {
      this.data.entities.push(entity);
    }
    this.dirty = true;
  }

  async getEntity(id: string): Promise<Entity | undefined> {
    return this.data.entities.find((e) => e.id === id);
  }

  // ── Facts ─────────────────────────────────────────────────

  async storeFact(fact: Fact): Promise<void> {
    const idx = this.data.facts.findIndex((f) => f.id === fact.id);
    if (idx >= 0) {
      this.data.facts[idx] = fact;
    } else {
      this.data.facts.push(fact);
    }
    this.dirty = true;
  }

  async getFacts(subject: string): Promise<Fact[]> {
    return this.data.facts.filter((f) => f.subject === subject);
  }

  // ── Persistence ───────────────────────────────────────────

  private filePath(): string {
    return join(this.dataDir, "data.json");
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await writeFile(this.filePath(), JSON.stringify(this.data, null, 2), "utf-8");
  }
}

const plugin = new FileStorageProvider();
export default plugin;
