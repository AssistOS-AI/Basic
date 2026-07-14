import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildCloudflaredIngress,
    buildProviderValues,
    buildTurnDnsRecord,
    normalizeExternalProxyCidrs,
    normalizePublishingConfig,
    normalizeRouteModel,
} from '../../web-publishing/lib/routes.mjs';
import { runtimeConfigFingerprint } from '../../web-publishing/runtime/config-fingerprint.mjs';

test('normalizePublishingConfig creates default Explorer public topology from base domain', () => {
    const config = normalizePublishingConfig({
        mode: 'nginx-cloudflare',
        tlsEdge: 'cloudflare',
        baseDomain: 'Example.COM',
        livekitMediaIp: '203.0.113.10',
        turnExternalIp: '198.51.100.20',
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
                service: 'http://ploinky-router:7000',
            }],
        }),
        /AgentServer\/MCP port 7000/,
    );
});

test('normalizeRouteModel rejects Nginx path injection while accepting simple URI paths', () => {
    for (const path of [
        '/safe { return 204; } location /injected',
        '/safe;proxy_pass',
        '/safe#comment',
        '/safe$uri',
        '/safe"quoted',
        "/safe'quoted",
        '/safe path',
        '/safe\tpath',
        '/safe ',
    ]) {
        assert.throws(
            () => normalizeRouteModel({
                baseDomain: 'example.com',
                exposures: [{ hostname: 'app.example.com', path, originId: 'router' }],
            }),
            /Exposure path/,
            `${JSON.stringify(path)} must be rejected`,
        );
    }

    const { routes } = normalizeRouteModel({
        baseDomain: 'example.com',
        exposures: [{
            hostname: 'app.example.com',
            path: '/office/v1_assets/~me/%2Fdoc-1',
            originId: 'router',
        }],
    });
    assert.equal(routes[0].path, '/office/v1_assets/~me/%2Fdoc-1');
});

test('buildCloudflaredIngress orders path routes before host catch-all and appends 404', () => {
    const { routes } = normalizeRouteModel({
        baseDomain: 'example.com',
        exposures: [
            { hostname: 'app.example.com', originId: 'router' },
            { hostname: 'app.example.com', path: '/office', originId: 'router' },
        ],
    });

    assert.deepEqual(buildCloudflaredIngress(routes), [
        {
            hostname: 'app.example.com',
            path: '/office',
            service: 'http://ploinky-router:8080',
        },
        {
            hostname: 'app.example.com',
            service: 'http://ploinky-router:8080',
        },
        { service: 'http_status:404' },
    ]);
});

test('buildProviderValues ignores stale public env and excludes generated secrets', () => {
    const config = normalizePublishingConfig({
        mode: 'nginx',
        tlsEdge: 'external',
        baseDomain: 'example.com',
        livekitMediaIp: '203.0.113.10',
        turnExternalIp: '198.51.100.20',
    }, {
        WEB_PUBLISHING_EXTERNAL_PROXY_CIDRS: '10.89.0.1/32',
    });
    const values = buildProviderValues(config, {
        ONLYOFFICE_PUBLIC_URL: 'https://stale.example.net',
        WEBMEET_LIVEKIT_API_SECRET: 'must-not-copy',
        CLOUDFLARED_TUNNEL_TOKEN: 'legacy-token',
        WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN: 'scoped-token',
    });

    const byName = new Map(values.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('ONLYOFFICE_PUBLIC_URL')?.value, 'https://office.example.com');
    assert.equal(byName.get('ONLYOFFICE_INTERNAL_URL')?.value, 'http://127.0.0.1:80');
    assert.equal(byName.get('WEBMEET_PUBLIC_LIVEKIT_URL')?.value, 'wss://meet.example.com');
    assert.equal(byName.get('WEBMEET_LIVEKIT_NODE_IP')?.value, '203.0.113.10');
    assert.equal(byName.get('WEBMEET_TURN_EXTERNAL_IP')?.value, '198.51.100.20');
    assert.equal(byName.get('WEBMEET_TURN_ALLOWED_PEER_IPS')?.value, '203.0.113.10/32');
    assert.equal(byName.get('WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN')?.sensitive, true);
    assert.equal(values.some((entry) => entry.name === 'CLOUDFLARED_TUNNEL_TOKEN'), false);
    assert.equal(values.some((entry) => entry.name === 'WEBMEET_LIVEKIT_API_SECRET'), false);
    for (const name of ['WEBMEET_TLS_HOSTNAME', 'WEBMEET_CERT_EMAIL', 'WEBMEET_LIVEKIT_UPSTREAM']) {
        assert.equal(values.some((entry) => entry.name === name), false, `${name} must not be emitted`);
    }
});

