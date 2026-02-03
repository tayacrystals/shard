export { Config, resolveConfigPath, ensureConfigFile } from "./config";
export { createLogger, setLogLevel } from "./logger";
export { TypedEventBus } from "./event-bus";
export { PackageManager } from "./package-manager";
export type { SyncResult } from "./package-manager";
export { PluginRegistry } from "./plugin-registry";
export { Runtime } from "./runtime";

if (import.meta.main) {
  const { Runtime: ShardRuntime } = await import("./runtime");
  const { resolveConfigPath, ensureConfigFile } = await import("./config");
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
shard — AI agent runtime

Usage:
  shard [options]

Options:
  --config, -c <path>      Path to TOML config file
                           (default: $SHARD_CONFIG or OS config dir)
  --help, -h               Show help
  --version, -v            Show version

Config resolution order:
  1. --config / -c flag
  2. SHARD_CONFIG environment variable
  3. OS default:
     Windows:   %APPDATA%\\shard\\config.toml
     Linux/Mac: $XDG_CONFIG_HOME/shard/config.toml
`);
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log("shard v0.1.2");
    process.exit(0);
  }

  const configIndex = args.indexOf("--config");
  const configIndexShort = args.indexOf("-c");
  const idx = configIndex !== -1 ? configIndex : configIndexShort;
  const cliPath = idx !== -1 ? args[idx + 1] : undefined;

  if (idx !== -1 && !cliPath) {
    console.error("Error: --config requires a path argument");
    process.exit(1);
  }

  const configPath = resolveConfigPath(cliPath);
  const created = await ensureConfigFile(configPath);
  if (created) {
    console.log(`Created default config at ${configPath}`);
  }

  const runtime = new ShardRuntime();
  runtime.boot(configPath).catch((err: unknown) => {
    console.error("Fatal error during boot:", err);
    process.exit(1);
  });
}
