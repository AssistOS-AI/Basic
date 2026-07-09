import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProviderResponse } from '../../web-publishing/runtime/provider.mjs';

test('buildProviderResponse emits schema v1 generated topology values', async () => {
    const response = await buildProviderResponse({
        WEB_PUBLISHING_BASE_DOMAIN: 'example.com',
        WEB_PUBLISHING_CERT_EMAIL: 'ops@example.com',
    }, {
        readConfig: async () => ({ version: 1, mode: 'nginx-cloudflare' }),
        readSecretState: async () => ({ tunnelToken: 'scoped-token' }),
    });

    assert.equal(response.version, 1);
    const byName = new Map(response.values.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('ONLYOFFICE_PUBLIC_URL')?.value, 'https://office.example.com');
    assert.equal(byName.get('WEBMEET_PUBLIC_LIVEKIT_URL')?.value, 'wss://meet.example.com');
    assert.equal(byName.get('WEBMEET_CERT_EMAIL')?.value, 'ops@example.com');
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
    assert.ok(response.warnings.some((entry) => /base domain/i.test(entry)));
    assert.equal(response.values.some((entry) => entry.name === 'WEBMEET_LIVEKIT_API_KEY'), false);
    assert.equal(response.values.some((entry) => entry.name === 'CLOUDFLARED_TUNNEL_TOKEN'), false);
    assert.equal(response.values.some((entry) => entry.value === 'https://stale.example.net'), false);
});
