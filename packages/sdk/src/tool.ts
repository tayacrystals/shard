import type { Plugin } from "./plugin";

export interface Artifact {
  name: string;
  mimeType: string;
  data: string | Uint8Array;
}

export interface ToolResult {
  success: boolean;
  output: string;
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}

export interface ToolContext {
  toolCallId: string;
  agentId?: string;
  channelId?: string;
}

export interface Tool extends Plugin {
  readonly type: "tool";
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
