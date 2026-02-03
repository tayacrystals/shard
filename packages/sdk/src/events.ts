export interface EventMap {
  "message:incoming": { channelId: string; messageId: string };
  "message:outgoing": { channelId: string; messageId: string };
  "plugin:loaded": { name: string; type: string };
  "plugin:destroyed": { name: string };
  "runtime:ready": Record<string, never>;
  "runtime:shutdown": Record<string, never>;
  [key: string]: Record<string, unknown>;
}

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

export interface EventBus {
  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void;
  off<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void;
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): Promise<void>;
}
