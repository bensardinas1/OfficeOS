#!/usr/bin/env node
/**
 * mcp-server.js — OfficeOS MCP Server
 *
 * Exposes all OfficeOS connectors as MCP tools for Claude Desktop.
 * Uses stdio transport — configure in claude_desktop_config.json.
 *
 * Tools:
 *   fetch_emails       — Fetch recent inbox emails (Outlook)
 *   fetch_sent_emails  — Fetch recent sent emails for voice analysis
 *   fetch_thread       — Fetch full email thread by message ID
 *   classify_emails    — Classify emails into triage categories
 *   delete_emails      — Move Outlook emails to trash
 *   delete_gmail_emails — Move Gmail emails to trash
 *   save_draft         — Create an Outlook draft
 *   save_gmail_draft   — Create a Gmail draft
 *   list_accounts      — List configured accounts
 *   read_config        — Read config files (prefs, account-types)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function configPath(file) {
  return join(PROJECT_ROOT, "config", file);
}

function readJsonConfig(file) {
  return JSON.parse(readFileSync(configPath(file), "utf-8"));
}

/** Run a script and return { stdout, stderr, code } */
function runScript(scriptName, args = []) {
  return new Promise((resolve) => {
    const child = execFile(
      "node",
      [join(__dirname, scriptName), ...args],
      { cwd: PROJECT_ROOT, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
          code: err ? err.code ?? 1 : 0,
        });
      }
    );
  });
}

