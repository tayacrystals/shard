import type { ConfigManager, Logger } from "@shard/sdk";
import { createLogger } from "./logger";

export interface SyncResult {
  installed: string[];
  alreadyInstalled: string[];
  failed: string[];
}

export class PackageManager {
  private log: Logger;

  constructor(
    private config: ConfigManager,
  ) {
    this.log = createLogger("package-manager");
  }

  async sync(): Promise<SyncResult> {
    const plugins = this.config.get<Record<string, unknown>>("plugins") ?? {};
    const packageNames = Object.keys(plugins);

    if (packageNames.length === 0) {
      this.log.info("No plugins configured");
      return { installed: [], alreadyInstalled: [], failed: [] };
    }

    const result: SyncResult = {
      installed: [],
      alreadyInstalled: [],
      failed: [],
    };

    const missing: string[] = [];

    for (const pkg of packageNames) {
      try {
        require.resolve(pkg);
        result.alreadyInstalled.push(pkg);
      } catch {
        missing.push(pkg);
      }
    }

    if (missing.length === 0) {
      this.log.info("All plugin packages already installed");
      return result;
    }

    this.log.info(`Installing ${missing.length} package(s): ${missing.join(", ")}`);

    const proc = Bun.spawn(["bun", "add", ...missing], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;

    if (exitCode === 0) {
      result.installed.push(...missing);
      this.log.info(`Installed: ${missing.join(", ")}`);
    } else {
      const stderr = await new Response(proc.stderr).text();
      result.failed.push(...missing);
      this.log.error(`Failed to install packages: ${stderr}`);
    }

    return result;
  }
}
