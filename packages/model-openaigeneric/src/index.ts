import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelInfo,
  ModelProvider,
  PluginContext,
  ToolCall,
  ToolDefinition,
  TokenUsage,
} from "@shard/sdk";

type ModelInfoConfig = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
};

type OpenAIGenericConfig = {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  organization?: string;
  project?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  models?: ModelInfoConfig[];
  modelDefaults?: Omit<ModelInfo, "id" | "name"> & { contextWindow?: number };
};

type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

type OpenAIToolCall = {
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
};

type OpenAIChatCompletionResponse = {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type OpenAIChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

class OpenAIGenericModel implements ModelProvider {
  readonly name = "@shard/model-openaigeneric";
  readonly version = "0.1.0";
  readonly type = "model" as const;

  private config: OpenAIGenericConfig = {};
  private logger?: PluginContext["logger"];

  async init(context: PluginContext): Promise<void> {
    this.logger = context.logger;
    this.config =
      context.config.get<OpenAIGenericConfig>(
        'plugins."@shard/model-openaigeneric"'
      ) ?? {};
  }

  async destroy(): Promise<void> {
    return;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.requestJson<OpenAIChatCompletionResponse>(
      "/chat/completions",
      {
        method: "POST",
        body: JSON.stringify(this.buildChatPayload(request, false)),
      }
    );

    const choice = response.choices?.[0];
    if (!choice?.message) {
      throw new Error("OpenAI-like response missing message");
    }

    const toolCalls = this.fromOpenAiToolCalls(choice.message.tool_calls);

    return {
      message: {
        role: "assistant",
        content: choice.message.content ?? "",
        toolCalls: toolCalls.length ? toolCalls : undefined,
      },
      usage: this.toUsage(response.usage),
      finishReason: this.normalizeFinishReason(choice.finish_reason),
    };
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const response = await this.requestRaw("/chat/completions", {
      method: "POST",
      body: JSON.stringify(this.buildChatPayload(request, true)),
    });

    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let lineEnd = buffer.indexOf("\n");
      while (lineEnd !== -1) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        lineEnd = buffer.indexOf("\n");

        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") return;

        const chunk = JSON.parse(data) as OpenAIChatCompletionChunk;
        const choice = chunk.choices?.[0];
        if (!choice?.delta) continue;

        const toolCalls = this.fromOpenAiToolCalls(choice.delta.tool_calls);

        yield {
          delta: choice.delta.content ?? "",
          toolCalls: toolCalls.length ? toolCalls : undefined,
          usage: chunk.usage ? this.toUsage(chunk.usage) : undefined,
          finishReason: choice.finish_reason
            ? this.normalizeFinishReason(choice.finish_reason)
            : undefined,
        };
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.config.models && this.config.models.length > 0) {
      return this.config.models.map((model) => this.toModelInfo(model));
    }

    try {
      const response = await this.requestJson<{ data?: Array<{ id: string }> }>(
        "/models",
        { method: "GET" }
      );

      const models = response.data ?? [];
      if (models.length === 0 && this.config.defaultModel) {
        return [this.toModelInfo({ id: this.config.defaultModel })];
      }

      return models.map((model) => this.toModelInfo({ id: model.id }));
    } catch (err) {
      this.logger?.warn("Failed to fetch models, using fallback.", err);
      if (this.config.defaultModel) {
        return [this.toModelInfo({ id: this.config.defaultModel })];
      }
      return [];
    }
  }

  private toModelInfo(model: ModelInfoConfig): ModelInfo {
    const defaults = {
      contextWindow: 8192,
      supportsTools: true,
      supportsStreaming: true,
      ...this.config.modelDefaults,
    };

    return {
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow ?? defaults.contextWindow,
      maxOutputTokens: model.maxOutputTokens ?? defaults.maxOutputTokens,
      supportsTools: model.supportsTools ?? defaults.supportsTools,
      supportsStreaming: model.supportsStreaming ?? defaults.supportsStreaming,
    };
  }

  private buildChatPayload(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const model = request.model || this.config.defaultModel;
    if (!model) {
      throw new Error("Model is required for OpenAI-like chat requests");
    }

    const payload: Record<string, unknown> = {
      model,
      messages: this.toOpenAiMessages(request.messages),
      stream,
    };

    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.maxTokens !== undefined) payload.max_tokens = request.maxTokens;

    if (request.tools && request.tools.length > 0) {
      payload.tools = this.toOpenAiTools(request.tools);
    }

    return payload;
  }

  private toOpenAiMessages(messages: ChatMessage[]): OpenAIMessage[] {
    return messages.map((message) => {
      const base: OpenAIMessage = {
        role: message.role,
        content: message.content,
      };

      if (message.name) base.name = message.name;
      if (message.role === "tool" && message.toolCallId) {
        base.tool_call_id = message.toolCallId;
      }

      if (message.toolCalls && message.toolCalls.length > 0) {
        base.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
          },
        }));
      }

      return base;
    });
  }

  private toOpenAiTools(tools: ToolDefinition[]): OpenAITool[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  private fromOpenAiToolCalls(toolCalls?: OpenAIToolCall[]): ToolCall[] {
    if (!toolCalls || toolCalls.length === 0) return [];

    return toolCalls.map((call, index) => ({
      id: call.id ?? `tool_call_${index}`,
      name: call.function?.name ?? "unknown",
      arguments: this.parseToolArguments(call.function?.arguments ?? ""),
    }));
  }

  private parseToolArguments(args: string): Record<string, unknown> {
    if (!args) return {};
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return { __raw: args };
    }
  }

  private toUsage(usage?: OpenAIChatCompletionResponse["usage"]): TokenUsage {
    return {
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
    };
  }

  private normalizeFinishReason(reason?: string | null): ChatResponse["finishReason"] {
    if (!reason) return "stop";
    if (reason === "tool_calls") return "tool_calls";
    if (reason === "length") return "length";
    if (reason === "stop") return "stop";
    return "error";
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    if (this.config.organization) {
      headers["OpenAI-Organization"] = this.config.organization;
    }

    if (this.config.project) {
      headers["OpenAI-Project"] = this.config.project;
    }

    if (this.config.headers) {
      Object.assign(headers, this.config.headers);
    }

    return headers;
  }

  private buildUrl(path: string): string {
    const baseUrl = this.config.baseUrl ?? DEFAULT_BASE_URL;
    const trimmedBase = baseUrl.replace(/\/+$/, "");
    const trimmedPath = path.replace(/^\/+/, "");
    return `${trimmedBase}/${trimmedPath}`;
  }

  private async requestRaw(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = this.config.timeoutMs;
    const timeoutId = timeout
      ? setTimeout(() => controller.abort(), timeout)
      : undefined;

    try {
      const response = await fetch(this.buildUrl(path), {
        ...init,
        headers: {
          ...this.buildHeaders(),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `OpenAI-like request failed (${response.status}): ${errorText}`
        );
      }

      return response;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.requestRaw(path, init);
    return (await response.json()) as T;
  }
}

const plugin = new OpenAIGenericModel();
export default plugin;
export { OpenAIGenericModel };