test('external proxy trust accepts only exact deployment-owned peer addresses', () => {
    assert.deepEqual(
        normalizeExternalProxyCidrs('10.89.0.1, 2001:db8::1/128,10.89.0.1/32'),
        ['10.89.0.1/32', '2001:db8::1/128'],
    );
    for (const value of ['10.89.0.0/24', '0.0.0.0/0', '10.89.0.1/032', '2001:db8::/64', 'not-an-ip']) {
        assert.throws(
            () => normalizeExternalProxyCidrs(value),
            /exact \/(?:32|128) host CIDR|Invalid external proxy address/,
        );
    }
    assert.throws(
        () => normalizePublishingConfig({
            mode: 'nginx',
            tlsEdge: 'external',
            baseDomain: 'example.com',
            livekitMediaIp: '203.0.113.10',
            turnExternalIp: '198.51.100.20',
            externalProxyCidrs: ['10.89.0.1/32'],
        }),
        /WEB_PUBLISHING_EXTERNAL_PROXY_CIDRS is required/,
        'a dashboard/MCP draft cannot broaden the deployment-owned peer allowlist',
    );
});

test('fixed listener addresses are neither normalized nor fingerprinted as draft config', () => {
    const normalized = normalizePublishingConfig({
        lanHost: '0.0.0.0',
        listenPort: 65535,
    });
    assert.equal(Object.hasOwn(normalized, 'lanHost'), false);
    assert.equal(Object.hasOwn(normalized, 'listenPort'), false);
    assert.equal(
        runtimeConfigFingerprint(normalized),
        runtimeConfigFingerprint({
            ...normalized,
            lanHost: '0.0.0.0',
            listenPort: 65535,
        }),
    );
});

test('local/default topology creates usable loopback Office and LiveKit routes without public IP outputs', () => {
    const config = normalizePublishingConfig({});
    assert.deepEqual(config.exposures.map((route) => ({ hostname: route.hostname, originId: route.originId })), [
        { hostname: 'office.localhost', originId: 'onlyoffice' },
        { hostname: '127.0.0.1', originId: 'livekit-http' },
    ]);
    const values = new Map(buildProviderValues(config).map((entry) => [entry.name, entry.value]));
    assert.equal(values.get('ONLYOFFICE_PUBLIC_URL'), 'http://office.localhost:8081');
    assert.equal(values.get('WEBMEET_PUBLIC_LIVEKIT_URL'), 'ws://127.0.0.1:8081');
    assert.equal(values.has('WEBMEET_LIVEKIT_NODE_IP'), false);
    assert.equal(values.has('WEBMEET_TURN_EXTERNAL_IP'), false);
});

test('OnlyOffice publishing requires its canonical root hostname', () => {
    const publicConfig = {
        mode: 'nginx',
        tlsEdge: 'external',
        baseDomain: 'example.com',
        livekitMediaIp: '203.0.113.10',
        turnExternalIp: '198.51.100.20',
    };
    const publicEnv = {
        WEB_PUBLISHING_EXTERNAL_PROXY_CIDRS: '10.89.0.1/32',
    };
    const livekit = {
        hostname: 'meet.example.com',
        originId: 'livekit-http',
    };

    for (const office of [
        { hostname: 'app.example.com', originId: 'onlyoffice' },
        { hostname: 'office.example.com', path: '/office', originId: 'onlyoffice' },
    ]) {
        assert.throws(
            () => normalizePublishingConfig({
                ...publicConfig,
                exposures: [office, livekit],
            }, publicEnv),
            /canonical office\.example\.com root route/,
        );
    }

    const canonical = normalizePublishingConfig({
        ...publicConfig,
        exposures: [
            { hostname: 'office.example.com', path: '/', originId: 'onlyoffice' },
            livekit,
        ],
    }, publicEnv);
    assert.equal(
        canonical.exposures.find((route) => route.originId === 'onlyoffice')?.path,
        '',
    );

    assert.throws(
        () => normalizePublishingConfig({
            exposures: [
                { hostname: 'office.localhost', path: '/office', originId: 'onlyoffice' },
                { hostname: '127.0.0.1', originId: 'livekit-http' },
            ],
        }),
        /canonical office\.localhost root route/,
    );
});

test('local normalization upgrades persisted LiveKit-only topology with the canonical Office route', () => {
    const config = normalizePublishingConfig({
        exposures: [{
            id: 'livekit-local',
            enabled: true,
            hostname: '127.0.0.1',
            originId: 'livekit-http',
        }],
    });

    assert.deepEqual(config.exposures.map((route) => ({ hostname: route.hostname, originId: route.originId })), [
        { hostname: 'office.localhost', originId: 'onlyoffice' },
        { hostname: '127.0.0.1', originId: 'livekit-http' },
    ]);
    const values = new Map(buildProviderValues(config).map((entry) => [entry.name, entry.value]));
    assert.equal(values.get('ONLYOFFICE_PUBLIC_URL'), 'http://office.localhost:8081');
});

