import { parse } from "smol-toml";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ConfigManager } from "@shard/sdk";

const DEFAULT_CONFIG = `# Shard — Configuration
# See https://github.com/shard-ai/shard for documentation.

# [plugins."@shard/discord"]
# token = "\${DISCORD_TOKEN}"
# guilds = ["your-guild-id"]

# [plugins."@shard/openai"]
# apiKey = "\${OPENAI_API_KEY}"
# defaultModel = "gpt-4o"

# [plugins."@shard/anthropic"]
# apiKey = "\${ANTHROPIC_API_KEY}"
# defaultModel = "claude-sonnet-4-20250514"

# [plugins."@shard/model-openaigeneric"]
# apiKey = "\${OPENAI_API_KEY}"
# baseUrl = "https://api.openai.com/v1"
# defaultModel = "gpt-4o"
#
# # Or use multiple instances:
# # [[plugins."@shard/model-openaigeneric".instances]]
# # instanceId = "openai"
# # apiKey = "\${OPENAI_API_KEY}"
# # baseUrl = "https://api.openai.com/v1"
# # defaultModel = "gpt-4o"
# #
# # [[plugins."@shard/model-openaigeneric".instances]]
# # instanceId = "local"
# # baseUrl = "http://localhost:8000/v1"
# # defaultModel = "llama2"

[agents]
# maxTurns = 10
# defaultModel = "gpt-4o"
# strategy = "single"

[memory]
# provider = "surrealdb"
# url = "ws://localhost:8000/rpc"
# namespace = "shard"
# database = "main"

[runtime]
# logLevel = "info"
`;

function getDefaultConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming");
    return join(appData, "shard");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
  return join(xdg, "shard");
}

/**
 * Resolves the config file path with the following precedence:
 * 1. `--config` / `-c` CLI flag (passed explicitly)
 * 2. `SHARD_CONFIG` environment variable
 * 3. OS default: Windows  → %APPDATA%/shard/config.toml
 *                Linux/Mac → $XDG_CONFIG_HOME/shard/config.toml
 */
export function resolveConfigPath(cliPath?: string): string {
  if (cliPath) return cliPath;
  if (process.env.SHARD_CONFIG) return process.env.SHARD_CONFIG;
  return join(getDefaultConfigDir(), "config.toml");
}

/**
 * Ensures the config file exists at the given path.
 * If it doesn't, creates the directory and writes the default config.
 * Returns true if a new file was created.
 */
export async function ensureConfigFile(path: string): Promise<boolean> {
  if (existsSync(path)) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, DEFAULT_CONFIG, "utf-8");
  return true;
}

export class Config implements ConfigManager {
  private data: Record<string, unknown>;

  constructor(data: Record<string, unknown> = {}) {
    this.data = data;
  }

  static async fromFile(path: string): Promise<Config> {
    const raw = await readFile(path, "utf-8");
    const parsed = parse(raw) as Record<string, unknown>;
    const interpolated = Config.interpolateEnv(parsed);
    return new Config(interpolated);
  }

  get<T = unknown>(key: string, defaultValue?: T): T | undefined {
    const value = Config.resolve(this.data, key);
    if (value === undefined) return defaultValue;
    return value as T;
  }

  has(key: string): boolean {
    return Config.resolve(this.data, key) !== undefined;
  }

  getAll(): Record<string, unknown> {
    return structuredClone(this.data);
  }

  private static resolve(obj: Record<string, unknown>, key: string): unknown {
    const parts = Config.parseDotPath(key);
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== "object") {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /**
   * Parses dot-notation paths with support for quoted keys.
   * e.g. 'plugins."@shard/discord".enabled' → ["plugins", "@shard/discord", "enabled"]
   */
  private static parseDotPath(key: string): string[] {
    const parts: string[] = [];
    let current = "";
    let inQuotes = false;
    let quoteChar = "";

    for (let i = 0; i < key.length; i++) {
      const char = key[i]!;
      if (inQuotes) {
        if (char === quoteChar) {
          inQuotes = false;
        } else {
          current += char;
        }
      } else if (char === '"' || char === "'") {
        inQuotes = true;
        quoteChar = char;
      } else if (char === ".") {
        if (current) parts.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  private static interpolateEnv(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") {
        result[key] = value.replace(/\$\{(\w+)\}/g, (_, envVar: string) => {
          return process.env[envVar] ?? "";
        });
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        result[key] = Config.interpolateEnv(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}
