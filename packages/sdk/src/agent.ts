export type OrchestrationStrategy = "single" | "parallel" | "sequential" | "router";

export interface DelegateTask {
  agentId: string;
  input: string;
  context?: Record<string, unknown>;
}

export interface AgentResult {
  output: string;
  delegatedResults?: Map<string, AgentResult>;
  metadata?: Record<string, unknown>;
}

export interface AgentContext {
  agentId: string;
  channelId?: string;
  conversationId?: string;
  parentAgentId?: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  tools?: string[];
  strategy: OrchestrationStrategy;
  subAgents?: string[];
  maxTurns?: number;
}

export interface AgentInstance {
  readonly definition: AgentDefinition;
  run(input: string, context: AgentContext): Promise<AgentResult>;
  delegate(tasks: DelegateTask[]): Promise<Map<string, AgentResult>>;
}
