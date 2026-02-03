import type { Plugin } from "./plugin";

export interface RichBlock {
  type: string;
  data: Record<string, unknown>;
}

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "media"; url: string; mimeType: string; caption?: string }
  | { type: "rich"; blocks: RichBlock[] };

export interface IncomingMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: MessageContent;
  timestamp: Date;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export interface OutgoingMessage {
  channelId: string;
  content: MessageContent;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>;

export interface Channel extends Plugin {
  readonly type: "channel";
  onMessage(handler: MessageHandler): void;
  send(message: OutgoingMessage): Promise<void>;
}
