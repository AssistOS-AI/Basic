import test from 'node:test';
import assert from 'node:assert/strict';

import {
    parseRuntimeDnsResolvers,
    renderNginxConfig,
} from '../../web-publishing/lib/nginx-config.mjs';
import { normalizeRouteModel } from '../../web-publishing/lib/routes.mjs';

const EXTERNAL_PROXY_CIDRS = ['10.89.0.1/32'];

test('renderNginxConfig scopes hardened LiveKit signaling to /rtc and its slash-delimited subtree', () => {
    const { routes } = normalizeRouteModel({
        baseDomain: 'example.com',
        exposures: [
            { hostname: 'meet.example.com', originId: 'livekit-http' },
        ],
    });

    const rendered = renderNginxConfig(routes, {
        dnsResolvers: ['127.0.0.11'],
    });

    const signalingSelectors = ['location = /rtc {', 'location ^~ /rtc/ {'];
    for (const selector of signalingSelectors) {
        const start = rendered.indexOf(selector);
        assert.notEqual(start, -1, `${selector} must be rendered`);
        const end = rendered.indexOf('\n    }', start);
        assert.notEqual(end, -1, `${selector} must have a closing block`);
        const locationBlock = rendered.slice(start, end);
        assert.match(locationBlock, /access_log off;/);
        assert.match(locationBlock, /error_log \/dev\/null crit;/);
        assert.match(locationBlock, /limit_req zone=web_publishing_rtc_req burst=20;/);
        assert.match(locationBlock, /limit_conn web_publishing_rtc_conn 50;/);
        assert.match(locationBlock, /proxy_set_header Upgrade \$http_upgrade;/);
        assert.match(locationBlock, /proxy_read_timeout 3600s;/);
        assert.match(locationBlock, /proxy_pass http:\/\/\$livekit_signaling_host:7880;/);
    }
    assert.doesNotMatch(rendered, /location \^~ \/rtc \{/);
    assert.match(rendered, /set \$livekit_signaling_host livekitserveragent;/);
    assert.match(rendered, /resolver 127\.0\.0\.11 valid=10s ipv6=off;/);
    assert.match(rendered, /location = \/twirp \{\s*access_log off;\s*return 404;\s*\}/);
    assert.match(rendered, /location = \/webhook \{\s*access_log off;\s*return 404;\s*\}/);
    assert.match(rendered, /location \/ \{\s*access_log off;\s*return 404;\s*\}/);
    assert.match(rendered, /pid \/tmp\/web-publishing-nginx\.pid;/);
    assert.match(rendered, /proxy_temp_path \/tmp\/web-publishing-proxy;/);
    assert.doesNotMatch(rendered, /proxy_pass http:\/\/livekitserveragent:7880|proxy_pass http:\/\/host\.containers\.internal:7880/);
});

test('renderNginxConfig declares the /rtc rate-limit zones at the http block level', () => {
    const { routes } = normalizeRouteModel({
        baseDomain: 'example.com',
        exposures: [{ hostname: 'meet.example.com', originId: 'livekit-http' }],
    });

    const rendered = renderNginxConfig(routes, { dnsResolvers: ['10.89.0.1'] });

    assert.match(rendered, /limit_req_zone \$binary_remote_addr zone=web_publishing_rtc_req:10m rate=5r\/s;/);
    assert.match(rendered, /limit_conn_zone \$binary_remote_addr zone=web_publishing_rtc_conn:10m;/);
});

test('Cloudflare client IP headers are trusted only on the dedicated loopback connector listener', () => {
    const { routes } = normalizeRouteModel({
        baseDomain: 'example.com',
        exposures: [{ hostname: 'meet.example.com', originId: 'livekit-http' }],
    });
    const rendered = renderNginxConfig(routes, {
        dnsResolvers: ['127.0.0.11'],
        tlsEdge: 'cloudflare',
    });
    const blocks = rendered.split('server {').slice(1);
    const direct = blocks.find((block) => block.includes('listen 8081;') && block.includes('server_name meet.example.com;'));
    const connector = blocks.find((block) => block.includes('listen 127.0.0.1:18081;') && block.includes('server_name meet.example.com;'));

    assert.ok(direct);
    assert.ok(connector);
    assert.doesNotMatch(direct, /CF-Connecting-IP|set_real_ip_from/);
    assert.match(connector, /if \(\$http_cf_connecting_ip = ""\) \{ return 400; \}/);
    assert.match(connector, /set_real_ip_from 127\.0\.0\.1;/);
    assert.match(connector, /real_ip_header CF-Connecting-IP;/);
    assert.match(connector, /real_ip_recursive off;/);
    assert.match(connector, /proxy_set_header X-Forwarded-Proto https;/);
});

test('external TLS uses a dedicated loopback-published connector and preserves per-client limits', () => {
    const { routes } = normalizeRouteModel({
        baseDomain: 'example.com',
        exposures: [{ hostname: 'meet.example.com', originId: 'livekit-http' }],
    });
    const rendered = renderNginxConfig(routes, {
        dnsResolvers: ['127.0.0.11'],
        tlsEdge: 'external',
        externalProxyCidrs: EXTERNAL_PROXY_CIDRS,
    });
    const blocks = rendered.split('server {').slice(1);
    const direct = blocks.find((block) => block.includes('listen 8081;') && block.includes('server_name meet.example.com;'));
    const connector = blocks.find((block) => block.includes('listen 18083;') && block.includes('server_name meet.example.com;'));

    assert.ok(direct);
    assert.ok(connector);
    assert.doesNotMatch(direct, /proxy_pass|X-Real-IP|set_real_ip_from/);
    assert.match(direct, /location \/ \{\s*access_log off;\s*return 404;/);
    assert.match(connector, /if \(\$http_x_real_ip = ""\) \{ return 400; \}/);
    assert.match(connector, /if \(\$web_publishing_external_proxy_trusted = 0\) \{ return 403; \}/);
    assert.match(connector, /set_real_ip_from 10\.89\.0\.1\/32;/);
    assert.doesNotMatch(connector, /set_real_ip_from 0\.0\.0\.0\/0|set_real_ip_from ::\/0/);
    assert.match(connector, /real_ip_header X-Real-IP;/);
    assert.match(connector, /proxy_set_header X-Forwarded-Proto https;/);
    assert.match(connector, /limit_req zone=web_publishing_rtc_req burst=20;/);
    assert.match(connector, /limit_conn web_publishing_rtc_conn 50;/);
    assert.match(connector, /proxy_pass http:\/\/\$livekit_signaling_host:7880;/);
    assert.doesNotMatch(rendered, /127\.0\.0\.1:18081/);
    assert.match(rendered, /geo \$realip_remote_addr \$web_publishing_external_proxy_trusted \{\s*default 0;\s*10\.89\.0\.1\/32 1;/);
});

test('external TLS rejects broad or missing proxy trust and keeps sibling peers untrusted', () => {
    const { routes } = normalizeRouteModel({
        baseDomain: 'example.com',
        exposures: [{ hostname: 'meet.example.com', originId: 'livekit-http' }],
    });
    assert.throws(
        () => renderNginxConfig(routes, { dnsResolvers: ['127.0.0.11'], tlsEdge: 'external' }),
        /exact external proxy peer CIDR is required/,
    );
    for (const externalProxyCidrs of [
        ['0.0.0.0/0'],
        ['10.89.0.0/24'],
        ['::/0'],
        ['10.89.0.1/32', ''],
    ]) {
        assert.throws(
            () => renderNginxConfig(routes, {
                dnsResolvers: ['127.0.0.11'],
                tlsEdge: 'external',
                externalProxyCidrs,
            }),
            /exact \/(?:32|128) host CIDR|must not contain empty entries/,
        );
    }
    const rendered = renderNginxConfig(routes, {
        dnsResolvers: ['127.0.0.11'],
        tlsEdge: 'external',
        externalProxyCidrs: ['10.89.0.1'],
    });
    assert.match(rendered, /10\.89\.0\.1\/32 1;/);
    assert.doesNotMatch(rendered, /10\.89\.0\.2/);
});

test('renderNginxConfig requires validated runtime resolvers instead of resolving the alias during nginx -t', () => {
    const { routes } = normalizeRouteModel({
        baseDomain: 'example.com',
        exposures: [{ hostname: 'meet.example.com', originId: 'livekit-http' }],
    });
    assert.throws(() => renderNginxConfig(routes), /runtime DNS resolver is required/);
    assert.throws(
        () => renderNginxConfig(routes, { dnsResolvers: ['resolver; injection'] }),
        /Invalid runtime DNS resolver/,
    );
    assert.deepEqual(
        parseRuntimeDnsResolvers('nameserver 127.0.0.11\nnameserver 10.89.0.1\nsearch local\n'),
        ['127.0.0.11', '10.89.0.1'],
    );
    assert.throws(() => parseRuntimeDnsResolvers('search local\n'), /No valid runtime DNS resolver/);
});

test('renderNginxConfig returns 404 for an unmatched Host header (fail-closed default)', () => {
    const rendered = renderNginxConfig([]);

    assert.match(rendered, /server \{\s*listen 8081 default_server;\s*server_name _;\s*access_log off;\s*return 404;\s*\}/);
    assert.doesNotMatch(rendered, /18081|18083/);
    const cloudflare = renderNginxConfig([], { tlsEdge: 'cloudflare' });
    assert.match(cloudflare, /server \{\s*listen 127\.0\.0\.1:18081 default_server;\s*server_name _;\s*access_log off;\s*return 404;\s*\}/);
    const external = renderNginxConfig([], {
        tlsEdge: 'external',
        externalProxyCidrs: EXTERNAL_PROXY_CIDRS,
    });
    assert.match(external, /server \{\s*listen 18083 default_server;\s*server_name _;\s*access_log off;\s*return 404;\s*\}/);
});

test('renderNginxConfig rejects an unknown TLS-edge contract', () => {
    assert.throws(() => renderNginxConfig([], { tlsEdge: 'inferred' }), /Unsupported nginx TLS edge/);
});

test('renderNginxConfig refuses raw AgentServer port routes', () => {
    assert.throws(
        () => renderNginxConfig([
            {
                hostname: 'agent.example.com',
                path: '',
                service: 'http://ploinky-router:7000',
                enabled: true,
            },
        ]),
        /AgentServer\/MCP port 7000/,
    );
});

test('renderNginxConfig defensively rejects an unnormalized injected location path', () => {
    assert.throws(
        () => renderNginxConfig([{
            hostname: 'app.example.com',
            path: '/safe { proxy_pass http://ploinky-router:7000; } location /injected',
            service: 'http://ploinky-router:8080',
            originId: 'router',
            enabled: true,
        }]),
        /Exposure path/,
    );
});

test('renderNginxConfig defensively rejects injected or noncanonical hostnames', () => {
    const invalidHostnames = [
        'app.example.com; return 200',
        'app.example.com\nserver_name injected.example.com',
        'app.example.com\u0000.conf',
        'app.example.com}',
        '127.000.0.1',
        '127.0.0.999',
    ];

    for (const hostname of invalidHostnames) {
        assert.throws(
            () => renderNginxConfig([{
                hostname,
                path: '',
                service: 'http://ploinky-router:8080',
                originId: 'router',
                enabled: true,
            }]),
            /Invalid (?:base domain|exposure IPv4 hostname)/,
            hostname,
        );
    }
});

test('renderNginxConfig accepts canonical DNS and IPv4 hostnames', () => {
    const rendered = renderNginxConfig([
        {
            hostname: 'app.example.com',
            path: '',
            service: 'http://ploinky-router:8080',
            originId: 'router',
            enabled: true,
        },
        {
            hostname: '127.0.0.1',
            path: '',
            service: 'http://ploinky-router:8080',
            originId: 'router',
            enabled: true,
        },
    ]);

    assert.match(rendered, /server_name app\.example\.com;/);
    assert.match(rendered, /server_name 127\.0\.0\.1;/);
});

test('renderNginxConfig preserves the exclusive LiveKit hostname boundary when called directly', () => {
    assert.throws(
        () => renderNginxConfig([
            {
                hostname: 'meet.example.com',
                path: '',
                service: 'http://livekitserveragent:7880',
                originId: ' livekit-http ',
                enabled: true,
            },
            {
                hostname: 'meet.example.com',
                path: '/app',
                service: 'http://ploinky-router:8080',
                originId: 'router',
                enabled: true,
            },
        ], {
            dnsResolvers: ['127.0.0.11'],
            tlsEdge: 'external',
            externalProxyCidrs: EXTERNAL_PROXY_CIDRS,
        }),
        /cannot be shared with another HTTP origin/,
    );
});
