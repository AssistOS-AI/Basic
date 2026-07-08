function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function getCloudflareConfig(env = process.env) {
  return {
    apiBaseUrl: normalizeString(env.CLOUDFLARE_API_BASE_URL) || 'https://api.cloudflare.com/client/v4',
    apiToken: normalizeString(env.CLOUDFLARE_API_TOKEN),
    accountId: normalizeString(env.CLOUDFLARE_ACCOUNT_ID),
    zoneId: normalizeString(env.CLOUDFLARE_ZONE_ID),
    tunnelId: normalizeString(env.CLOUDFLARE_TUNNEL_ID),
  };
}

export function describeCloudflareConfig(env = process.env) {
  const config = getCloudflareConfig(env);
  const tunnelReady = Boolean(config.apiToken && config.accountId && config.tunnelId);
  return {
    apiTokenConfigured: Boolean(config.apiToken),
    accountIdConfigured: Boolean(config.accountId),
    zoneIdConfigured: Boolean(config.zoneId),
    tunnelIdConfigured: Boolean(config.tunnelId),
    tunnelId: config.tunnelId,
    ready: tunnelReady,
    dnsReady: Boolean(tunnelReady && config.zoneId),
  };
}

export function requireCloudflareConfig(env = process.env, { requireZone = false } = {}) {
  const config = getCloudflareConfig(env);
  const missing = [];
  if (!config.apiToken) missing.push('CLOUDFLARE_API_TOKEN');
  if (!config.accountId) missing.push('CLOUDFLARE_ACCOUNT_ID');
  if (!config.tunnelId) missing.push('CLOUDFLARE_TUNNEL_ID');
  if (requireZone && !config.zoneId) missing.push('CLOUDFLARE_ZONE_ID');
  if (missing.length) {
    throw new Error(`Missing Cloudflare configuration: ${missing.join(', ')}`);
  }
  return config;
}

async function requestCloudflare(config, method, pathname, body = undefined) {
  const response = await fetch(`${config.apiBaseUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok || parsed?.success === false) {
    const message = parsed?.errors?.[0]?.message || text || `Cloudflare API returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed?.result ?? parsed;
}

export async function putTunnelIngress(ingress, { env = process.env } = {}) {
  const config = requireCloudflareConfig(env);
  return requestCloudflare(
    config,
    'PUT',
    `/accounts/${encodeURIComponent(config.accountId)}/cfd_tunnel/${encodeURIComponent(config.tunnelId)}/configurations`,
    { config: { ingress } },
  );
}

export async function upsertDnsRecords(routes, { env = process.env } = {}) {
  const config = requireCloudflareConfig(env, { requireZone: true });
  const enabledHostnames = Array.from(new Set(routes.filter((route) => route.enabled).map((route) => route.hostname)));
  const results = [];
  for (const hostname of enabledHostnames) {
    const query = new URLSearchParams({ type: 'CNAME', name: hostname });
    const existingRecords = await requestCloudflare(
      config,
      'GET',
      `/zones/${encodeURIComponent(config.zoneId)}/dns_records?${query.toString()}`,
    );
    const existing = Array.isArray(existingRecords) ? existingRecords[0] : null;
    const body = {
      type: 'CNAME',
      name: hostname,
      content: `${config.tunnelId}.cfargotunnel.com`,
      ttl: 1,
      proxied: true,
    };
    if (existing?.id) {
      const updated = await requestCloudflare(
        config,
        'PATCH',
        `/zones/${encodeURIComponent(config.zoneId)}/dns_records/${encodeURIComponent(existing.id)}`,
        body,
      );
      results.push({ hostname, action: 'updated', id: updated?.id || existing.id });
    } else {
      const created = await requestCloudflare(
        config,
        'POST',
        `/zones/${encodeURIComponent(config.zoneId)}/dns_records`,
        body,
      );
      results.push({ hostname, action: 'created', id: created?.id || '' });
    }
  }
  return results;
}
