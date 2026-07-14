import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    CLOUDFLARE_NGINX_LISTEN_PORT,
    EXTERNAL_NGINX_LISTEN_PORT,
    normalizeExternalProxyCidrs,
    normalizeHostname,
    normalizePathPattern,
    normalizeService,
} from './routes.mjs';

// LiveKit signaling is identified by originId (not by hostname or port number) so custom
// exposures still get the hardened /rtc treatment as long as they declare this origin.
const LIVEKIT_SIGNALING_ORIGIN_ID = 'livekit-http';
// Ploinky derives this DNS name from the canonical LiveKit agent id and registers it on the
// private webmeet-signaling attachment shared by LiveKit and Web Publishing.
const LIVEKIT_SIGNALING_UPSTREAM_HOST = 'livekitserveragent';
const RTC_REQ_LIMIT_ZONE = 'web_publishing_rtc_req';
const RTC_CONN_LIMIT_ZONE = 'web_publishing_rtc_conn';

function escapeNginx(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeLocationPath(value) {
    return normalizePathPattern(value) || '/';
}

function normalizeDnsResolvers(resolvers = []) {
    if (!Array.isArray(resolvers)) throw new Error('Runtime DNS resolvers must be an array.');
    const normalized = [];
    for (const resolver of resolvers) {
        const value = String(resolver || '').trim();
        const version = isIP(value);
        if (!version) throw new Error(`Invalid runtime DNS resolver: ${value || '(empty)'}`);
        const rendered = version === 6 ? `[${value}]` : value;
        if (!normalized.includes(rendered)) normalized.push(rendered);
    }
    return normalized;
}

export function parseRuntimeDnsResolvers(resolvConf) {
    const resolvers = [];
    for (const line of String(resolvConf || '').split(/\r?\n/)) {
        const match = line.match(/^\s*nameserver\s+(\S+)\s*(?:#.*)?$/);
        if (!match || !isIP(match[1])) continue;
        if (!resolvers.includes(match[1])) resolvers.push(match[1]);
    }
    if (!resolvers.length) {
        throw new Error('No valid runtime DNS resolver was found in /etc/resolv.conf.');
    }
    return resolvers;
}

export async function readRuntimeDnsResolvers({
    resolvConfFile = '/etc/resolv.conf',
    readFile = fs.readFile,
} = {}) {
    return parseRuntimeDnsResolvers(await readFile(resolvConfFile, 'utf8'));
}

function renderProxyLocation(locationPath, service) {
    const upstream = new URL(service);
    const runtimeDns = isIP(upstream.hostname) === 0;
    const proxyTarget = runtimeDns
        ? `${upstream.protocol}//$web_publishing_upstream_host:${upstream.port}`
        : service;
    return `    location ${escapeNginx(locationPath)} {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
${runtimeDns ? `        set $web_publishing_upstream_host ${upstream.hostname};\n` : ''}        proxy_pass ${proxyTarget};
    }`;
}

// LiveKit signaling is scoped to the /rtc boundary (never the whole hostname): the base
// path and its slash-delimited descendants are rate-limited, never access-logged (join
// tokens travel as query parameters), and proxied straight to the private LiveKit
// upstream. /twirp (LiveKit's internal Twirp RPC surface) and /webhook must never be
// reachable through the public signaling hostname.
function renderLiveKitSignalingLocations({
    clientIpMode = 'direct',
    externalProxyCidrs = [],
} = {}) {
    const forwardedProto = clientIpMode === 'direct' ? '$scheme' : 'https';
    const trustedClientIp = clientIpMode === 'cloudflare'
        ? `        if ($http_cf_connecting_ip = "") { return 400; }
        set_real_ip_from 127.0.0.1;
        real_ip_header CF-Connecting-IP;
        real_ip_recursive off;\n`
        : clientIpMode === 'external'
            ? `        if ($web_publishing_external_proxy_trusted = 0) { return 403; }
        if ($http_x_real_ip = "") { return 400; }
${externalProxyCidrs.map((cidr) => `        set_real_ip_from ${cidr};`).join('\n')}
        real_ip_header X-Real-IP;
        real_ip_recursive off;\n`
            : '';
    const renderSignalingLocation = (selector) => `    location ${selector} {
        access_log off;
        error_log /dev/null crit;
${trustedClientIp}        limit_req zone=${RTC_REQ_LIMIT_ZONE} burst=20;
        limit_conn ${RTC_CONN_LIMIT_ZONE} 50;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto ${forwardedProto};
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        set $livekit_signaling_host ${LIVEKIT_SIGNALING_UPSTREAM_HOST};
        proxy_pass http://$livekit_signaling_host:7880;
    }`;
    const signalingLocations = [
        renderSignalingLocation('= /rtc'),
        renderSignalingLocation('^~ /rtc/'),
    ].join('\n\n');

    return `${signalingLocations}

    location = /twirp {
        access_log off;
        return 404;
    }

    location = /webhook {
        access_log off;
        return 404;
    }

    location / {
        access_log off;
        return 404;
    }`;
}

function normalizeTlsEdge(value) {
    const tlsEdge = String(value || 'none').trim().toLowerCase();
    if (!['none', 'cloudflare', 'external'].includes(tlsEdge)) {
        throw new Error(`Unsupported nginx TLS edge: ${value}`);
    }
    return tlsEdge;
}

function renderDeniedLiveKitLocations() {
    return `    location / {
        access_log off;
        return 404;
    }`;
}

export function renderNginxConfig(routes = [], {
    dnsResolvers = [],
    tlsEdge = 'none',
    externalProxyCidrs = [],
} = {}) {
    const normalizedTlsEdge = normalizeTlsEdge(tlsEdge);
    const normalizedExternalProxyCidrs = normalizeExternalProxyCidrs(externalProxyCidrs);
    if (normalizedTlsEdge === 'external' && !normalizedExternalProxyCidrs.length) {
        throw new Error('At least one exact external proxy peer CIDR is required for the external TLS edge.');
    }
    const enabledRoutes = routes.filter((route) => route?.enabled !== false);
    const normalizedEnabledRoutes = [];
    const groups = new Map();
    for (const route of enabledRoutes) {
        const hostname = normalizeHostname(route.hostname);
        if (!hostname) throw new Error('nginx route hostname is required.');
        const service = normalizeService(route.service);
        const normalized = {
            hostname,
            path: normalizeLocationPath(route.path),
            service,
            originId: String(route.originId || '').trim(),
        };
        normalizedEnabledRoutes.push(normalized);
        if (!groups.has(hostname)) groups.set(hostname, []);
        groups.get(hostname).push(normalized);
    }

    // Fail-closed default: a request whose Host header does not match any configured
    // hostname below must 404, not silently fall through to nginx's first server block.
    const hasRuntimeDnsRoute = normalizedEnabledRoutes.some((route) => (
        route.originId === LIVEKIT_SIGNALING_ORIGIN_ID
        || isIP(new URL(route.service).hostname) === 0
    ));
    const normalizedResolvers = normalizeDnsResolvers(dnsResolvers);
    if (hasRuntimeDnsRoute && !normalizedResolvers.length) {
        throw new Error('At least one runtime DNS resolver is required for private service aliases.');
    }
    const serverBlocks = [`server {
    listen 8081 default_server;
    server_name _;
    access_log off;
    return 404;
}`];
    if (normalizedTlsEdge === 'cloudflare') {
        serverBlocks.push(`server {
    listen 127.0.0.1:${CLOUDFLARE_NGINX_LISTEN_PORT} default_server;
    server_name _;
    access_log off;
    return 404;
}`);
    }
    if (normalizedTlsEdge === 'external') {
        serverBlocks.push(`server {
    listen ${EXTERNAL_NGINX_LISTEN_PORT} default_server;
    server_name _;
    access_log off;
    return 404;
}`);
    }
    for (const [hostname, groupRoutes] of groups) {
        groupRoutes.sort((left, right) => {
            if (left.path === '/' && right.path !== '/') return 1;
            if (left.path !== '/' && right.path === '/') return -1;
            return right.path.length - left.path.length;
        });
        const renderLocations = ({ clientIpMode = 'direct', allowLiveKit = true } = {}) => {
            let renderedLiveKitLocations = false;
            return groupRoutes.map((route) => {
                if (route.originId === LIVEKIT_SIGNALING_ORIGIN_ID) {
                    if (renderedLiveKitLocations) return '';
                    renderedLiveKitLocations = true;
                    return allowLiveKit
                        ? renderLiveKitSignalingLocations({
                            clientIpMode,
                            externalProxyCidrs: normalizedExternalProxyCidrs,
                        })
                        : renderDeniedLiveKitLocations();
                }
                return renderProxyLocation(route.path, route.service);
            }).filter(Boolean).join('\n\n');
        };
        const hasLiveKitHostname = groupRoutes.some((route) => route.originId === LIVEKIT_SIGNALING_ORIGIN_ID);
        if (hasLiveKitHostname && groupRoutes.some((route) => route.originId !== LIVEKIT_SIGNALING_ORIGIN_ID)) {
            throw new Error(`LiveKit signaling hostname ${hostname} cannot be shared with another HTTP origin.`);
        }
        const locations = renderLocations({ allowLiveKit: normalizedTlsEdge === 'none' });
        serverBlocks.push(`server {
    listen 8081;
    server_name ${escapeNginx(hostname)};

${locations}
}`);
        if (hasLiveKitHostname && normalizedTlsEdge === 'cloudflare') {
            serverBlocks.push(`server {
    listen 127.0.0.1:${CLOUDFLARE_NGINX_LISTEN_PORT};
    server_name ${escapeNginx(hostname)};

${renderLocations({ clientIpMode: 'cloudflare' })}
}`);
        }
        if (hasLiveKitHostname && normalizedTlsEdge === 'external') {
            serverBlocks.push(`server {
    listen ${EXTERNAL_NGINX_LISTEN_PORT};
    server_name ${escapeNginx(hostname)};

${renderLocations({ clientIpMode: 'external' })}
}`);
        }
    }

    return `worker_processes auto;
pid /tmp/web-publishing-nginx.pid;
events {
    worker_connections 1024;
}
http {
    server_tokens off;
    client_body_temp_path /tmp/web-publishing-client-body;
    proxy_temp_path /tmp/web-publishing-proxy;
    fastcgi_temp_path /tmp/web-publishing-fastcgi;
    uwsgi_temp_path /tmp/web-publishing-uwsgi;
    scgi_temp_path /tmp/web-publishing-scgi;
    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }
    limit_req_zone $binary_remote_addr zone=${RTC_REQ_LIMIT_ZONE}:10m rate=5r/s;
    limit_conn_zone $binary_remote_addr zone=${RTC_CONN_LIMIT_ZONE}:10m;
    ${normalizedTlsEdge === 'external' ? `geo $realip_remote_addr $web_publishing_external_proxy_trusted {
        default 0;
${normalizedExternalProxyCidrs.map((cidr) => `        ${cidr} 1;`).join('\n')}
    }` : ''}
    ${hasRuntimeDnsRoute ? `resolver ${normalizedResolvers.join(' ')} valid=10s ipv6=off;\n    resolver_timeout 2s;` : ''}

${serverBlocks.join('\n\n')}
}
`;
}

export async function writeAndValidateNginxConfig(routes, {
    configFile = process.env.WEB_PUBLISHING_NGINX_CONFIG_FILE || '/tmp/web-publishing-nginx.conf',
    runCommand = spawnSync,
    resolvConfFile = '/etc/resolv.conf',
    readFile = fs.readFile,
    tlsEdge = 'none',
    externalProxyCidrs = [],
} = {}) {
    const resolvers = await readRuntimeDnsResolvers({ resolvConfFile, readFile });
    const rendered = renderNginxConfig(routes, {
        dnsResolvers: resolvers,
        tlsEdge,
        externalProxyCidrs,
    });
    const tempPath = `${configFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(tempPath, rendered, 'utf8');
    const result = runCommand('nginx', ['-t', '-c', tempPath], {
        encoding: 'utf8',
    });
    if (result.error && result.error.code !== 'ENOENT') {
        throw result.error;
    }
    if (!result.error && result.status !== 0) {
        throw new Error(`nginx config validation failed: ${result.stderr || result.stdout || result.status}`);
    }
    await fs.rename(tempPath, configFile);
    return { configFile, rendered };
}
