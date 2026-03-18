// Client
export { MCPRecordingClient } from "./client/index.js";
export type { RecordedMessage, ResourceTemplate } from "./client/index.js";

// Runner
export { TestRunner, resolveIds, slugify } from "./runner/index.js";
export type {
  TestResult,
  RunSummary,
  RunnerOptions,
  CheckSpecCollection,
  ServerConfig,
  TestCase,
  StreamingTestCase,
  StreamExpect,
  HookCommand,
  HookDefinition,
  TestHooks,
  ParameterRow,
  DescribeBlock,
} from "./runner/index.js";

// Hooks
export { HookRunner, HookAbortError, HookContext } from "./hooks/index.js";
export type { HookResult } from "./hooks/index.js";

// Streaming
export { evaluateStreamExpect, runStreamingTest } from "./streaming/index.js";
export type { StreamChunk, StreamingActual } from "./streaming/index.js";

// Assertions
export { MCPExpect, AssertionError, expect } from "./assertions/index.js";

// Generators
export { SchemaInputGenerator, AITestGenerator } from "./generators/index.js";
export type { GeneratorOptions, AIGenerateOptions, GenerateContext } from "./generators/index.js";

// Security
export { SecurityScanner } from "./security/index.js";
export type { SecurityFinding } from "./security/index.js";

// Reporters
export { ConsoleReporter, JUnitReporter, JSONReporter, HTMLReporter } from "./reporters/index.js";
export type { Reporter } from "./reporters/index.js";

// Snapshots (schema drift detection)
export { captureSnapshot, diffSnapshots } from "./snapshots/index.js";
export type {
  ServerSnapshot,
  ToolSnapshot,
  ResourceSnapshot,
  ResourceTemplateSnapshot,
  PromptSnapshot,
  DriftFinding,
  DriftSeverity,
  DriftType,
} from "./snapshots/index.js";
