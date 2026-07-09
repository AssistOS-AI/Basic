import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { normalizeService } from './routes.mjs';

function escapeNginx(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeLocationPath(value) {
    const raw = String(value || '').trim();
    if (!raw) return '/';
    if (!raw.startsWith('/')) return `/${raw}`;
    return raw;
}

export function renderNginxConfig(routes = [], _secrets = {}) {
    const enabledRoutes = routes.filter((route) => route?.enabled !== false);
    const groups = new Map();
    for (const route of enabledRoutes) {
        const hostname = String(route.hostname || '').trim();
        if (!hostname) throw new Error('nginx route hostname is required.');
        const service = normalizeService(route.service);
        const normalized = {
            hostname,
            path: normalizeLocationPath(route.path),
            service,
        };
        if (!groups.has(hostname)) groups.set(hostname, []);
        groups.get(hostname).push(normalized);
    }

    const serverBlocks = [];
    for (const [hostname, groupRoutes] of groups) {
        groupRoutes.sort((left, right) => {
            if (left.path === '/' && right.path !== '/') return 1;
            if (left.path !== '/' && right.path === '/') return -1;
            return right.path.length - left.path.length;
        });
        const locations = groupRoutes.map((route) => `    location ${escapeNginx(route.path)} {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_pass ${route.service};
    }`).join('\n\n');
        serverBlocks.push(`server {
    listen 8081;
    server_name ${escapeNginx(hostname)};

${locations}
}`);
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

${serverBlocks.join('\n\n')}
}
`;
}

export async function writeAndValidateNginxConfig(routes, {
    configFile = process.env.WEB_PUBLISHING_NGINX_CONFIG_FILE || '/tmp/web-publishing-nginx.conf',
    runCommand = spawnSync,
} = {}) {
    const rendered = renderNginxConfig(routes);
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
