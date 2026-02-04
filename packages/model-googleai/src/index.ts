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
} from "@tayacrystals/shard-sdk";

type ModelInfoConfig = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
};

type GoogleAIConfig = {
  apiKey?: string;
  defaultModel?: string;
  apiVersion?: string;
  timeoutMs?: number;
  models?: ModelInfoConfig[];
  modelDefaults?: Omit<ModelInfo, "id" | "name"> & { contextWindow?: number };
};

// --- Google AI API types ---

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type GeminiFunctionDeclaration = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

type GeminiTool = {
  functionDeclarations: GeminiFunctionDeclaration[];
};

type GeminiGenerationConfig = {
  temperature?: number;
  maxOutputTokens?: number;
};

type GeminiRequest = {
  contents: GeminiContent[];
  tools?: GeminiTool[];
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: GeminiGenerationConfig;
};

type GeminiCandidate = {
  content?: {
    role?: string;
    parts?: GeminiPart[];
  };
  finishReason?: string;
};

type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
};

type GeminiResponse = {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
};

type GeminiModelInfo = {
  name?: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
};

const DEFAULT_API_VERSION = "v1beta";
const BASE_URL = "https://generativelanguage.googleapis.com";

class GoogleAIModel implements ModelProvider {
  readonly name = "@tayacrystals/shard-model-googleai";
  readonly version = "0.1.0";
  readonly type = "model" as const;

  private config: GoogleAIConfig = {};
  private logger?: PluginContext["logger"];

  async init(context: PluginContext): Promise<void> {
    this.logger = context.logger;
    this.config =
      context.config.get<GoogleAIConfig>(
        'plugins."@tayacrystals/shard-model-googleai"'
      ) ?? {};
  }