/** Run a script that reads JSON from stdin */
function runScriptWithStdin(scriptName, args, stdinData) {
  return new Promise((resolve) => {
    const child = execFile(
      "node",
      [join(__dirname, scriptName), ...args],
      { cwd: PROJECT_ROOT, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
          code: err ? err.code ?? 1 : 0,
        });
      }
    );
    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "fetch_emails",
    description:
      "Fetch recent inbox emails from an Outlook account. Returns JSON array of email objects with id, subject, from, fromName, received, preview, etc.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID from companies.json (e.g. 'healthcarema')" },
        hours: { type: "number", description: "How many hours back to fetch (default: 24)", default: 24 },
        folder: { type: "string", description: "Mail folder to fetch from (default: 'inbox')", default: "inbox" },
      },
      required: ["accountId"],
    },
  },
  {
    name: "fetch_sent_emails",
    description:
      "Fetch recent sent emails for voice profile analysis. Filters out forwards and auto-replies. Works for both Outlook and Gmail accounts.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID from companies.json" },
        count: { type: "number", description: "Number of sent emails to fetch (default: 60)", default: 60 },
      },
      required: ["accountId"],
    },
  },
  {
    name: "fetch_thread",
    description:
      "Fetch the full email conversation thread for an Outlook message. Returns threadId, subject, and all messages with body text.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID from companies.json" },
        messageId: { type: "string", description: "The Outlook message ID to fetch the thread for" },
      },
      required: ["accountId", "messageId"],
    },
  },
  {
    name: "classify_emails",
    description:
      "Classify an array of emails into triage categories for a given account. Pipe raw email JSON into the classifier. Returns categories and deletion candidates.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID from companies.json" },
        emails: {
          type: "array",
          description: "Array of email objects (as returned by fetch_emails)",
          items: { type: "object" },
        },
      },
      required: ["accountId", "emails"],
    },
  },
  {
    name: "delete_emails",
    description:
      "Move Outlook emails to Deleted Items (soft delete, recoverable). Provide the account ID and list of message IDs.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID from companies.json" },
        messageIds: {
          type: "array",
          description: "Array of Outlook message IDs to delete",
          items: { type: "string" },
        },
      },
      required: ["accountId", "messageIds"],
    },
  },
  {
    name: "delete_gmail_emails",
    description:
      "Move Gmail emails to Trash (soft delete, recoverable for 30 days). Provide list of Gmail message IDs.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          description: "Array of Gmail message IDs to trash",
          items: { type: "string" },
        },
      },
      required: ["messageIds"],
    },
  },
  {
    name: "save_draft",
    description:
      "Create an email draft in the Drafts-OfficeOS folder for an Outlook account. Optionally reply to an existing message.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID from companies.json" },
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        cc: { type: "array", items: { type: "string" }, description: "CC email addresses" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body text (plain text, will be converted to HTML)" },
        replyToMessageId: { type: "string", description: "Optional: message ID to reply to" },
      },
      required: ["accountId", "to", "subject", "body"],
    },
  },
  {
    name: "save_gmail_draft",
    description:
      "Create a Gmail draft with the Drafts-OfficeOS label. Optionally link to an existing thread.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Account ID from companies.json" },
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        cc: { type: "array", items: { type: "string" }, description: "CC email addresses" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body text (plain text)" },
        threadId: { type: "string", description: "Optional: Gmail thread ID to link the draft to" },
      },
      required: ["accountId", "to", "subject", "body"],
    },
  },
  {
    name: "list_accounts",
    description:
      "List all configured accounts with their ID, name, type, and provider. No authentication required.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "read_config",
    description:
      "Read a config file (prefs.json, account-types.json, or companies.json). Returns the file contents as JSON.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Config file to read: 'prefs', 'account-types', or 'companies'",
          enum: ["prefs", "account-types", "companies"],
        },
      },
      required: ["file"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------

async function handleToolCall(name, args) {
  switch (name) {
    case "fetch_emails": {
      const { accountId, hours = 24, folder = "inbox" } = args;
      const result = await runScript("fetch-emails.js", [accountId, String(hours), folder]);
      if (result.code !== 0) return errorResult(result.stderr || "Failed to fetch emails");
      return textResult(result.stdout);
    }

    case "fetch_sent_emails": {
      const { accountId, count = 60 } = args;
      const result = await runScript("fetch-sent-emails.js", [accountId, String(count)]);
      if (result.code !== 0) return errorResult(result.stderr || "Failed to fetch sent emails");
      return textResult(result.stdout);
    }

    case "fetch_thread": {
      const { accountId, messageId } = args;
      const result = await runScript("fetch-thread.js", [accountId, messageId]);
      if (result.code !== 0) return errorResult(result.stderr || "Failed to fetch thread");
      return textResult(result.stdout);
    }

    case "classify_emails": {
      const { accountId, emails } = args;
      const result = await runScriptWithStdin(
        "classify-emails.js",
        [accountId],
        JSON.stringify(emails)
      );
      if (result.code !== 0) return errorResult(result.stderr || "Failed to classify emails");
      return textResult(result.stdout);
    }

    case "delete_emails": {
      const { accountId, messageIds } = args;
      const result = await runScript("delete-emails.js", [accountId, ...messageIds]);
      if (result.code !== 0) return errorResult(result.stderr || "Failed to delete emails");
      return textResult(result.stdout);
    }

    case "delete_gmail_emails": {
      const { messageIds } = args;
      const result = await runScript("delete-gmail-emails.js", messageIds);
      if (result.code !== 0) return errorResult(result.stderr || "Failed to delete Gmail emails");
      return textResult(result.stdout);
    }

    case "save_draft": {
      const { accountId, to, cc, subject, body, replyToMessageId } = args;
      const payload = { to, cc: cc || [], subject, body };
      if (replyToMessageId) payload.replyToMessageId = replyToMessageId;
      const result = await runScriptWithStdin(
        "save-draft.js",
        [accountId],
        JSON.stringify(payload)
      );
      if (result.code !== 0) return errorResult(result.stderr || "Failed to save draft");
      return textResult(result.stdout);
    }

    case "save_gmail_draft": {
      const { accountId, to, cc, subject, body, threadId } = args;
      const payload = { to, cc: cc || [], subject, body };
      if (threadId) payload.threadId = threadId;
      const result = await runScriptWithStdin(
        "save-gmail-draft.js",
        [accountId],
        JSON.stringify(payload)
      );
      if (result.code !== 0) return errorResult(result.stderr || "Failed to save Gmail draft");
      return textResult(result.stdout);
    }

    case "list_accounts": {
      const config = readJsonConfig("companies.json");
      const accounts = (config.companies || []).map((c) => ({
        id: c.id,
        name: c.name,
        accountType: c.accountType,
        provider: c.provider,
        role: c.role,
      }));
      return textResult(JSON.stringify(accounts, null, 2));
    }

    case "read_config": {
      const fileMap = {
        prefs: "prefs.json",
        "account-types": "account-types.json",
        companies: "companies.json",
      };
      const fileName = fileMap[args.file];
      if (!fileName) return errorResult(`Unknown config file: ${args.file}`);
      const data = readJsonConfig(fileName);
      return textResult(JSON.stringify(data, null, 2));
    }

    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Server Setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "officeos", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleToolCall(name, args || {});
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
