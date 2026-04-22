export interface ExtensionBuildTask {
  entryPoints: string[];
  outfile: string;
  [key: string]: unknown;
}

export interface ExtensionBuildConfig {
  watch?: boolean;
  sharedOptions?: Record<string, unknown>;
  tasks: ExtensionBuildTask[];
  prepare?: (context: { watch: boolean }) => void | Promise<void>;
  afterBuild?: (context: { watch: boolean; results?: unknown[] }) => void | Promise<void>;
  watchMessage?: string;
}

export interface PackEntry {
  full: string;
  rel: string;
}

export interface PackResult {
  entries: PackEntry[];
  zipName: string;
  zipPath?: string;
  zipOutputDir?: string;
}

export declare function getDefaultEnvFiles(): string[];
export declare function loadCwsEnvironment(rootDir: string, explicitFilePath?: string | null): Promise<{
  filePath: string | null;
  format: string | null;
  values: Record<string, string | undefined>;
}>;
export declare function parseItemUrl(itemUrl: string, label?: string): {
  publisherId: string;
  extensionId: string;
};
export declare function defineExtensionBuild(config: ExtensionBuildConfig): ExtensionBuildConfig;
export declare function buildExtension(config: ExtensionBuildConfig): Promise<unknown>;
export declare function packExtension(config: {
  rootDir: string;
  skipBuild?: boolean;
  buildCommand?: { command: string; args: string[] };
  collectPackResult: () => Promise<PackResult> | PackResult;
}): Promise<{ zipPath: string; zipName: string; sizeBytes: number }>;
export declare function runPublishCws(config: {
  rootDir: string;
  manifestPath?: string;
  defaultZipPath: (version: string) => string;
  usageZipLine: string;
}): Promise<void>;
export declare function runSetupGithubSecrets(config: {
  rootDir: string;
}): Promise<void>;
