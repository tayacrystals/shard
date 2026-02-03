# Shard

aka Taya's AI tool

A daemon for running AI agents with tool capabilities.

## Quick Start

Run the tool with:

bunx @tayacrystals/shard

## Features

- Multiple model provider support (OpenAI, Ollama, etc)
- Uses existing chat interfaces (discord, telegram, terminal shell)
- Configurable agents with different models, tools, and prompts
- Built-in tools for filesystem access, web browsing, time retrieval, code evaluation, and sub-agents
- Persistent memory to maintain context across sessions
- Permission system for tool usage to ensure user control, with the option to let the agents run free or in sandboxes
- Automatic model-selection/switching based on task requirements to optimize performance and cost

## Implementation

- Written in bun with TypeScript
- Modular architecture for easy extension and customization