import { createConsola } from "consola";
import type { Logger, LogLevel } from "@tayacrystals/shard-sdk";

const consola = createConsola({});

const LOG_LEVEL_MAP: Record<LogLevel, number> = {
  debug: 4,
  info: 3,
  warn: 2,
  error: 1,
};

export function setLogLevel(level: LogLevel): void {
  consola.level = LOG_LEVEL_MAP[level];
}

export function createLogger(tag?: string): Logger {
  const instance = tag ? consola.withTag(tag) : consola;
  return {
    debug: (message: string, ...args: unknown[]) => instance.debug(message, ...args),
    info: (message: string, ...args: unknown[]) => instance.info(message, ...args),
    warn: (message: string, ...args: unknown[]) => instance.warn(message, ...args),
    error: (message: string, ...args: unknown[]) => instance.error(message, ...args),
  };
}
