import type {
  Channel,
  IncomingMessage,
  OutgoingMessage,
  MessageContent,
  MessageHandler,
  PluginContext,
} from "@tayacrystals/shard-sdk";

// ── Telegram Bot API types (subset) ──────────────────────────────

type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
};

type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};

type TelegramDocument = {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramAudio = {
  file_id: string;
  mime_type?: string;
};

type TelegramVideo = {
  file_id: string;
  mime_type?: string;
};

type TelegramVoice = {
  file_id: string;
  mime_type?: string;
};

type TelegramSticker = {
  file_id: string;
};

type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string; title?: string; username?: string };
  date: number;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  video?: TelegramVideo;
  voice?: TelegramVoice;
  sticker?: TelegramSticker;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  description?: string;
  result?: T;
};

type TelegramFile = {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
};

// ── Config ───────────────────────────────────────────────────────

type TelegramChannelConfig = {
  token?: string;
  pollingIntervalMs?: number;
  allowedChatIds?: number[];
  parseMode?: "MarkdownV2" | "HTML";
};

// ── Constants ────────────────────────────────────────────────────

const TELEGRAM_API = "https://api.telegram.org";
const DEFAULT_POLLING_INTERVAL_MS = 1000;
const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;

// ── Implementation ───────────────────────────────────────────────

class TelegramChannel implements Channel {
  readonly name = "@tayacrystals/shard-channel-telegram";
  readonly version = "0.1.0";
  readonly type = "channel" as const;

  private config: TelegramChannelConfig = {};
  private logger?: PluginContext["logger"];
  private events?: PluginContext["events"];
  private handler?: MessageHandler;
  private offset = 0;
  private polling = false;
  private pollTimer?: ReturnType<typeof setTimeout>;

  async init(context: PluginContext): Promise<void> {
    this.logger = context.logger;
    this.events = context.events;
    this.config =
      context.config.get<TelegramChannelConfig>(
        'plugins."@tayacrystals/shard-channel-telegram"'
      ) ?? {};

    if (!this.config.token) {
      throw new Error(
        "Telegram bot token is required. Set plugins.\"@tayacrystals/shard-channel-telegram\".token in config."
      );
    }

    // Verify the token is valid by calling getMe
    const me = await this.apiCall<TelegramUser>("getMe");
    this.logger?.info(
      `Telegram bot connected: @${me.username ?? me.first_name} (id: ${me.id})`
    );

    this.startPolling();
  }

