import test from 'node:test';
import assert from 'node:assert/strict';

import {
    putTunnelIngress,
    upsertDnsRecords,
} from '../../cloudflared/lib/cloudflare-api.mjs';

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
