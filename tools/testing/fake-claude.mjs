#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";

const args = process.argv.slice(2);

function argument(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const sessionId = argument("--session-id") ?? argument("--resume") ?? crypto.randomUUID();
const logPath = process.env["VIBEST_E2E_CLAUDE_LOG"];
const configuredResponse = process.env["VIBEST_E2E_CLAUDE_RESPONSE"];
let messageSequence = 0;

function log(value) {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function initialize(requestId) {
  send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        commands: [],
        agents: [],
        output_style: "default",
        available_output_styles: ["default"],
        models: [
          {
            value: "fake-claude",
            displayName: "Fake Claude",
            description: "Deterministic Claude executable used by Vibest tests",
          },
        ],
        account: {},
      },
    },
  });
  send({
    type: "system",
    subtype: "init",
    apiKeySource: "user",
    claude_code_version: "fake",
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [],
    model: "fake-claude",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  });
}

function respondToControlRequest(message) {
  const subtype = message.request?.subtype;
  log({ direction: "input", type: "control_request", subtype });
  if (subtype === "initialize") {
    initialize(message.request_id);
    return;
  }

  const response =
    subtype === "mcp_status"
      ? { mcpServers: [] }
      : subtype === "interrupt"
        ? { still_queued: [] }
        : {};
  send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: message.request_id,
      response,
    },
  });
}

function textFromUserMessage(message) {
  const content = message.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function respondToUserMessage(message) {
  const input = textFromUserMessage(message);
  const response = configuredResponse ?? `Fake Claude received: ${input}`;
  messageSequence += 1;
  log({ direction: "input", type: "user", text: input });

  send({
    type: "assistant",
    message: {
      id: `fake-message-${messageSequence}`,
      type: "message",
      role: "assistant",
      model: "fake-claude",
      content: [{ type: "text", text: response }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  });
  send({
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: response,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: null,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: crypto.randomUUID(),
    session_id: sessionId,
  });
}

log({ direction: "spawn", args });

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline = input.indexOf("\n");
  while (newline !== -1) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.type === "control_request") respondToControlRequest(message);
      if (message.type === "user") respondToUserMessage(message);
    }
    newline = input.indexOf("\n");
  }
});
