function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function getCloudflareConfig(env = process.env) {
    return {
        apiBaseUrl: normalizeString(env.WEB_PUBLISHING_CLOUDFLARE_API_BASE_URL) || 'https://api.cloudflare.com/client/v4',
        apiToken: normalizeString(env.WEB_PUBLISHING_CLOUDFLARE_API_TOKEN),
        accountId: normalizeString(env.WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID),
        zoneId: normalizeString(env.WEB_PUBLISHING_CLOUDFLARE_ZONE_ID),
        tunnelId: normalizeString(env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID),
        tunnelName: normalizeString(env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_NAME),
    };
}

export function describeCloudflareConfig(env = process.env) {
    const config = getCloudflareConfig(env);
    return {
        apiTokenConfigured: Boolean(config.apiToken),
        accountIdConfigured: Boolean(config.accountId),
        zoneIdConfigured: Boolean(config.zoneId),
        tunnelIdConfigured: Boolean(config.tunnelId),
        tunnelName: config.tunnelName,
        ready: Boolean(config.apiToken && config.accountId),
        dnsReady: Boolean(config.apiToken && config.zoneId),
    };
}

function requireCloudflareConfig(env = process.env, { requireTunnel = false, requireZone = false } = {}) {
    const config = getCloudflareConfig(env);
    const missing = [];
    if (!config.apiToken) missing.push('WEB_PUBLISHING_CLOUDFLARE_API_TOKEN');
    if (!config.accountId) missing.push('WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID');
    if (requireTunnel && !config.tunnelId) missing.push('WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID');
    if (requireZone && !config.zoneId) missing.push('WEB_PUBLISHING_CLOUDFLARE_ZONE_ID');
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
        const message = parsed?.errors?.[0]?.message || `Cloudflare API returned HTTP ${response.status}`;
        throw new Error(message);
    }
    return parsed?.result ?? parsed;
}

export async function createTunnel(name, { env = process.env } = {}) {
    const config = requireCloudflareConfig(env);
    const tunnelName = normalizeString(name) || config.tunnelName || 'ploinky-web-publishing';
    const result = await requestCloudflare(
        config,
        'POST',
        `/accounts/${encodeURIComponent(config.accountId)}/cfd_tunnel`,
        { name: tunnelName, config_src: 'cloudflare' },
    );
    return {
        tunnelId: result?.id || '',
        tunnelName: result?.name || tunnelName,
        tokenSet: Boolean(result?.token),
        token: result?.token || '',
    };
}

export async function putTunnelIngress(ingress, { env = process.env } = {}) {
    const config = requireCloudflareConfig(env, { requireTunnel: true });
    return requestCloudflare(
        config,
        'PUT',
        `/accounts/${encodeURIComponent(config.accountId)}/cfd_tunnel/${encodeURIComponent(config.tunnelId)}/configurations`,
        { config: { ingress } },
    );
}

export async function preflightDnsRecordAccess(routes, { env = process.env } = {}) {
    const config = requireCloudflareConfig(env, { requireZone: true });
    const hostnames = Array.from(new Set(routes.filter((route) => route.enabled).map((route) => route.hostname)));
    for (const hostname of hostnames) {
        const query = new URLSearchParams({ type: 'CNAME', name: hostname });
        await requestCloudflare(config, 'GET', `/zones/${encodeURIComponent(config.zoneId)}/dns_records?${query.toString()}`);
    }
    return { ok: true, hostnames };
}

export async function upsertDnsRecords(routes, { env = process.env } = {}) {
    const config = requireCloudflareConfig(env, { requireTunnel: true, requireZone: true });
    const hostnames = Array.from(new Set(routes.filter((route) => route.enabled).map((route) => route.hostname)));
    const results = [];
    for (const hostname of hostnames) {
        const query = new URLSearchParams({ type: 'CNAME', name: hostname });
        const existingRecords = await requestCloudflare(config, 'GET', `/zones/${encodeURIComponent(config.zoneId)}/dns_records?${query.toString()}`);
        const existing = Array.isArray(existingRecords) ? existingRecords[0] : null;
        const body = {
            type: 'CNAME',
            name: hostname,
            content: `${config.tunnelId}.cfargotunnel.com`,
            ttl: 1,
            proxied: true,
        };
        if (existing?.id) {
            const updated = await requestCloudflare(config, 'PATCH', `/zones/${encodeURIComponent(config.zoneId)}/dns_records/${encodeURIComponent(existing.id)}`, body);
            results.push({ hostname, action: 'updated', id: updated?.id || existing.id });
        } else {
            const created = await requestCloudflare(config, 'POST', `/zones/${encodeURIComponent(config.zoneId)}/dns_records`, body);
            results.push({ hostname, action: 'created', id: created?.id || '' });
        }
    }
    return results;
}

export function planTunnelChanges({ tunnelName = '', ingress = [], createDnsRecords = false } = {}, { env = process.env } = {}) {
    const config = getCloudflareConfig(env);
    return {
        apiTokenConfigured: Boolean(config.apiToken),
        accountIdConfigured: Boolean(config.accountId),
        zoneIdConfigured: Boolean(config.zoneId),
        tunnelId: config.tunnelId,
        tunnelName: tunnelName || config.tunnelName,
        ingress,
        createDnsRecords: createDnsRecords === true,
        dnsHostnames: createDnsRecords
            ? ingress.filter((entry) => entry.hostname).map((entry) => entry.hostname)
            : [],
    };
}
