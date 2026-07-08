import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    putTunnelIngress,
    upsertDnsRecords,
} from '../../cloudflared/lib/cloudflare-api.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

test('putTunnelIngress does not require zone configuration when DNS creation is skipped', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ success: true, result: { ok: true } });
            },
        };
    };

    try {
        const result = await putTunnelIngress([{ service: 'http_status:404' }], {
            env: {
                CLOUDFLARE_API_TOKEN: 'test-token',
                CLOUDFLARE_ACCOUNT_ID: 'account-id',
                CLOUDFLARE_TUNNEL_ID: 'tunnel-id',
            },
        });

        assert.deepEqual(result, { ok: true });
        assert.equal(calls.length, 1);
        assert.match(String(calls[0].url), /\/accounts\/account-id\/cfd_tunnel\/tunnel-id\/configurations$/);
        assert.doesNotMatch(String(calls[0].url), /\/zones\//);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('upsertDnsRecords requires zone configuration for DNS mutations', async () => {
    await assert.rejects(
        () => upsertDnsRecords([
            {
                enabled: true,
                hostname: 'app.example.com',
            },
        ], {
            env: {
                CLOUDFLARE_API_TOKEN: 'test-token',
                CLOUDFLARE_ACCOUNT_ID: 'account-id',
                CLOUDFLARE_TUNNEL_ID: 'tunnel-id',
            },
        }),
        /CLOUDFLARE_ZONE_ID/,
    );
});

test('cloudflared_routes_apply preflights DNS config before mutating tunnel ingress', async () => {
    const requests = [];
    const server = http.createServer((request, response) => {
        requests.push({ method: request.method, url: request.url });
        request.resume();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: true, result: { ok: true } }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();
    const apiBaseUrl = `http://127.0.0.1:${address.port}/client/v4`;
    const child = spawn(process.execPath, ['tools/cloudflared-tool.mjs'], {
        cwd: path.join(repoRoot, 'cloudflared'),
        env: {
            ...process.env,
            CLOUDFLARE_API_BASE_URL: apiBaseUrl,
            CLOUDFLARE_API_TOKEN: 'test-token',
            CLOUDFLARE_ACCOUNT_ID: 'account-id',
            CLOUDFLARE_TUNNEL_ID: 'tunnel-id',
            CLOUDFLARED_STATE_FILE: path.join(os.tmpdir(), `cloudflared-routes-${process.pid}.json`),
            TOOL_NAME: 'cloudflared_routes_apply',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
        stderr += chunk;
    });
    child.stdin.end(JSON.stringify({
        tool: 'cloudflared_routes_apply',
        input: {
            createDnsRecords: true,
            routes: [
                {
                    enabled: true,
                    hostname: 'app.example.com',
                    originId: 'router',
                },
            ],
        },
    }));

    const [exitCode] = await once(child, 'exit');
    server.close();

    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /CLOUDFLARE_ZONE_ID/);
    assert.deepEqual(requests, []);
});

test('cloudflared_routes_apply checks DNS access before mutating tunnel ingress', async () => {
    const requests = [];
    const server = http.createServer((request, response) => {
        requests.push({ method: request.method, url: request.url });
        request.resume();
        if (request.url.startsWith('/client/v4/zones/zone-id/dns_records')) {
            response.writeHead(403, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                success: false,
                errors: [{ code: 10000, message: 'Authentication error' }],
            }));
            return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: true, result: { ok: true } }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();
    const apiBaseUrl = `http://127.0.0.1:${address.port}/client/v4`;
    const child = spawn(process.execPath, ['tools/cloudflared-tool.mjs'], {
        cwd: path.join(repoRoot, 'cloudflared'),
        env: {
            ...process.env,
            CLOUDFLARE_API_BASE_URL: apiBaseUrl,
            CLOUDFLARE_API_TOKEN: 'test-token',
            CLOUDFLARE_ACCOUNT_ID: 'account-id',
            CLOUDFLARE_ZONE_ID: 'zone-id',
            CLOUDFLARE_TUNNEL_ID: 'tunnel-id',
            CLOUDFLARED_STATE_FILE: path.join(os.tmpdir(), `cloudflared-routes-dns-auth-${process.pid}.json`),
            TOOL_NAME: 'cloudflared_routes_apply',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
        stderr += chunk;
    });
    child.stdin.end(JSON.stringify({
        tool: 'cloudflared_routes_apply',
        input: {
            createDnsRecords: true,
            routes: [
                {
                    enabled: true,
                    hostname: 'app.example.com',
                    originId: 'router',
                },
            ],
        },
    }));

    const [exitCode] = await once(child, 'exit');
    server.close();

    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Authentication error/);
    assert.equal(requests.some((request) => request.url.includes('/accounts/account-id/cfd_tunnel/tunnel-id/configurations')), false);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/zones\/zone-id\/dns_records/);
});
