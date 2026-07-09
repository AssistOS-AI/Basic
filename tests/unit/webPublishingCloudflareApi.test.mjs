import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    createTunnel,
    planTunnelChanges,
    putTunnelIngress,
    upsertDnsRecords,
} from '../../web-publishing/lib/cloudflare-api.mjs';
import { tunnelApply } from '../../web-publishing/tools/web-publishing-tool.mjs';

test('createTunnel uses Cloudflare remote tunnel API shape and returns token to internal caller', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({
                    success: true,
                    result: {
                        id: 'tunnel-id',
                        name: 'workspace',
                        token: 'created-token',
                    },
                });
            },
        };
    };

    try {
        const result = await createTunnel('workspace', {
            env: {
                WEB_PUBLISHING_CLOUDFLARE_API_TOKEN: 'api-token',
                WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID: 'account-id',
            },
        });

        assert.equal(calls.length, 1);
        assert.match(String(calls[0].url), /\/accounts\/account-id\/cfd_tunnel$/);
        assert.deepEqual(JSON.parse(calls[0].options.body), {
            name: 'workspace',
            config_src: 'cloudflare',
        });
        assert.deepEqual(result, {
            tunnelId: 'tunnel-id',
            tunnelName: 'workspace',
            tokenSet: true,
            token: 'created-token',
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('putTunnelIngress does not require DNS zone when DNS mutation is skipped', async () => {
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
        await putTunnelIngress([{ service: 'http_status:404' }], {
            env: {
                WEB_PUBLISHING_CLOUDFLARE_API_TOKEN: 'api-token',
                WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID: 'account-id',
                WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID: 'tunnel-id',
            },
        });

        assert.equal(calls.length, 1);
        assert.match(String(calls[0].url), /\/accounts\/account-id\/cfd_tunnel\/tunnel-id\/configurations$/);
        assert.doesNotMatch(String(calls[0].url), /\/zones\//);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DNS creation requires explicit opt-in and zone configuration', async () => {
    await assert.rejects(
        () => upsertDnsRecords([
            { enabled: true, hostname: 'app.example.com' },
        ], {
            env: {
                WEB_PUBLISHING_CLOUDFLARE_API_TOKEN: 'api-token',
                WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID: 'account-id',
                WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID: 'tunnel-id',
            },
        }),
        /WEB_PUBLISHING_CLOUDFLARE_ZONE_ID/,
    );
});

test('planTunnelChanges is redacted and marks DNS as opt-in', () => {
    const plan = planTunnelChanges({
        tunnelName: 'workspace',
        ingress: [{ hostname: 'app.example.com', service: 'http://origin' }],
        createDnsRecords: false,
    }, {
        env: {
            WEB_PUBLISHING_CLOUDFLARE_API_TOKEN: 'api-token',
            WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID: 'account-id',
            WEB_PUBLISHING_CLOUDFLARE_ZONE_ID: 'zone-id',
        },
    });

    assert.equal(plan.apiTokenConfigured, true);
    assert.equal(plan.createDnsRecords, false);
    assert.equal(JSON.stringify(plan).includes('api-token'), false);
});

test('tunnelApply persists API-created tunnel token to private secret state and redacts response', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-cloudflare-'));
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (String(url).endsWith('/cfd_tunnel')) {
            return {
                ok: true,
                status: 200,
                async text() {
                    return JSON.stringify({
                        success: true,
                        result: {
                            id: 'created-tunnel-id',
                            name: 'created-tunnel',
                            token: 'created-secret-token',
                        },
                    });
                },
            };
        }
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ success: true, result: { applied: true } });
            },
        };
    };

    try {
        process.env.WEB_PUBLISHING_CONFIG_FILE = path.join(tempDir, 'config.json');
        process.env.WEB_PUBLISHING_STATUS_FILE = path.join(tempDir, 'status.json');
        process.env.WEB_PUBLISHING_SECRET_STATE_FILE = path.join(tempDir, 'secret-state.json');
        process.env.WEB_PUBLISHING_CLOUDFLARE_API_TOKEN = 'api-token';
        process.env.WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID = 'account-id';
        delete process.env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID;

        const result = await tunnelApply({
            config: {
                mode: 'cloudflare-api',
                baseDomain: 'example.com',
                tunnel: { tunnelName: 'created-tunnel' },
            },
            createDnsRecords: false,
        });

        assert.equal(result.ok, true);
        assert.equal(result.tunnel.tokenSet, true);
        assert.equal(JSON.stringify(result).includes('created-secret-token'), false);
        assert.equal(calls.length, 2);
        assert.match(String(calls[1].url), /\/accounts\/account-id\/cfd_tunnel\/created-tunnel-id\/configurations$/);

        const config = JSON.parse(await fs.readFile(path.join(tempDir, 'config.json'), 'utf8'));
        assert.equal(config.tunnel.tunnelId, 'created-tunnel-id');
        assert.equal(config.tunnel.tokenSet, true);
        assert.equal(JSON.stringify(config).includes('created-secret-token'), false);

        const secretStateText = await fs.readFile(path.join(tempDir, 'secret-state.json'), 'utf8');
        assert.match(secretStateText, /created-secret-token/);
        const stat = await fs.stat(path.join(tempDir, 'secret-state.json'));
        assert.equal(stat.mode & 0o077, 0);
    } finally {
        globalThis.fetch = originalFetch;
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
