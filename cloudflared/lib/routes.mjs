import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STATE_FILE = '/root/cloudflared/routes.json';
const ROUTER_SERVICE = 'http://ploinky-router:8080';
const DEFAULT_ORIGINS = [
  {
    id: 'router',
    label: 'Ploinky router',
    service: ROUTER_SERVICE,
    description: 'Router-hosted Explorer and agent HTTP/WebSocket surfaces.',
  },
];

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePathPattern(value) {
  const raw = normalizeString(value);
  if (!raw) return '';
  if (!raw.startsWith('/')) {
    throw new Error('Route path must be empty or start with "/".');
  }
  if (/[\u0000-\u001f]/.test(raw)) {
    throw new Error('Route path contains control characters.');
  }
  if (raw.length > 256) {
    throw new Error('Route path must be at most 256 characters.');
  }
  return raw;
}

function normalizeHostname(value, { baseDomain }) {
  const raw = normalizeString(value).toLowerCase().replace(/\.+$/g, '');
  if (!raw) throw new Error('Route hostname is required.');
  if (raw.includes('*')) throw new Error('Wildcard hostnames are not enabled for this dashboard.');
  if (!/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/.test(raw)) {
    throw new Error(`Invalid route hostname: ${value}`);
  }
  if (baseDomain) {
    const normalizedBase = baseDomain.toLowerCase().replace(/^\.+|\.+$/g, '');
    if (raw !== normalizedBase && !raw.endsWith(`.${normalizedBase}`)) {
      throw new Error(`Hostname ${raw} must be under ${normalizedBase}.`);
    }
  }
  return raw;
}

function normalizeService(value) {
  const raw = normalizeString(value);
  if (!raw) throw new Error('Route service is required.');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid route service URL: ${raw}`);
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Route service must be an origin URL without path, query, or fragment.');
  }
  if (parsed.origin !== ROUTER_SERVICE) {
    throw new Error(`Route service must equal ${ROUTER_SERVICE}.`);
  }
  return ROUTER_SERVICE;
}

export function loadOriginPresets(env = process.env) {
  const raw = normalizeString(env.CLOUDFLARED_ALLOWED_ORIGINS_JSON);
  if (raw) {
    throw new Error('CLOUDFLARED_ALLOWED_ORIGINS_JSON overrides are not supported.');
  }
  return DEFAULT_ORIGINS.map((origin) => ({ ...origin }));
}

export function normalizeRoutes(inputRoutes, { env = process.env } = {}) {
  if (!Array.isArray(inputRoutes)) {
    throw new Error('routes must be an array.');
  }
  const baseDomain = normalizeString(env.CLOUDFLARE_BASE_DOMAIN);
  const origins = loadOriginPresets(env);
  const originById = new Map(origins.map((origin) => [origin.id, origin]));
  const seen = new Set();
  const routes = inputRoutes.map((entry, index) => {
    const originId = normalizeString(entry?.originId);
    const origin = originById.get(originId);
    if (!origin) throw new Error(`Unknown originId at route ${index + 1}: ${originId || '(empty)'}`);
    const hostname = normalizeHostname(entry?.hostname, { baseDomain });
    const pathPattern = normalizePathPattern(entry?.path);
    const key = `${hostname}\n${pathPattern}`;
    if (seen.has(key)) throw new Error(`Duplicate route for ${hostname}${pathPattern || '/'}.`);
    seen.add(key);
    const requestedService = normalizeString(entry?.service);
    const service = requestedService ? normalizeService(requestedService) : origin.service;
    if (service !== origin.service) {
      throw new Error(`Route service for origin ${originId} must equal ${origin.service}.`);
    }
    return {
      id: normalizeString(entry?.id) || `route_${index + 1}`,
      enabled: entry?.enabled !== false,
      hostname,
      path: pathPattern,
      originId,
      service,
      description: normalizeString(entry?.description),
    };
  });
  return { routes, origins };
}

export function buildIngress(routes) {
  const hostnameOrder = new Map();
  for (const route of routes) {
    if (!route?.enabled || hostnameOrder.has(route.hostname)) continue;
    hostnameOrder.set(route.hostname, hostnameOrder.size);
  }
  const ingress = routes
    .filter((route) => route.enabled)
    .map((route, index) => ({ route, index }))
    .sort((left, right) => {
      if (left.route.hostname !== right.route.hostname) {
        return (hostnameOrder.get(left.route.hostname) ?? left.index)
          - (hostnameOrder.get(right.route.hostname) ?? right.index);
      }
      const leftPath = left.route.path || '';
      const rightPath = right.route.path || '';
      if (leftPath && rightPath && leftPath.length !== rightPath.length) {
        return rightPath.length - leftPath.length;
      }
      if (leftPath && !rightPath) return -1;
      if (!leftPath && rightPath) return 1;
      return left.index - right.index;
    })
    .map(({ route }) => route)
    .map((route) => ({
      hostname: route.hostname,
      ...(route.path ? { path: route.path } : {}),
      service: route.service,
    }));
  ingress.push({ service: 'http_status:404' });
  return ingress;
}

export async function readRouteState({ env = process.env } = {}) {
  const stateFile = env.CLOUDFLARED_STATE_FILE || DEFAULT_STATE_FILE;
  try {
    const raw = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    const routes = Array.isArray(parsed?.routes) ? parsed.routes : [];
    return { version: 1, updatedAt: parsed?.updatedAt || '', routes };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { version: 1, updatedAt: '', routes: [] };
    }
    throw error;
  }
}

export async function writeRouteState(routes, { env = process.env } = {}) {
  const stateFile = env.CLOUDFLARED_STATE_FILE || DEFAULT_STATE_FILE;
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    routes,
  };
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}
