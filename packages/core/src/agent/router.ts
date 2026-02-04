import type {
  Channel,
  AgentDefinition,
  IncomingMessage,
  MessageHandler,
  EventBus,
  Logger,
} from "@tayacrystals/shard-sdk";
import type { AgentLoop } from "./loop";

export class MessageRouter {
  private agentLoop: AgentLoop;
  private channels: Channel[];
  private definition: AgentDefinition;
  private events: EventBus;
  private log: Logger;
  private handlers: Map<Channel, MessageHandler> = new Map();

  constructor(
    agentLoop: AgentLoop,
    channels: Channel[],
    definition: AgentDefinition,
    events: EventBus,
    logger: Logger,
  ) {
    this.agentLoop = agentLoop;
    this.channels = channels;
    this.definition = definition;
    this.events = events;
    this.log = logger;
  }

  start(): void {
    for (const channel of this.channels) {
      const handler: MessageHandler = async (message: IncomingMessage) => {
        await this.handleMessage(channel, message);
      };
      channel.onMessage(handler);
      this.handlers.set(channel, handler);
    }
  }

  stop(): void {
    this.handlers.clear();
  }

  private async handleMessage(
    channel: Channel,
    message: IncomingMessage,
  ): Promise<void> {
    if (message.content.type !== "text") {
      this.log.debug(
        `Skipping non-text message ${message.id} (type: ${message.content.type})`,
      );
      return;
    }

    const text = message.content.text;
    this.log.info(
      `Received message from ${message.authorName} on ${message.channelId}`,
    );

    try {
      const result = await this.agentLoop.run(this.definition, text, {
        agentId: this.definition.id,
        channelId: message.channelId,
      });

      if (result.output) {
        await channel.send({
          channelId: message.channelId,
          content: { type: "text", text: result.output },
          replyTo: message.id,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log.error(`Error processing message ${message.id}: ${errorMsg}`);

      try {
        await channel.send({
          channelId: message.channelId,
          content: {
            type: "text",
            text: "Sorry, something went wrong processing your message.",
          },
          replyTo: message.id,
        });
      } catch (sendErr) {
        this.log.error(
          `Failed to send error reply: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`,
        );
      }
    }
  }
}
