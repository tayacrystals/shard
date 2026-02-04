import type {
  ModelProvider,
  AgentDefinition,
  AgentContext,
  AgentResult,
  ChatMessage,
  TokenUsage,
  EventBus,
  Logger,
} from "@tayacrystals/shard-sdk";
import type { ToolExecutor } from "./tool-executor";

export class AgentLoop {
  private model: ModelProvider;
  private toolExecutor: ToolExecutor;
  private events: EventBus;
  private log: Logger;

  constructor(
    model: ModelProvider,
    toolExecutor: ToolExecutor,
    events: EventBus,
    logger: Logger,
  ) {
    this.model = model;
    this.toolExecutor = toolExecutor;
    this.events = events;
    this.log = logger;
  }

  async run(
    definition: AgentDefinition,
    input: string,
    context: AgentContext,
  ): Promise<AgentResult> {
    const maxTurns = definition.maxTurns ?? 10;
    const toolDefs = this.toolExecutor.getDefinitions(definition.tools);

    const messages: ChatMessage[] = [
      { role: "system", content: definition.systemPrompt },
      { role: "user", content: input },
    ];

    const totalUsage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    await this.events.emit("agent:run:start", {
      agentId: context.agentId,
      input,
    });

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        const response = await this.model.chat({
          model: definition.model,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
        });

        totalUsage.promptTokens += response.usage.promptTokens;
        totalUsage.completionTokens += response.usage.completionTokens;
        totalUsage.totalTokens += response.usage.totalTokens;

        messages.push(response.message);

        await this.events.emit("agent:turn", {
          agentId: context.agentId,
          turn,
          finishReason: response.finishReason,
        });

        if (response.finishReason !== "tool_calls") {
          const result: AgentResult = {
            output: response.message.content,
            metadata: { usage: totalUsage, turns: turn + 1 },
          };
          await this.events.emit("agent:run:complete", {
            agentId: context.agentId,
            result,
          });
          return result;
        }

        const toolCalls = response.message.toolCalls ?? [];
        for (const toolCall of toolCalls) {
          await this.events.emit("agent:tool:call", {
            agentId: context.agentId,
            toolName: toolCall.name,
            toolCallId: toolCall.id,
          });

          const toolResult = await this.toolExecutor.execute(toolCall, {
            toolCallId: toolCall.id,
            agentId: context.agentId,
            channelId: context.channelId,
          });

          messages.push({
            role: "tool",
            content: toolResult.output,
            toolCallId: toolCall.id,
          });
        }
      }

      // Max turns exceeded
      this.log.warn(
        `Agent "${context.agentId}" reached max turns (${maxTurns})`,
      );
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      const result: AgentResult = {
        output: lastAssistant?.content ?? "",
        metadata: {
          usage: totalUsage,
          turns: maxTurns,
          maxTurnsReached: true,
        },
      };
      await this.events.emit("agent:run:complete", {
        agentId: context.agentId,
        result,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Agent loop error: ${message}`);
      return {
        output: "",
        metadata: { error: message, usage: totalUsage },
      };
    }
  }
}
