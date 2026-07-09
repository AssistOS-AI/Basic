import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildCloudflaredIngress,
    buildProviderValues,
    normalizePublishingConfig,
    normalizeRouteModel,
} from '../../web-publishing/lib/routes.mjs';

test('normalizePublishingConfig creates default Explorer public topology from base domain', () => {
    const config = normalizePublishingConfig({
        mode: 'nginx-cloudflare',
        baseDomain: 'Example.COM',
    });

    assert.equal(config.baseDomain, 'example.com');
    assert.equal(config.exposures.length, 3);
    assert.deepEqual(config.exposures.map((entry) => entry.hostname), [
        'explorer.example.com',
        'office.example.com',
        'meet.example.com',
    ]);
});

test('normalizeRouteModel rejects routes outside base domain and raw AgentServer ports', () => {
    assert.throws(
        () => normalizeRouteModel({
            baseDomain: 'example.com',
            exposures: [{ hostname: 'bad.test', originId: 'router' }],
        }),
        /must be under example\.com/,
    );

    assert.throws(
        () => normalizeRouteModel({
            exposures: [{
                hostname: 'agent.example.com',
                originId: 'router',
                service: 'http://host.containers.internal:7000',
            }],
        }),
        /AgentServer\/MCP port 7000/,
    );
});

test('buildCloudflaredIngress orders path routes before host catch-all and appends 404', () => {
    const { routes } = normalizeRouteModel({
        baseDomain: 'example.com',
        exposures: [
            { hostname: 'app.example.com', originId: 'router' },
            { hostname: 'app.example.com', path: '/office', originId: 'onlyoffice' },
        ],
    });

    assert.deepEqual(buildCloudflaredIngress(routes), [
        {
            hostname: 'app.example.com',
            path: '/office',
            service: 'http://host.containers.internal:8082',
        },
        {
            hostname: 'app.example.com',
            service: 'http://host.containers.internal:8080',
        },
        { service: 'http_status:404' },
    ]);
});

test('buildProviderValues ignores stale public env and excludes generated secrets', () => {
    const config = normalizePublishingConfig({
        baseDomain: 'example.com',
        certEmail: 'ops@example.com',
    });
    const values = buildProviderValues(config, {
        ONLYOFFICE_PUBLIC_URL: 'https://stale.example.net',
        WEBMEET_LIVEKIT_API_SECRET: 'must-not-copy',
        CLOUDFLARED_TUNNEL_TOKEN: 'legacy-token',
        WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN: 'scoped-token',
    });

    const byName = new Map(values.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('ONLYOFFICE_PUBLIC_URL')?.value, 'https://office.example.com');
    assert.equal(byName.get('WEBMEET_PUBLIC_LIVEKIT_URL')?.value, 'wss://meet.example.com');
    assert.equal(byName.get('WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN')?.sensitive, true);
    assert.equal(values.some((entry) => entry.name === 'CLOUDFLARED_TUNNEL_TOKEN'), false);
    assert.equal(values.some((entry) => entry.name === 'WEBMEET_LIVEKIT_API_SECRET'), false);
});
