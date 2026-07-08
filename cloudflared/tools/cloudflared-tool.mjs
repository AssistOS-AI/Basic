#!/usr/bin/env node
import fs from 'node:fs/promises';
import {
  buildIngress,
  loadOriginPresets,
  normalizeRoutes,
  readRouteState,
  writeRouteState,
} from '../lib/routes.mjs';
import {
  describeCloudflareConfig,
  putTunnelIngress,
  upsertDnsRecords,
} from '../lib/cloudflare-api.mjs';

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function parsePayload(raw) {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      tool: String(parsed?.tool || process.env.TOOL_NAME || '').trim(),
      input: parsed?.input && typeof parsed.input === 'object' ? parsed.input : {},
    };
  } catch {
    return {
      tool: String(process.env.TOOL_NAME || '').trim(),
      input: {},
    };
  }
}

async function readStatusFile(env = process.env) {
  const statusFile = env.CLOUDFLARED_STATUS_FILE || '/root/cloudflared/status.json';
  try {
    return JSON.parse(await fs.readFile(statusFile, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { state: 'unknown', updatedAt: '', pid: null };
    }
    return { state: 'unreadable', updatedAt: '', pid: null, error: error?.message || String(error) };
  }
}

async function status() {
  const state = await readRouteState();
  return {
    ok: true,
    status: await readStatusFile(),
    cloudflare: describeCloudflareConfig(),
    tunnelTokenConfigured: Boolean(String(process.env.TUNNEL_TOKEN || '').trim()),
    baseDomain: String(process.env.CLOUDFLARE_BASE_DOMAIN || '').trim(),
    origins: loadOriginPresets(),
    routes: state.routes,
    updatedAt: state.updatedAt,
  };
}

async function validate(input) {
  const { routes, origins } = normalizeRoutes(input.routes || []);
  return {
    ok: true,
    origins,
    routes,
    ingress: buildIngress(routes),
  };
}

async function apply(input) {
  const { routes, origins } = normalizeRoutes(input.routes || []);
  const ingress = buildIngress(routes);
  const cloudflareResult = await putTunnelIngress(ingress);
  const dns = input.createDnsRecords === false
    ? []
    : await upsertDnsRecords(routes);
  const state = await writeRouteState(routes);
  return {
    ok: true,
    origins,
    routes,
    ingress,
    dns,
    cloudflareResult,
    updatedAt: state.updatedAt,
  };
}

async function main() {
  const { tool, input } = parsePayload(await readStdin());
  let result;
  if (tool === 'cloudflared_status') result = await status();
  else if (tool === 'cloudflared_routes_validate') result = await validate(input);
  else if (tool === 'cloudflared_routes_apply') result = await apply(input);
  else throw new Error(`Unknown cloudflared tool: ${tool}`);
  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