  async destroy(): Promise<void> {
    return;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = this.resolveModel(request.model);
    const payload = this.buildRequestPayload(request);

    const response = await this.requestJson<GeminiResponse>(
      `models/${model}:generateContent`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );

    const candidate = response.candidates?.[0];
    if (!candidate?.content) {
      throw new Error("Google AI response missing candidate content");
    }

    const { text, toolCalls } = this.extractPartsContent(candidate.content.parts);

    return {
      message: {
        role: "assistant",
        content: text,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      },
      usage: this.toUsage(response.usageMetadata),
      finishReason: this.normalizeFinishReason(candidate.finishReason),
    };
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const model = this.resolveModel(request.model);
    const payload = this.buildRequestPayload(request);

    const response = await this.requestRaw(
      `models/${model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );

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

        const chunk = JSON.parse(data) as GeminiResponse;
        const candidate = chunk.candidates?.[0];
        if (!candidate?.content?.parts) continue;

        const { text, toolCalls } = this.extractPartsContent(candidate.content.parts);

        yield {
          delta: text,
          toolCalls: toolCalls.length ? toolCalls : undefined,
          usage: chunk.usageMetadata
            ? this.toUsage(chunk.usageMetadata)
            : undefined,
          finishReason: candidate.finishReason
            ? this.normalizeFinishReason(candidate.finishReason)
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
      const response = await this.requestJson<{
        models?: GeminiModelInfo[];
      }>("models", { method: "GET" });

      const models = (response.models ?? []).filter((m) =>
        m.supportedGenerationMethods?.includes("generateContent")
      );

      if (models.length === 0 && this.config.defaultModel) {
        return [this.toModelInfo({ id: this.config.defaultModel })];
      }

      return models.map((m) => {
        const id = m.name?.replace(/^models\//, "") ?? "unknown";
        return this.toModelInfo({
          id,
          name: m.displayName ?? id,
          contextWindow: m.inputTokenLimit,
          maxOutputTokens: m.outputTokenLimit,
        });
      });
    } catch (err) {
      this.logger?.warn("Failed to fetch models, using fallback.", err);
      if (this.config.defaultModel) {
        return [this.toModelInfo({ id: this.config.defaultModel })];
      }
      return [];
    }
  }

  // --- Private helpers ---

  private resolveModel(model: string): string {
    const resolved = model || this.config.defaultModel;
    if (!resolved) {
      throw new Error("Model is required for Google AI chat requests");
    }
    return resolved;
  }

  private buildRequestPayload(request: ChatRequest): GeminiRequest {
    const { systemInstruction, contents } = this.toGeminiContents(
      request.messages
    );

    const payload: GeminiRequest = { contents };

    if (systemInstruction) {
      payload.systemInstruction = {
        parts: [{ text: systemInstruction }],
      };
    }

    const generationConfig: GeminiGenerationConfig = {};
    if (request.temperature !== undefined)
      generationConfig.temperature = request.temperature;
    if (request.maxTokens !== undefined)
      generationConfig.maxOutputTokens = request.maxTokens;
    if (Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
    }

    if (request.tools && request.tools.length > 0) {
      payload.tools = [this.toGeminiTools(request.tools)];
    }

    return payload;
  }

  private toGeminiContents(messages: ChatMessage[]): {
    systemInstruction: string | null;
    contents: GeminiContent[];
  } {
    let systemInstruction: string | null = null;
    const contents: GeminiContent[] = [];

    for (const message of messages) {
      if (message.role === "system") {
        systemInstruction = message.content;
        continue;
      }

      if (message.role === "tool") {
        // Tool results go as "user" role with functionResponse parts
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: message.name ?? "unknown",
                response: this.parseToolResponse(message.content),
              },
            },
          ],
        });
        continue;
      }

      if (message.role === "assistant") {
        const parts: GeminiPart[] = [];
        if (message.content) {
          parts.push({ text: message.content });
        }
        if (message.toolCalls) {
          for (const call of message.toolCalls) {
            parts.push({
              functionCall: {
                name: call.name,
                args: call.arguments ?? {},
              },
            });
          }
        }
        if (parts.length > 0) {
          contents.push({ role: "model", parts });
        }
        continue;
      }

      // "user" role
      contents.push({
        role: "user",
        parts: [{ text: message.content }],
      });
    }

    return { systemInstruction, contents };
  }

  private toGeminiTools(tools: ToolDefinition[]): GeminiTool {
    return {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    };
  }

  private extractPartsContent(parts?: GeminiPart[]): {
    text: string;
    toolCalls: ToolCall[];
  } {
    let text = "";
    const toolCalls: ToolCall[] = [];

    if (!parts) return { text, toolCalls };

    for (const part of parts) {
      if ("text" in part) {
        text += part.text;
      } else if ("functionCall" in part) {
        toolCalls.push({
          id: `call_${toolCalls.length}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        });
      }
    }

    return { text, toolCalls };
  }

  private parseToolResponse(content: string): Record<string, unknown> {
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      return { result: content };
    }
  }

  private toModelInfo(model: ModelInfoConfig): ModelInfo {
    const defaults = {
      contextWindow: 1048576,
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

  private toUsage(usage?: GeminiUsageMetadata): TokenUsage {
    return {
      promptTokens: usage?.promptTokenCount ?? 0,
      completionTokens: usage?.candidatesTokenCount ?? 0,
      totalTokens: usage?.totalTokenCount ?? 0,
    };
  }

  private normalizeFinishReason(
    reason?: string | null
  ): ChatResponse["finishReason"] {
    if (!reason) return "stop";
    if (reason === "STOP") return "stop";
    if (reason === "MAX_TOKENS") return "length";
    if (reason === "FUNCTION_CALL") return "tool_calls";
    if (reason === "SAFETY" || reason === "RECITATION") return "error";
    return "stop";
  }

  private buildUrl(path: string): string {
    const version = this.config.apiVersion ?? DEFAULT_API_VERSION;
    return `${BASE_URL}/${version}/${path}`;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.config.apiKey) {
      headers["x-goog-api-key"] = this.config.apiKey;
    }

    return headers;
  }

  private async requestRaw(
    path: string,
    init: RequestInit
  ): Promise<Response> {
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
          `Google AI request failed (${response.status}): ${errorText}`
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

const plugin = new GoogleAIModel();
export default plugin;
export { GoogleAIModel };
