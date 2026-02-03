import type { Plugin } from "./plugin";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  stream?: boolean;
}

export interface ChatResponse {
  message: ChatMessage;
  usage: TokenUsage;
  finishReason: "stop" | "tool_calls" | "length" | "error";
}

export interface ChatChunk {
  delta: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  finishReason?: ChatResponse["finishReason"];
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens?: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
}

export interface ModelProvider extends Plugin {
  readonly type: "model";
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<ChatChunk>;
  listModels(): Promise<ModelInfo[]>;
}
