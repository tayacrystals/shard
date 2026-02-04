import type {
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolDefinition,
  Logger,
} from "@tayacrystals/shard-sdk";

export class ToolExecutor {
  private toolMap: Map<string, Tool>;
  private log: Logger;

  constructor(tools: Tool[], logger: Logger) {
    this.log = logger;
    this.toolMap = new Map();
    for (const tool of tools) {
      this.toolMap.set(tool.name, tool);
    }
  }

  async execute(toolCall: ToolCall, context: ToolContext): Promise<ToolResult> {
    const tool = this.toolMap.get(toolCall.name);
    if (!tool) {
      this.log.warn(`Unknown tool: ${toolCall.name}`);
      return {
        success: false,
        output: `Unknown tool: ${toolCall.name}`,
      };
    }

    try {
      return await tool.execute(toolCall.arguments, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Tool "${toolCall.name}" threw an error: ${message}`);
      return {
        success: false,
        output: `Tool error: ${message}`,
      };
    }
  }

  getDefinitions(allowedTools?: string[]): ToolDefinition[] {
    const tools = allowedTools
      ? allowedTools
          .map((name) => this.toolMap.get(name))
          .filter((t): t is Tool => t !== undefined)
      : Array.from(this.toolMap.values());

    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
}
