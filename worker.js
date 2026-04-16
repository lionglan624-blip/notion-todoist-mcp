/**
 * Notion + Todoist MCP Server for Cloudflare Workers
 *
 * Deploy:
 *   wrangler secret put NOTION_TOKEN   ← Notion integration token
 *   wrangler secret put TODOIST_TOKEN  ← Todoist API token
 *   wrangler deploy
 *
 * Then register the Worker URL as a custom connector in Claude.ai.
 */

import { handleMCP, jsonResp, TOOLS } from "./src/mcp.js";
import {
  CORS_HEADERS,
  handleProtectedResourceMetadata,
  handleAuthServerMetadata,
  handleRegister,
  handleAuthorize,
  handleToken,
} from "./src/oauth.js";
import { runDailyNextLabels } from "./src/cron.js";
import { handleTodoistWebhook } from "./src/webhook.js";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") {
      return handleProtectedResourceMetadata(url);
    }
    if (p === "/.well-known/oauth-authorization-server") {
      return handleAuthServerMetadata(url);
    }
    if (p === "/register") return handleRegister(request);
    if (p === "/authorize") return handleAuthorize(request, url, env);
    if (p === "/token") return handleToken(request, env);

    if (p === "/webhook/todoist") return handleTodoistWebhook(request, env);

    if (p === "/" || p === "/mcp") {
      return handleMCP(request, url, env);
    }

    if (p === "/health") {
      return jsonResp({ status: "ok", tools: TOOLS.length });
    }

    return new Response("Notion + Todoist MCP Server", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyNextLabels(env));
  },
};
