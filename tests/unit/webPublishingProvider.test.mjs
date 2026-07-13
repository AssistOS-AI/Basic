import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildProviderResponse } from '../../web-publishing/runtime/provider.mjs';

test('buildProviderResponse emits schema v1 generated topology values', async () => {
    const response = await buildProviderResponse({
        WEB_PUBLISHING_TLS_EDGE: 'cloudflare',
        WEB_PUBLISHING_BASE_DOMAIN: 'example.com',
        WEB_PUBLISHING_LIVEKIT_MEDIA_IP: '203.0.113.10',
        WEB_PUBLISHING_TURN_EXTERNAL_IP: '198.51.100.20',
        WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN: 'scoped-token',
    }, {
        readConfig: async () => ({ version: 1, mode: 'nginx-cloudflare' }),
    });

    assert.equal(response.version, 1);
    const byName = new Map(response.values.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('ONLYOFFICE_PUBLIC_URL')?.value, 'https://office.example.com');
    assert.equal(byName.get('WEBMEET_PUBLIC_LIVEKIT_URL')?.value, 'wss://meet.example.com');
    assert.equal(byName.get('WEBMEET_LIVEKIT_NODE_IP')?.value, '203.0.113.10');
    assert.equal(byName.get('WEBMEET_TURN_EXTERNAL_IP')?.value, '198.51.100.20');
    assert.equal(byName.get('WEBMEET_TURN_ALLOWED_PEER_IPS')?.value, '203.0.113.10/32');
    for (const name of ['WEBMEET_TLS_HOSTNAME', 'WEBMEET_CERT_EMAIL', 'WEBMEET_LIVEKIT_UPSTREAM']) {
        assert.equal(byName.has(name), false, `${name} must not be emitted`);
    }
    assert.equal(byName.get('WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN')?.sensitive, true);
    assert.equal(byName.get('WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN')?.value, 'scoped-token');
    assert.equal(response.values.some((entry) => entry.name === 'CLOUDFLARED_TUNNEL_TOKEN'), false);
});

test('buildProviderResponse warns without a base domain and never emits generated secrets', async () => {
    const response = await buildProviderResponse({
        ONLYOFFICE_PUBLIC_URL: 'https://stale.example.net',
        WEBMEET_LIVEKIT_API_KEY: 'must-not-copy',
        CLOUDFLARED_TUNNEL_TOKEN: 'legacy-token',
    }, {
        readConfig: async () => ({ version: 1, mode: 'nginx' }),
    });

    assert.equal(response.version, 1);
    assert.ok(response.warnings.some((entry) => /public topology is not configured/i.test(entry)));
    assert.equal(response.values.some((entry) => entry.name === 'WEBMEET_LIVEKIT_API_KEY'), false);
    assert.equal(response.values.some((entry) => entry.name === 'CLOUDFLARED_TUNNEL_TOKEN'), false);
    assert.equal(response.values.some((entry) => entry.value === 'https://stale.example.net'), false);
});

test('buildProviderResponse fails closed instead of replacing invalid public TLS configuration with local values', async () => {
    await assert.rejects(
        () => buildProviderResponse({
            WEB_PUBLISHING_MODE: 'cloudflare-api',
            WEB_PUBLISHING_TLS_EDGE: 'none',
            WEB_PUBLISHING_BASE_DOMAIN: 'example.com',
            WEB_PUBLISHING_LIVEKIT_MEDIA_IP: '203.0.113.10',
            WEB_PUBLISHING_TURN_EXTERNAL_IP: '198.51.100.20',
        }, {
            readConfig: async () => ({ version: 1 }),
        }),
        /explicit trusted TLS edge contract/,
    );
});

test('host-side provider never reads the container-owned secret-state file', async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-provider-data-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
        version: 1,
        mode: 'nginx-cloudflare',
    }));
    // A directory at this exact path fails with EISDIR if a future provider
    // implementation tries to read it, independent of the test runner's uid.
    await fs.mkdir(path.join(dataDir, 'secret-state.json'));

    const response = await buildProviderResponse({
        PLOINKY_PROVIDER_DATA_DIR: dataDir,
        WEB_PUBLISHING_TLS_EDGE: 'cloudflare',
        WEB_PUBLISHING_BASE_DOMAIN: 'example.com',
        WEB_PUBLISHING_LIVEKIT_MEDIA_IP: '203.0.113.10',
        WEB_PUBLISHING_TURN_EXTERNAL_IP: '198.51.100.20',
    });

    assert.equal(response.values.some((entry) => entry.name === 'WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN'), false);
    assert.equal(response.values.some((entry) => entry.value === 'container-only-token'), false);
});

test('local provider output explicitly clears a stale public TURN hostname', async () => {
    const response = await buildProviderResponse({}, {
        readConfig: async () => ({ version: 1, mode: 'nginx' }),
    });
    const byName = new Map(response.values.map((entry) => [entry.name, entry.value]));

    assert.equal(byName.get('WEBMEET_PUBLIC_LIVEKIT_URL'), 'ws://127.0.0.1:8081');
    assert.equal(byName.get('WEBMEET_TURN_HOST'), '127.0.0.1');
    assert.equal(byName.has('WEBMEET_TURN_EXTERNAL_IP'), false);
    assert.equal(byName.has('WEBMEET_TURN_ALLOWED_PEER_IPS'), false);
});