test('managed origins use only the router gateway and canonical agent DNS names', () => {
    const config = normalizePublishingConfig({
        mode: 'nginx-cloudflare',
        tlsEdge: 'cloudflare',
        baseDomain: 'example.com',
        livekitMediaIp: '203.0.113.10',
        turnExternalIp: '198.51.100.20',
    });
    const services = new Map(config.exposures.map((entry) => [entry.originId, entry.service]));

    assert.equal(services.get('router'), 'http://ploinky-router:8080');
    assert.equal(services.get('onlyoffice'), 'http://onlyoffice:8080');
    assert.equal(services.get('livekit-http'), 'http://livekitserveragent:7880');
    assert.doesNotMatch(JSON.stringify(config), /host\.containers\.internal/);
});

test('public topology fails closed without an explicit trusted TLS edge and canonical IPs', () => {
    assert.throws(
        () => normalizePublishingConfig({ baseDomain: 'example.com' }),
        /explicit trusted TLS edge contract/,
    );
    assert.throws(
        () => normalizePublishingConfig({
            mode: 'cloudflare-api',
            tlsEdge: 'external',
            baseDomain: 'example.com',
            livekitMediaIp: '203.0.113.10',
            turnExternalIp: '198.51.100.20',
        }),
        /require WEB_PUBLISHING_TLS_EDGE=cloudflare/,
    );
    assert.throws(
        () => normalizePublishingConfig({
            mode: 'nginx',
            tlsEdge: 'external',
            baseDomain: 'example.com',
            livekitMediaIp: 'not-an-ip',
            turnExternalIp: '198.51.100.20',
        }),
        /bare IPv4 address/,
    );
    for (const address of ['0.0.0.0', '127.0.0.1', '169.254.1.2', '224.0.0.1', '255.255.255.255']) {
        assert.throws(
            () => normalizePublishingConfig({
                mode: 'nginx',
                tlsEdge: 'external',
                baseDomain: 'example.com',
                livekitMediaIp: address,
                turnExternalIp: '198.51.100.20',
            }),
            /unicast, non-loopback IPv4 address/,
            `media address ${address} must fail closed`,
        );
        assert.throws(
            () => normalizePublishingConfig({
                mode: 'nginx',
                tlsEdge: 'external',
                baseDomain: 'example.com',
                livekitMediaIp: '203.0.113.10',
                turnExternalIp: address,
            }),
            /unicast, non-loopback IPv4 address/,
            `TURN address ${address} must fail closed`,
        );
    }
});

test('domain normalization rejects empty, oversized, and malformed DNS labels', () => {
    for (const baseDomain of [
        'example..com',
        '.example.com',
        'example.com.',
        '-example.com',
        'example-.com',
        `${'a'.repeat(64)}.example.com`,
    ]) {
        assert.throws(
            () => normalizePublishingConfig({
                mode: 'nginx',
                tlsEdge: 'external',
                baseDomain,
                livekitMediaIp: '203.0.113.10',
                turnExternalIp: '198.51.100.20',
            }),
            /Invalid base domain/,
            `${baseDomain} must fail closed`,
        );
    }
});

test('Cloudflare signaling routes only to the dedicated same-container nginx listener', () => {
    const config = normalizePublishingConfig({
        mode: 'cloudflare-api',
        tlsEdge: 'cloudflare',
        baseDomain: 'example.com',
        livekitMediaIp: '203.0.113.10',
        turnExternalIp: '198.51.100.20',
    });
    const livekitIngress = buildCloudflaredIngress(config.exposures)
        .find((entry) => entry.hostname === 'meet.example.com');
    assert.deepEqual(livekitIngress, {
        hostname: 'meet.example.com',
        service: 'http://127.0.0.1:18081',
    });
    assert.doesNotMatch(JSON.stringify(livekitIngress), /livekitserveragent:7880/);
});

test('TURN DNS record is a canonical unproxied A record', () => {
    const config = normalizePublishingConfig({
        mode: 'cloudflare-api',
        tlsEdge: 'cloudflare',
        baseDomain: 'example.com',
        livekitMediaIp: '203.0.113.10',
        turnExternalIp: '198.51.100.20',
    });
    assert.deepEqual(buildTurnDnsRecord(config), {
        type: 'A',
        name: 'turn.example.com',
        content: '198.51.100.20',
        ttl: 1,
        proxied: false,
    });
    assert.equal(buildTurnDnsRecord(normalizePublishingConfig({})), null);
});
