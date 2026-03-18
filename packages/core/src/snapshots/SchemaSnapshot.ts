import type { MCPRecordingClient } from "../client/MCPRecordingClient.js";
import type { ResourceTemplate } from "../client/index.js";

// ── Snapshot format ──────────────────────────────────────────────────────────

export interface ToolSnapshot {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input, serialised for stable comparison. */
  inputSchema: Record<string, unknown>;
}

export interface ResourceSnapshot {
  name: string;
  uri: string;
  description?: string;
}

export interface ResourceTemplateSnapshot {
  name: string;
  uriTemplate: string;
  description?: string;
}

export interface PromptSnapshot {
  name: string;
  description?: string;
}

/**
 * A point-in-time snapshot of an MCP server's declared capabilities.
 * Saved as JSON and compared on subsequent runs to detect schema drift.
 */
export interface ServerSnapshot {
  version: "1.0";
  capturedAt: string;      // ISO 8601
  serverCommand: string;
  tools: ToolSnapshot[];
  resources: ResourceSnapshot[];
  resourceTemplates: ResourceTemplateSnapshot[];
  prompts: PromptSnapshot[];
}

// ── Diff types ───────────────────────────────────────────────────────────────

export type DriftSeverity = "critical" | "high" | "medium" | "info";

export type DriftType =
  | "added"
  | "removed"
  | "description-changed"
  | "schema-changed";

export interface DriftFinding {
  severity: DriftSeverity;
  category: "tool" | "resource" | "prompt";
  name: string;
  type: DriftType;
  description: string;
  before?: string;
  after?: string;
  /**
   * Actionable guidance on what this drift might mean and what to do about it.
   */
  remediation: string;
}

// ── Suspicious patterns (mirrors SecurityScanner) ───────────────────────────

const SUSPICIOUS_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /do\s+not\s+(tell|show|reveal|disclose)/i,
  /system\s*prompt/i,
  /you\s+are\s+now\b/i,
  /new\s+instructions?:/i,
  /\[\s*hidden\s*\]/i,
  /SYSTEM:/,
  /<\s*script[\s>]/i,
  /javascript\s*:/i,
];

function isSuspiciousDescription(text: string): boolean {
  return SUSPICIOUS_PATTERNS.some((p) => p.test(text));
}

// ── Snapshot capture ─────────────────────────────────────────────────────────

/**
 * Captures the current declared capabilities of a connected MCP server.
 */
export async function captureSnapshot(
  client: MCPRecordingClient,
  serverCommand: string
): Promise<ServerSnapshot> {
  const tools = await client.listTools();
  let resources: Awaited<ReturnType<typeof client.listResources>> = [];
  let resourceTemplates: ResourceTemplate[] = [];
  let prompts: Awaited<ReturnType<typeof client.listPrompts>> = [];

  try { resources = await client.listResources(); } catch { /* unsupported */ }
  try { resourceTemplates = await client.listResourceTemplates(); } catch { /* unsupported */ }
  try { prompts = await client.listPrompts(); } catch { /* unsupported */ }

  return {
    version: "1.0",
    capturedAt: new Date().toISOString(),
    serverCommand,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    })),
    resources: resources.map((r) => ({
      name: r.name,
      uri: r.uri,
      description: r.description,
    })),
    resourceTemplates: resourceTemplates.map((t) => ({
      name: t.name,
      uriTemplate: t.uriTemplate,
      description: t.description,
    })),
    prompts: prompts.map((p) => ({
      name: p.name,
      description: p.description,
    })),
  };
}

// ── Diff logic ───────────────────────────────────────────────────────────────

/**
 * Compares a fresh server snapshot against a previously saved baseline.
 * Returns a list of drift findings ordered by severity.
 */
export function diffSnapshots(
  baseline: ServerSnapshot,
  current: ServerSnapshot
): DriftFinding[] {
  const findings: DriftFinding[] = [];

  findings.push(...diffTools(baseline.tools, current.tools));
  findings.push(...diffCapabilities("resource", baseline.resources, current.resources));
  findings.push(...diffCapabilities("resource", baseline.resourceTemplates ?? [], current.resourceTemplates ?? []));
  findings.push(...diffCapabilities("prompt", baseline.prompts, current.prompts));

  // Sort: critical → high → medium → info
  const ORDER: DriftSeverity[] = ["critical", "high", "medium", "info"];
  findings.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));

  return findings;
}

