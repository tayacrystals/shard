import type { ConfigManager, Logger } from "@tayacrystals/shard-sdk";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createLogger } from "./logger";

export interface SyncResult {
  installed: string[];
  alreadyInstalled: string[];
  failed: string[];
  updated: string[];
  skippedUpdate: boolean;
}

export interface SyncOptions {
  autoUpdate?: boolean;
  updateIntervalHours?: number;
  statePath?: string;
  installDir?: string;
  modulePaths?: string[];
}

export class PackageManager {
  private log: Logger;

  constructor(
    private config: ConfigManager,
  ) {
    this.log = createLogger("package-manager");
  }

  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const plugins = this.config.get<Record<string, unknown>>("plugins") ?? {};
    const packageNames = Object.keys(plugins);
    const installDir = options.installDir ?? process.cwd();
    const modulePaths = options.modulePaths ?? [join(installDir, "node_modules")];
    const require = createRequire(import.meta.url);

    if (packageNames.length === 0) {
      this.log.info("No plugins configured");
      return { installed: [], alreadyInstalled: [], failed: [], updated: [], skippedUpdate: true };
    }

    const result: SyncResult = {
      installed: [],
      alreadyInstalled: [],
      failed: [],
      updated: [],
      skippedUpdate: true,
    };

    const missing: string[] = [];

    for (const pkg of packageNames) {
      try {
        require.resolve(pkg, { paths: modulePaths });
        result.alreadyInstalled.push(pkg);
      } catch {
        missing.push(pkg);
      }
    }

    if (missing.length > 0) {
      this.log.info(`Installing ${missing.length} package(s): ${missing.join(", ")}`);

      const proc = Bun.spawn(["bun", "add", ...missing], {
        cwd: installDir,
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
    } else {
      this.log.info("All plugin packages already installed");
    }

    const autoUpdate = options.autoUpdate ?? false;
    if (autoUpdate) {
      const updateIntervalHours = options.updateIntervalHours ?? 24;
      const statePath = options.statePath;
      const shouldUpdate = await this.shouldUpdate(statePath, updateIntervalHours);
      if (shouldUpdate) {
        const updateResult = await this.updatePackages(packageNames, installDir);
        result.updated.push(...updateResult.updated);
        result.skippedUpdate = false;

        if (statePath) {
          await this.writeUpdateState(statePath, Date.now());
        }
      } else {
        this.log.info("Skipping plugin auto-update (interval not reached)");
        result.skippedUpdate = true;
      }
    }

    return result;
  }

  private async updatePackages(packages: string[], installDir: string): Promise<{ updated: string[] }>
  {
    if (packages.length === 0) return { updated: [] };

    const targets = packages.map((pkg) => `${pkg}@latest`);
    this.log.info(`Updating ${targets.length} plugin package(s): ${packages.join(", ")}`);

    const proc = Bun.spawn(["bun", "add", ...targets], {
      cwd: installDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;

    if (exitCode === 0) {
      this.log.info(`Updated: ${packages.join(", ")}`);
      return { updated: [...packages] };
    }

    const stderr = await new Response(proc.stderr).text();
    this.log.error(`Failed to update plugin packages: ${stderr}`);
    return { updated: [] };
  }

  private async shouldUpdate(statePath: string | undefined, intervalHours: number): Promise<boolean> {
    if (!statePath) return true;
    if (!existsSync(statePath)) return true;

    try {
      const raw = await readFile(statePath, "utf-8");
      const parsed = JSON.parse(raw) as { lastUpdated?: number };
      const lastUpdated = parsed.lastUpdated ?? 0;
      const intervalMs = Math.max(0, intervalHours) * 60 * 60 * 1000;
      return Date.now() - lastUpdated >= intervalMs;
    } catch (err) {
      this.log.warn("Failed to read update state, proceeding with update", err);
      return true;
    }
  }

  private async writeUpdateState(statePath: string, timestamp: number): Promise<void> {
    try {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify({ lastUpdated: timestamp }), "utf-8");
    } catch (err) {
      this.log.warn("Failed to write update state", err);
    }
  }
}
