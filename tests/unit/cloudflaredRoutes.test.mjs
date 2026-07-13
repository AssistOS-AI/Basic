import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildIngress,
    loadOriginPresets,
    normalizeRoutes,
} from '../../cloudflared/lib/routes.mjs';

test('normalizeRoutes accepts hostnames under the configured base domain', () => {
    const { routes } = normalizeRoutes([
        { hostname: 'explorer.example.com', originId: 'router' },
    ], {
        env: { CLOUDFLARE_BASE_DOMAIN: 'example.com' },
    });

    assert.deepEqual(routes, [
        {
            id: 'route_1',
            enabled: true,
            hostname: 'explorer.example.com',
            path: '',
            originId: 'router',
            service: 'http://ploinky-router:8080',
            description: '',
        },
    ]);
});

test('buildIngress appends a catch-all 404 rule', () => {
    const { routes } = normalizeRoutes([
        { hostname: 'explorer.example.com', path: '/agents', originId: 'router' },
    ], {
        env: { CLOUDFLARE_BASE_DOMAIN: 'example.com' },
    });

    assert.deepEqual(buildIngress(routes), [
        {
            hostname: 'explorer.example.com',
            path: '/agents',
            service: 'http://ploinky-router:8080',
        },
        { service: 'http_status:404' },
    ]);
});

test('buildIngress places path-specific routes before host catch-all routes', () => {
    const { routes } = normalizeRoutes([
        { hostname: 'app.example.com', originId: 'router' },
        { hostname: 'app.example.com', path: '/agents', originId: 'router' },
        { hostname: 'app.example.com', path: '/agents/admin', originId: 'router' },
    ], {
        env: { CLOUDFLARE_BASE_DOMAIN: 'example.com' },
    });

    assert.deepEqual(buildIngress(routes), [
        {
            hostname: 'app.example.com',
            path: '/agents/admin',
            service: 'http://ploinky-router:8080',
        },
        {
            hostname: 'app.example.com',
            path: '/agents',
            service: 'http://ploinky-router:8080',
        },
        {
            hostname: 'app.example.com',
            service: 'http://ploinky-router:8080',
        },
        { service: 'http_status:404' },
    ]);
});

test('buildIngress groups same-host path routes before host catch-all routes when hostnames are interleaved', () => {
    const { routes } = normalizeRoutes([
        { hostname: 'app.example.com', originId: 'router' },
        { hostname: 'other.example.com', originId: 'router' },
        { hostname: 'app.example.com', path: '/agents', originId: 'router' },
        { hostname: 'app.example.com', path: '/agents/admin', originId: 'router' },
    ], {
        env: { CLOUDFLARE_BASE_DOMAIN: 'example.com' },
    });

    const ingress = buildIngress(routes);
    const appRootIndex = ingress.findIndex((entry) => entry.hostname === 'app.example.com' && !entry.path);
    const appPathIndexes = ingress
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.hostname === 'app.example.com' && entry.path)
        .map(({ index }) => index);

    assert.ok(appRootIndex > -1);
    assert.ok(appPathIndexes.length > 0);
    assert.equal(
        appPathIndexes.every((index) => index < appRootIndex),
        true,
        'same-host path rules must precede the host catch-all',
    );
    assert.deepEqual(ingress, [
        {
            hostname: 'app.example.com',
            path: '/agents/admin',
            service: 'http://ploinky-router:8080',
        },
        {
            hostname: 'app.example.com',
            path: '/agents',
            service: 'http://ploinky-router:8080',
        },
        {
            hostname: 'app.example.com',
            service: 'http://ploinky-router:8080',
        },
        {
            hostname: 'other.example.com',
            service: 'http://ploinky-router:8080',
        },
        { service: 'http_status:404' },
    ]);
});

test('normalizeRoutes rejects hostnames outside the base domain', () => {
    assert.throws(
        () => normalizeRoutes([
            { hostname: 'explorer.bad.test', originId: 'router' },
        ], {
            env: { CLOUDFLARE_BASE_DOMAIN: 'example.com' },
        }),
        /must be under example\.com/,
    );
});

test('loadOriginPresets exposes only the fixed Ploinky router origin', () => {
    assert.deepEqual(loadOriginPresets({}), [
        {
            id: 'router',
            label: 'Ploinky router',
            service: 'http://ploinky-router:8080',
            description: 'Router-hosted Explorer and agent HTTP/WebSocket surfaces.',
        },
    ]);
});

test('loadOriginPresets rejects environment overrides instead of opening host gateways', () => {
    assert.throws(
        () => loadOriginPresets({
            CLOUDFLARED_ALLOWED_ORIGINS_JSON: JSON.stringify([
                {
                    id: 'router',
                    label: 'Unsafe host gateway',
                    service: 'http://host.containers.internal:8080',
                },
            ]),
        }),
        /overrides are not supported/,
    );
});

test('normalizeRoutes rejects host gateways, loopback, alternate services, and URL decorations', () => {
    for (const service of [
        'http://host.containers.internal:8080',
        'http://localhost:8080',
        'http://127.0.0.1:8080',
        'http://ploinky-router:8082',
        'https://ploinky-router:8080',
        'http://ploinky-router:8080/path',
        'http://user:secret@ploinky-router:8080',
    ]) {
        assert.throws(
            () => normalizeRoutes([
                {
                    hostname: 'explorer.example.com',
                    originId: 'router',
                    service,
                },
            ], {
                env: { CLOUDFLARE_BASE_DOMAIN: 'example.com' },
            }),
            /must equal http:\/\/ploinky-router:8080|origin URL/,
            service,
        );
    }
});

test('normalizeRoutes rejects undeclared sibling-agent origins', () => {
    assert.throws(
        () => normalizeRoutes([
            { hostname: 'office.example.com', originId: 'onlyoffice' },
        ], {
            env: { CLOUDFLARE_BASE_DOMAIN: 'example.com' },
        }),
        /Unknown originId.*onlyoffice/,
    );
});
