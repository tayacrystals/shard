import type { EventBus, EventMap, EventHandler } from "@shard/sdk";
import { createLogger } from "./logger";

type AnyHandler = EventHandler<unknown>;

const log = createLogger("event-bus");

export class TypedEventBus implements EventBus {
  private handlers = new Map<string, Set<AnyHandler>>();
  private wildcardHandlers = new Set<(event: string, payload: unknown) => void | Promise<void>>();

  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    const key = event as string;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
    }
    this.handlers.get(key)!.add(handler as AnyHandler);
  }

  off<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    const key = event as string;
    this.handlers.get(key)?.delete(handler as AnyHandler);
  }

  async emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): Promise<void> {
    const key = event as string;
    const handlers = this.handlers.get(key);
    if (handlers) {
      for (const handler of handlers) {
        try {
          await handler(payload);
        } catch (err) {
          log.error(`Error in event handler for "${key}":`, err);
        }
      }
    }

    for (const handler of this.wildcardHandlers) {
      try {
        await handler(key, payload);
      } catch (err) {
        log.error(`Error in wildcard handler for "${key}":`, err);
      }
    }
  }

  onAny(handler: (event: string, payload: unknown) => void | Promise<void>): void {
    this.wildcardHandlers.add(handler);
  }

  offAny(handler: (event: string, payload: unknown) => void | Promise<void>): void {
    this.wildcardHandlers.delete(handler);
  }

  removeAll(): void {
    this.handlers.clear();
    this.wildcardHandlers.clear();
  }
}
