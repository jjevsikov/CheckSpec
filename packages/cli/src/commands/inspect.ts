import { Command } from "commander";
import chalk from "chalk";
import { MCPRecordingClient } from "@checkspec/core";
import { buildTransport, buildTransportFromConfig, parseEnvPairs, isConnectionError, dieWithConnectionError } from "../transport.js";

export function createInspectCommand(): Command {
  return new Command("inspect")
    .description("Connect to an MCP server and display all capabilities in a readable format")
    .argument("[server-command]", "Command to start the MCP server. Omit when using --url.")
    .option(
      "--url <url>",
      "URL of a running HTTP-based MCP server (alternative to a server command)"
    )
    .option(
      "--transport <type>",
      "Transport protocol: streamable-http (default) or sse",
      "streamable-http"
    )
    .option(
      "--header <KEY=VALUE>",
      "Add an HTTP header to every request, e.g. 'Authorization=Bearer tok' (repeatable)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option("--cwd <dir>", "Working directory for the server process (useful for Python uv projects)")
    .option(
      "--env <KEY=VALUE>",
      "Set an environment variable for the server process (repeatable)",
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option(
      "--verbose",
      "Show server stderr output (useful for debugging; hides Python log noise by default)",
      false
    )
    .action(async (serverCommandArg: string | undefined, options: {
      url?: string;
      transport?: string;
      header: string[];
      cwd?: string;
      env: string[];
      verbose: boolean;
    }) => {
      if (!serverCommandArg && !options.url) {
        console.error("Error: provide either a server command or --url <url>");
        process.exit(1);
      }

      const serverCommand = options.url ?? serverCommandArg!;

      let envVars: Record<string, string> | undefined;
      try {
        envVars = options.env.length > 0 ? parseEnvPairs(options.env) : undefined;
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      let headers: Record<string, string> | undefined;
      try {
        headers = options.header.length > 0 ? parseEnvPairs(options.header) : undefined;
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }

      let transport;
      if (options.url) {
        transport = buildTransportFromConfig({
          url: options.url,
          transport: options.transport as "streamable-http" | "sse" | undefined,
          headers,
        });
      } else {
        transport = buildTransport(serverCommandArg!, {
          cwd: options.cwd,
          env: envVars,
          verbose: options.verbose,
        });
      }
      const client = new MCPRecordingClient(transport);

      try {
        try {
          await client.connect();
        } catch (err) {
          if (isConnectionError(err)) dieWithConnectionError(serverCommand, options.verbose);
          throw err;
        }

        console.log(chalk.bold("\n=== MCP Server Capabilities ===\n"));

        // Tools
        const tools = await client.listTools();
        console.log(chalk.bold.cyan(`Tools (${tools.length}):`));
        if (tools.length === 0) {
          console.log(chalk.gray("  (none)"));
        } else {
          for (const tool of tools) {
            console.log(chalk.green(`  • ${tool.name}`));
            if (tool.description) {
              console.log(chalk.gray(`    ${tool.description}`));
            }
            if (tool.inputSchema.properties) {
              const props = Object.entries(tool.inputSchema.properties)
                .map(([k, v]) => `${k}: ${(v as { type?: string }).type ?? "any"}`)
                .join(", ");
              console.log(chalk.gray(`    Input: { ${props} }`));
            }
          }
        }

        // Resources
        console.log(chalk.bold.cyan(`\nResources:`));
        try {
          const resources = await client.listResources();
          if (resources.length === 0) {
            console.log(chalk.gray("  (none)"));
          } else {
            for (const resource of resources) {
              console.log(chalk.green(`  • ${resource.name}`));
              console.log(chalk.gray(`    URI: ${resource.uri}`));
              if (resource.description) {
                console.log(chalk.gray(`    ${resource.description}`));
              }
            }
          }
        } catch {
          console.log(chalk.gray("  (not supported)"));
        }

        // Prompts
        console.log(chalk.bold.cyan(`\nPrompts:`));
        try {
          const prompts = await client.listPrompts();
          if (prompts.length === 0) {
            console.log(chalk.gray("  (none)"));
          } else {
            for (const prompt of prompts) {
              console.log(chalk.green(`  • ${prompt.name}`));
              if (prompt.description) {
                console.log(chalk.gray(`    ${prompt.description}`));
              }
            }
          }
        } catch {
          console.log(chalk.gray("  (not supported)"));
        }

        console.log();
      } finally {
        await client.disconnect();
      }
    });
}
