import { isTurnHostname, normalizeIpv4 } from './routes.mjs';

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

// Defense in depth: buildCloudflaredIngress already refuses a turn.* hostname in the
// ingress plan, but the DNS-mutation entry points are reachable independently of that
// plan, so they need their own guard against ever creating a Cloudflare-proxied record
// for TURN — that would defeat the point of TURN being a DNS-only/L4 endpoint.
function requireNoTurnHostnames(routes) {
    const turnRoute = routes.find((route) => route?.enabled && isTurnHostname(route.hostname));
    if (turnRoute) {
        throw new Error(`TURN hostname ${turnRoute.hostname} must not receive a Cloudflare-proxied DNS record; use a DNS-only record instead.`);
    }
}

function dnsRecordsForRoutes(routes, turnDnsRecord = null) {
    requireNoTurnHostnames(routes);
    const records = [];
    for (const hostname of new Set(routes.filter((route) => route.enabled).map((route) => route.hostname))) {
        records.push({
            type: 'CNAME',
            name: hostname,
            content: '',
            ttl: 1,
            proxied: true,
        });
    }
    if (turnDnsRecord) {
        let turnAddress = '';
        try {
            turnAddress = normalizeIpv4(turnDnsRecord.content, 'TURN DNS record address');
        } catch {
            turnAddress = '';
        }
        if (
            turnDnsRecord.type !== 'A'
            || !isTurnHostname(turnDnsRecord.name)
            || turnDnsRecord.proxied !== false
            || !turnAddress
        ) {
            throw new Error('TURN DNS record must be an unproxied A record with a bare IPv4 address on a turn.* hostname.');
        }
        if (records.some((record) => record.name === turnDnsRecord.name)) {
            throw new Error(`TURN DNS hostname ${turnDnsRecord.name} conflicts with an HTTP tunnel hostname.`);
        }
        records.push({ ...turnDnsRecord });
    }
    return records;
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

export async function preflightDnsRecordAccess(routes, {
    env = process.env,
    turnDnsRecord = null,
} = {}) {
    const config = requireCloudflareConfig(env, { requireZone: true });
    const records = dnsRecordsForRoutes(routes, turnDnsRecord);
    for (const record of records) {
        const query = new URLSearchParams({ name: record.name });
        await requestCloudflare(config, 'GET', `/zones/${encodeURIComponent(config.zoneId)}/dns_records?${query.toString()}`);
    }
    return { ok: true, hostnames: records.map((record) => record.name) };
}

export async function upsertDnsRecords(routes, {
    env = process.env,
    turnDnsRecord = null,
} = {}) {
    const records = dnsRecordsForRoutes(routes, turnDnsRecord);
    const config = requireCloudflareConfig(env, {
        requireTunnel: records.some((record) => record.type === 'CNAME'),
        requireZone: true,
    });
    const results = [];
    for (const record of records) {
        const query = new URLSearchParams({ name: record.name });
        const existingRecords = await requestCloudflare(config, 'GET', `/zones/${encodeURIComponent(config.zoneId)}/dns_records?${query.toString()}`);
        const exactRecords = Array.isArray(existingRecords)
            ? existingRecords.filter((entry) => String(entry?.name || '').toLowerCase() === record.name.toLowerCase())
            : [];
        const existing = exactRecords.find((entry) => entry.type === record.type) || exactRecords[0] || null;
        const body = {
            ...record,
            content: record.type === 'CNAME' ? `${config.tunnelId}.cfargotunnel.com` : record.content,
        };
        if (existing?.id) {
            const updated = await requestCloudflare(config, 'PATCH', `/zones/${encodeURIComponent(config.zoneId)}/dns_records/${encodeURIComponent(existing.id)}`, body);
            results.push({ hostname: record.name, type: record.type, proxied: record.proxied, action: 'updated', id: updated?.id || existing.id });
        } else {
            const created = await requestCloudflare(config, 'POST', `/zones/${encodeURIComponent(config.zoneId)}/dns_records`, body);
            results.push({ hostname: record.name, type: record.type, proxied: record.proxied, action: 'created', id: created?.id || '' });
        }
    }
    return results;
}

export function planTunnelChanges({
    tunnelId = '',
    tunnelName = '',
    ingress = [],
    createDnsRecords = false,
    turnDnsRecord = null,
} = {}, { env = process.env } = {}) {
    const config = getCloudflareConfig(env);
    return {
        apiTokenConfigured: Boolean(config.apiToken),
        accountIdConfigured: Boolean(config.accountId),
        zoneIdConfigured: Boolean(config.zoneId),
        tunnelId: tunnelId || config.tunnelId,
        tunnelName: tunnelName || config.tunnelName,
        ingress,
        createDnsRecords: createDnsRecords === true,
        dnsHostnames: createDnsRecords
            ? [
                ...ingress.filter((entry) => entry.hostname).map((entry) => entry.hostname),
                ...(turnDnsRecord ? [turnDnsRecord.name] : []),
            ]
            : [],
        turnDnsRecord: createDnsRecords && turnDnsRecord ? { ...turnDnsRecord } : null,
    };
}
