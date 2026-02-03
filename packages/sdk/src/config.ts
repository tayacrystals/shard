export interface ConfigManager {
  get<T = unknown>(key: string): T | undefined;
  get<T = unknown>(key: string, defaultValue: T): T;
  has(key: string): boolean;
  getAll(): Record<string, unknown>;
}