function diffTools(
  baseline: ToolSnapshot[],
  current: ToolSnapshot[]
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const baselineMap = new Map(baseline.map((t) => [t.name, t]));
  const currentMap = new Map(current.map((t) => [t.name, t]));

  // Removed tools
  for (const [name] of baselineMap) {
    if (!currentMap.has(name)) {
      findings.push({
        severity: "high",
        category: "tool",
        name,
        type: "removed",
        description: `Tool "${name}" was present in the baseline but is no longer exposed`,
        remediation:
          "A removed tool is a breaking change for any agent relying on it. " +
          "If intentional, update your test collections and notify consumers. " +
          "If unintentional, this may indicate a server misconfiguration or a compromised deployment.",
      });
    }
  }

  // Added tools
  for (const [name] of currentMap) {
    if (!baselineMap.has(name)) {
      findings.push({
        severity: "info",
        category: "tool",
        name,
        type: "added",
        description: `Tool "${name}" is new — not present in the baseline`,
        remediation:
          "Review the new tool's description and input schema before using it in production. " +
          "New tools from untrusted sources could be a vector for tool poisoning. " +
          "Run 'checkspec scan' to generate and run tests for the new tool.",
      });
    }
  }

  // Changed tools
  for (const [name, base] of baselineMap) {
    const curr = currentMap.get(name);
    if (!curr) continue; // handled above

    // Description changed
    const baseDesc = base.description ?? "";
    const currDesc = curr.description ?? "";
    if (baseDesc !== currDesc) {
      const newIsSuspicious = isSuspiciousDescription(currDesc);
      findings.push({
        severity: newIsSuspicious ? "critical" : "high",
        category: "tool",
        name,
        type: "description-changed",
        description: newIsSuspicious
          ? `Tool "${name}" description changed and now contains suspicious instruction-override patterns`
          : `Tool "${name}" description changed`,
        before: baseDesc.slice(0, 300),
        after: currDesc.slice(0, 300),
        remediation: newIsSuspicious
          ? "The updated description contains language that could manipulate LLM behavior — this is a " +
            "classic rug-pull pattern. A server that was safe at approval time can silently become malicious. " +
            "Do not use this tool until the description is reviewed and cleaned. " +
            "Run 'checkspec scan' with --fuzz to verify behavior."
          : "Description changes can subtly alter how an LLM decides to call the tool. " +
            "Review the change carefully: does the new description still accurately reflect behavior? " +
            "Does it add any hidden instructions? " +
            "If expected, run 'checkspec diff ... --update' to accept the new baseline.",
      });
    }

    // Input schema changed
    const baseSchema = JSON.stringify(base.inputSchema);
    const currSchema = JSON.stringify(curr.inputSchema);
    if (baseSchema !== currSchema) {
      findings.push({
        severity: "high",
        category: "tool",
        name,
        type: "schema-changed",
        description: `Tool "${name}" input schema changed — existing callers may break`,
        before: baseSchema.slice(0, 500),
        after: currSchema.slice(0, 500),
        remediation:
          "Input schema changes are breaking changes for any agent or collection that calls this tool. " +
          "Check whether required fields were added, types changed, or field names were renamed. " +
          "Update your .checkspec.json collection to reflect the new schema, then re-run 'checkspec test'.",
      });
    }
  }

  return findings;
}

function diffCapabilities(
  category: "resource" | "prompt",
  baseline: { name: string; description?: string }[],
  current: { name: string; description?: string }[]
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const baselineNames = new Set(baseline.map((x) => x.name));
  const currentNames = new Set(current.map((x) => x.name));

  for (const { name } of baseline) {
    if (!currentNames.has(name)) {
      findings.push({
        severity: "medium",
        category,
        name,
        type: "removed",
        description: `${category === "resource" ? "Resource" : "Prompt"} "${name}" was removed`,
        remediation:
          `Any test collection referencing this ${category} will now fail. ` +
          "Update your collections or investigate why this was removed.",
      });
    }
  }

  for (const { name } of current) {
    if (!baselineNames.has(name)) {
      findings.push({
        severity: "info",
        category,
        name,
        type: "added",
        description: `${category === "resource" ? "Resource" : "Prompt"} "${name}" was added`,
        remediation: `New ${category}. Consider adding a test for it in your collection.`,
      });
    }
  }

  return findings;
}