  async destroy(): Promise<void> {
    this.stopPolling();
    this.handler = undefined;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async send(message: OutgoingMessage): Promise<void> {
    const chatId = message.channelId;

    switch (message.content.type) {
      case "text": {
        await this.sendTextMessage(
          chatId,
          message.content.text,
          message.replyTo
        );
        break;
      }
      case "media": {
        await this.sendMediaMessage(
          chatId,
          message.content,
          message.replyTo
        );
        break;
      }
      case "rich": {
        // Fall back to rendering rich blocks as text
        const text = message.content.blocks
          .map((b) => JSON.stringify(b.data))
          .join("\n");
        await this.sendTextMessage(chatId, text || "(empty)", message.replyTo);
        break;
      }
    }

    await this.events?.emit("message:outgoing", {
      channelId: chatId,
      messageId: chatId,
    });
  }

  // ── Polling ──────────────────────────────────────────────────

  private startPolling(): void {
    this.polling = true;
    this.poll();
  }

  private stopPolling(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private poll(): void {
    if (!this.polling) return;

    this.fetchUpdates()
      .catch((err) => {
        this.logger?.error(
          `Telegram polling error: ${err instanceof Error ? err.message : String(err)}`
        );
      })
      .finally(() => {
        if (this.polling) {
          const interval =
            this.config.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
          this.pollTimer = setTimeout(() => this.poll(), interval);
        }
      });
  }

  private async fetchUpdates(): Promise<void> {
    const updates = await this.apiCall<TelegramUpdate[]>("getUpdates", {
      offset: this.offset,
      timeout: 30,
      allowed_updates: ["message"],
    });

    for (const update of updates) {
      this.offset = update.update_id + 1;

      if (!update.message) continue;

      const msg = update.message;

      // Filter by allowed chat IDs if configured
      if (
        this.config.allowedChatIds &&
        this.config.allowedChatIds.length > 0 &&
        !this.config.allowedChatIds.includes(msg.chat.id)
      ) {
        this.logger?.debug(
          `Ignoring message from non-allowed chat ${msg.chat.id}`
        );
        continue;
      }

      await this.processMessage(msg);
    }
  }

  // ── Message processing ───────────────────────────────────────

  private async processMessage(msg: TelegramMessage): Promise<void> {
    if (!this.handler) return;

    const content = await this.extractContent(msg);
    if (!content) return;

    const incoming: IncomingMessage = {
      id: String(msg.message_id),
      channelId: String(msg.chat.id),
      authorId: String(msg.from?.id ?? 0),
      authorName: this.formatAuthorName(msg.from),
      content,
      timestamp: new Date(msg.date * 1000),
      replyTo: msg.reply_to_message
        ? String(msg.reply_to_message.message_id)
        : undefined,
      metadata: {
        chatType: msg.chat.type,
        chatTitle: msg.chat.title,
        chatUsername: msg.chat.username,
      },
    };

    await this.events?.emit("message:incoming", {
      channelId: incoming.channelId,
      messageId: incoming.id,
    });

    try {
      await this.handler(incoming);
    } catch (err) {
      this.logger?.error(
        `Error in message handler: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async extractContent(
    msg: TelegramMessage
  ): Promise<MessageContent | null> {
    if (msg.text) {
      return { type: "text", text: msg.text };
    }

    // Photo — use the largest resolution available
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      const url = await this.getFileUrl(largest.file_id);
      if (url) {
        return {
          type: "media",
          url,
          mimeType: "image/jpeg",
          caption: msg.caption,
        };
      }
    }

    // Document
    if (msg.document) {
      const url = await this.getFileUrl(msg.document.file_id);
      if (url) {
        return {
          type: "media",
          url,
          mimeType: msg.document.mime_type ?? "application/octet-stream",
          caption: msg.caption,
        };
      }
    }

    // Audio
    if (msg.audio) {
      const url = await this.getFileUrl(msg.audio.file_id);
      if (url) {
        return {
          type: "media",
          url,
          mimeType: msg.audio.mime_type ?? "audio/mpeg",
          caption: msg.caption,
        };
      }
    }

    // Video
    if (msg.video) {
      const url = await this.getFileUrl(msg.video.file_id);
      if (url) {
        return {
          type: "media",
          url,
          mimeType: msg.video.mime_type ?? "video/mp4",
          caption: msg.caption,
        };
      }
    }

    // Voice
    if (msg.voice) {
      const url = await this.getFileUrl(msg.voice.file_id);
      if (url) {
        return {
          type: "media",
          url,
          mimeType: msg.voice.mime_type ?? "audio/ogg",
          caption: msg.caption,
        };
      }
    }

    // If the message has a caption but no recognized attachment, treat as text
    if (msg.caption) {
      return { type: "text", text: msg.caption };
    }

    return null;
  }

  private formatAuthorName(user?: TelegramUser): string {
    if (!user) return "Unknown";
    const parts = [user.first_name];
    if (user.last_name) parts.push(user.last_name);
    return parts.join(" ");
  }

  // ── Sending ──────────────────────────────────────────────────

  private async sendTextMessage(
    chatId: string,
    text: string,
    replyTo?: string
  ): Promise<void> {
    // Split long messages into chunks
    const chunks = this.splitText(text, MAX_TELEGRAM_MESSAGE_LENGTH);

    for (const chunk of chunks) {
      const params: Record<string, unknown> = {
        chat_id: chatId,
        text: chunk,
      };

      if (this.config.parseMode) {
        params.parse_mode = this.config.parseMode;
      }

      if (replyTo) {
        params.reply_parameters = { message_id: Number(replyTo) };
      }

      await this.apiCall("sendMessage", params);

      // Only reply to the original message for the first chunk
      replyTo = undefined;
    }
  }

  private async sendMediaMessage(
    chatId: string,
    content: MessageContent & { type: "media" },
    replyTo?: string
  ): Promise<void> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
    };

    if (content.caption) {
      params.caption = content.caption;
    }

    if (replyTo) {
      params.reply_parameters = { message_id: Number(replyTo) };
    }

    // Choose the right Telegram method based on MIME type
    if (content.mimeType.startsWith("image/")) {
      params.photo = content.url;
      await this.apiCall("sendPhoto", params);
    } else if (content.mimeType.startsWith("audio/")) {
      params.audio = content.url;
      await this.apiCall("sendAudio", params);
    } else if (content.mimeType.startsWith("video/")) {
      params.video = content.url;
      await this.apiCall("sendVideo", params);
    } else {
      params.document = content.url;
      await this.apiCall("sendDocument", params);
    }
  }

  private splitText(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to break at a newline
      let splitAt = remaining.lastIndexOf("\n", maxLength);
      if (splitAt <= 0) {
        // Try to break at a space
        splitAt = remaining.lastIndexOf(" ", maxLength);
      }
      if (splitAt <= 0) {
        // Hard break
        splitAt = maxLength;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks;
  }

  // ── Telegram API helpers ─────────────────────────────────────

  private async apiCall<T>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    const url = `${TELEGRAM_API}/bot${this.config.token}/${method}`;

    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    };

    if (params) {
      init.body = JSON.stringify(params);
    }

    const response = await fetch(url, init);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Telegram API ${method} failed (${response.status}): ${errorText}`
      );
    }

    const data = (await response.json()) as TelegramApiResponse<T>;

    if (!data.ok) {
      throw new Error(
        `Telegram API ${method} returned error: ${data.description ?? "unknown error"}`
      );
    }

    return data.result as T;
  }

  private async getFileUrl(fileId: string): Promise<string | null> {
    try {
      const file = await this.apiCall<TelegramFile>("getFile", {
        file_id: fileId,
      });
      if (file.file_path) {
        return `${TELEGRAM_API}/file/bot${this.config.token}/${file.file_path}`;
      }
      return null;
    } catch (err) {
      this.logger?.warn(
        `Failed to get file URL for ${fileId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }
}

const plugin = new TelegramChannel();
export default plugin;
export { TelegramChannel };
