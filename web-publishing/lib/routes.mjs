import { isIP } from 'node:net';

const ROUTER_SERVICE_HOST = 'ploinky-router';
const ONLYOFFICE_SERVICE_HOST = 'onlyoffice';
// Ploinky derives this network-scoped DNS name from the canonical liveKitServerAgent id.
const LIVEKIT_SERVICE_HOST = 'livekitserveragent';
const DEFAULT_LISTEN_PORT = 8081;
export const CLOUDFLARE_NGINX_LISTEN_PORT = 18081;
export const EXTERNAL_NGINX_LISTEN_PORT = 18083;
const CLOUDFLARE_NGINX_ORIGIN = `http://127.0.0.1:${CLOUDFLARE_NGINX_LISTEN_PORT}`;

const DEFAULT_ORIGINS = [
    {
        id: 'router',
        label: 'Ploinky router',
        service: `http://${ROUTER_SERVICE_HOST}:8080`,
        description: 'Explorer and router-hosted HTTP/WebSocket surfaces.',
    },
    {
        id: 'onlyoffice',
        label: 'OnlyOffice Document Server',
        service: `http://${ONLYOFFICE_SERVICE_HOST}:8080`,
        description: 'OnlyOffice editor origin.',
    },
    {
        id: 'livekit-http',
        label: 'LiveKit HTTP signaling',
        service: `http://${LIVEKIT_SERVICE_HOST}:7880`,
        description: 'LiveKit HTTP/WebSocket signaling origin. UDP/TURN media remains direct.',
    },
];

const GENERATED_SECRET_NAMES = new Set([
    'WEBMEET_LIVEKIT_API_KEY',
    'WEBMEET_LIVEKIT_API_SECRET',
    'WEBMEET_TURN_PASSWORD',
    'WEBMEET_TURN_AUTH_SECRET',
    'PLOINKY_WEBMEET_MASTER_KEY',
    'ONLYOFFICE_JWT_SECRET',
    'JWT_SECRET',
]);

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function definedEntries(object = {}) {
    return Object.fromEntries(
        Object.entries(object).filter(([, value]) => value !== undefined && value !== '')
    );
}

function normalizeMode(value) {
    const mode = normalizeString(value).toLowerCase();
    if (!mode) return 'nginx';
    if (['nginx', 'token', 'cloudflare-token', 'cloudflare-api', 'nginx-cloudflare'].includes(mode)) {
        return mode === 'token' ? 'cloudflare-token' : mode;
    }
    throw new Error(`Unsupported Web Publishing mode: ${value}`);
}

function normalizeTlsEdge(value) {
    const edge = normalizeString(value).toLowerCase();
    if (!edge) return 'none';
    if (['none', 'cloudflare', 'external'].includes(edge)) return edge;
    throw new Error(`Unsupported Web Publishing TLS edge: ${value}`);
}

export function normalizeIpv4(value, label) {
    const raw = normalizeString(value);
    if (!raw) return '';
    if (isIP(raw) !== 4) throw new Error(`${label} must be a bare IPv4 address.`);
    const octets = raw.split('.').map(Number);
    const [first, second] = octets;
    if (
        first === 0
        || first === 127
        || first >= 224
        || (first === 169 && second === 254)
    ) {
        throw new Error(`${label} must be a unicast, non-loopback IPv4 address.`);
    }
    return raw;
}

export function normalizeExternalProxyCidrs(value) {
    const rawEntries = Array.isArray(value)
        ? value
        : (normalizeString(value) ? String(value).split(',') : []);
    if (rawEntries.length > 16) {
        throw new Error('WEB_PUBLISHING_EXTERNAL_PROXY_CIDRS accepts at most 16 exact proxy peers.');
    }
    const normalized = [];
    for (const rawEntry of rawEntries) {
        const entry = String(rawEntry ?? '').trim();
        if (!entry) {
            throw new Error('WEB_PUBLISHING_EXTERNAL_PROXY_CIDRS must not contain empty entries.');
        }
        const slash = entry.lastIndexOf('/');
        const address = slash === -1 ? entry : entry.slice(0, slash);
        const version = isIP(address);
        if (!version) {
            throw new Error(`Invalid external proxy address: ${entry}`);
        }
        const exactPrefix = version === 4 ? 32 : 128;
        const prefixText = slash === -1 ? String(exactPrefix) : entry.slice(slash + 1);
        if (prefixText !== String(exactPrefix)) {
            throw new Error(`External proxy peer ${entry} must be an exact /${exactPrefix} host CIDR.`);
        }
        const cidr = `${address.toLowerCase()}/${exactPrefix}`;
        if (!normalized.includes(cidr)) normalized.push(cidr);
    }
    return normalized;
}

function modeUsesCloudflare(mode) {
    return String(mode || '').includes('cloudflare');
}

function normalizeDomain(value) {
    const raw = normalizeString(value).toLowerCase();
    if (!raw) return '';
    const labels = raw.split('.');
    const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    if (
        raw.length > 253
        || labels.some((label) => !validLabel.test(label))
    ) {
        throw new Error(`Invalid base domain: ${value}`);
    }
    return raw;
}

export function normalizeHostname(value, { baseDomain = '' } = {}) {
    const input = normalizeString(value).toLowerCase();
    if (/^[0-9]+(?:\.[0-9]+){3}$/.test(input) && isIP(input) !== 4) {
        throw new Error(`Invalid exposure IPv4 hostname: ${value}`);
    }
    const raw = normalizeDomain(input);
    if (!raw) throw new Error('Exposure hostname is required.');
    if (raw.includes('*')) throw new Error('Wildcard hostnames are not enabled for Web Publishing.');
    if (baseDomain && raw !== baseDomain && !raw.endsWith(`.${baseDomain}`)) {
        throw new Error(`Hostname ${raw} must be under ${baseDomain}.`);
    }
    return raw;
}

export function normalizePathPattern(value) {
    const raw = typeof value === 'string' ? value : '';
    if (!raw) return '';
    if (raw !== raw.trim()) {
        throw new Error('Exposure path must not contain leading or trailing whitespace.');
    }
    const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
    if (withSlash === '/') return '';
    if (/[\u0000-\u001f]/.test(withSlash)) {
        throw new Error('Exposure path contains control characters.');
    }
    if (withSlash.length > 256) {
        throw new Error('Exposure path must be at most 256 characters.');
    }
    if (!/^\/(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2}|\/)*$/.test(withSlash)) {
        throw new Error('Exposure path must be a simple URI path using only unreserved characters, slashes, or percent-encoded octets.');
    }
    return withSlash;
}

export function normalizeService(value) {
    const raw = normalizeString(value);
    if (!raw) throw new Error('Exposure service is required.');
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error(`Invalid exposure service URL: ${raw}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Exposure service must use http or https.');
    }
    const allowedHosts = new Set([
        ROUTER_SERVICE_HOST,
        ONLYOFFICE_SERVICE_HOST,
        LIVEKIT_SERVICE_HOST,
        '127.0.0.1',
    ]);
    if (!allowedHosts.has(parsed.hostname)) {
        throw new Error(`Exposure service host must be ${[...allowedHosts].join(', ')}.`);
    }
    if (!parsed.port) {
        throw new Error('Exposure service must include an explicit port.');
    }
    if (parsed.port === '7000') {
        throw new Error('Do not publish raw Ploinky AgentServer/MCP port 7000.');
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error('Exposure service must be an origin URL without path, query, or fragment.');
    }
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
}

export function defaultExposuresForDomain(baseDomain) {
    if (!baseDomain) {
        return [
            {
                id: 'onlyoffice-local',
                enabled: true,
                hostname: 'office.localhost',
                path: '',
                originId: 'onlyoffice',
                description: 'Local OnlyOffice editor through the loopback-only nginx listener.',
            },
            {
                id: 'livekit-local',
                enabled: true,
                hostname: '127.0.0.1',
                path: '',
                originId: 'livekit-http',
                description: 'Local LiveKit signaling through the loopback-only nginx listener.',
            },
        ];
    }
    return [
        {
            id: 'explorer',
            enabled: true,
            hostname: `explorer.${baseDomain}`,
            path: '',
            originId: 'router',
            description: 'Explorer and Ploinky router',
        },
        {
            id: 'onlyoffice',
            enabled: true,
            hostname: `office.${baseDomain}`,
            path: '',
            originId: 'onlyoffice',
            description: 'OnlyOffice Document Server',
        },
        {
            id: 'livekit',
            enabled: true,
            hostname: `meet.${baseDomain}`,
            path: '',
            originId: 'livekit-http',
            description: 'LiveKit signaling. Media remains explicit direct exposure.',
        },
    ];
}

export function normalizeOrigins(origins = DEFAULT_ORIGINS) {
    if (!Array.isArray(origins) || !origins.length) {
        throw new Error('origins must be a non-empty array.');
    }
    return origins.map((entry) => ({
        id: normalizeString(entry?.id),
        label: normalizeString(entry?.label),
        service: normalizeService(entry?.service),
        description: normalizeString(entry?.description),
    }));
}

export function normalizeRouteModel(input = {}) {
    const baseDomain = normalizeDomain(input.baseDomain);
    const origins = normalizeOrigins(input.origins || DEFAULT_ORIGINS);
    const originById = new Map(origins.map((origin) => [origin.id, origin]));
    const inputExposures = Array.isArray(input.exposures) && input.exposures.length
        ? input.exposures
        : defaultExposuresForDomain(baseDomain);
    const seen = new Set();
    const routes = inputExposures.map((entry, index) => {
        const originId = normalizeString(entry?.originId);
        const origin = originById.get(originId);
        if (!origin) throw new Error(`Unknown originId at exposure ${index + 1}: ${originId || '(empty)'}`);
        const hostname = normalizeHostname(entry?.hostname, { baseDomain });
        const pathPattern = normalizePathPattern(entry?.path);
        if (originId === 'onlyoffice') {
            const expectedHost = baseDomain ? `office.${baseDomain}` : 'office.localhost';
            if (hostname !== expectedHost || pathPattern) {
                throw new Error(`OnlyOffice editor exposure must use the canonical ${expectedHost} root route.`);
            }
        }
        if (originId === 'livekit-http' && pathPattern) {
            throw new Error('LiveKit signaling exposure must use the canonical /rtc route boundary and cannot declare a custom path.');
        }
        if (isTurnHostname(hostname)) {
            throw new Error(`TURN hostname ${hostname} is a DNS-only L4 endpoint and cannot be an HTTP exposure.`);
        }
        const key = `${hostname}\n${pathPattern}`;
        if (seen.has(key)) throw new Error(`Duplicate exposure for ${hostname}${pathPattern || '/'}.`);
        seen.add(key);
        const requestedService = normalizeString(entry?.service);
        const service = requestedService ? normalizeService(requestedService) : origin.service;
        if (service !== origin.service) {
            throw new Error(`Exposure service for origin ${originId} must equal ${origin.service}.`);
        }
        return {
            id: normalizeString(entry?.id) || `exposure_${index + 1}`,
            enabled: entry?.enabled !== false,
            hostname,
            path: pathPattern,
            originId,
            service,
            description: normalizeString(entry?.description),
        };
    });
    for (const livekitRoute of routes.filter((route) => route.originId === 'livekit-http')) {
        if (routes.some((route) => route.hostname === livekitRoute.hostname && route.originId !== 'livekit-http')) {
            throw new Error(`LiveKit signaling hostname ${livekitRoute.hostname} cannot be shared with another HTTP origin.`);
        }
    }
    return { routes, origins };
}

// Deployment env is the active topology contract. Persisted dashboard state is
// a base layer, but it must not make the provider, supervisor, and status tools
// disagree after a deployment changes canonical hostnames or public addresses.
export function mergePublishingConfig(saved = {}, env = {}, secretState = {}) {
    const scopedToken = env.WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN
        || env.TUNNEL_TOKEN
        || secretState.tunnelToken;
    const envConfig = {
        mode: env.WEB_PUBLISHING_MODE,
        tlsEdge: env.WEB_PUBLISHING_TLS_EDGE,
        baseDomain: env.WEB_PUBLISHING_BASE_DOMAIN,
        publicUrl: env.WEB_PUBLISHING_PUBLIC_URL,
        livekitMediaIp: env.WEB_PUBLISHING_LIVEKIT_MEDIA_IP,
        turnExternalIp: env.WEB_PUBLISHING_TURN_EXTERNAL_IP,
        tunnel: {
            source: scopedToken ? 'token' : undefined,
            tokenSet: scopedToken ? true : undefined,
            tunnelId: env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID || secretState.tunnelId,
            tunnelName: env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_NAME || secretState.tunnelName,
        },
    };
    const savedConfig = { ...saved };
    if (Array.isArray(saved.exposures)) {
        // Normalized status persisted by older releases contains the service
        // selected from originId. That value is derived, not an operator-owned
        // override: route validation has always required it to equal the origin.
        // Drop the persisted copy so a canonical origin migration (notably the
        // LiveKit move from host gateway to its network-scoped DNS identity) cannot make
        // a same-domain upgrade fail after the old stack has been stopped.
        savedConfig.exposures = saved.exposures.map((exposure) => {
            if (!exposure || typeof exposure !== 'object' || Array.isArray(exposure)) {
                return exposure;
            }
            const { service: _derivedService, ...operatorFields } = exposure;
            return operatorFields;
        });
    }
    const savedBaseDomain = normalizeString(saved.baseDomain).toLowerCase();
    const envBaseDomain = normalizeString(env.WEB_PUBLISHING_BASE_DOMAIN).toLowerCase();
    if (envBaseDomain && envBaseDomain !== savedBaseDomain) {
        // Normalized persisted exposures contain concrete hostnames. Reusing them
        // after an env-owned domain change would either publish the old domain or
        // fail validation against the new one, so regenerate the canonical set.
        delete savedConfig.exposures;
    }
    return {
        ...savedConfig,
        ...definedEntries(envConfig),
        tunnel: {
            ...(savedConfig.tunnel || {}),
            ...definedEntries(envConfig.tunnel),
        },
    };
}

export function normalizePublishingConfig(input = {}, env = {}) {
    const baseDomain = normalizeDomain(input.baseDomain || env.WEB_PUBLISHING_BASE_DOMAIN);
    const requestedExposures = Array.isArray(input.exposures) && input.exposures.length
        ? input.exposures
        : defaultExposuresForDomain(baseDomain);
    // Older saved state could persist only the LiveKit route. Add the canonical
    // Office route during normalization so upgrades replace the retired direct
    // OnlyOffice host-port URL instead of retaining or omitting it.
    const exposures = !requestedExposures.some(
        (entry) => normalizeString(entry?.originId) === 'onlyoffice',
    )
        ? [
            defaultExposuresForDomain(baseDomain).find(
                (entry) => entry.originId === 'onlyoffice',
            ),
            ...requestedExposures,
        ]
        : requestedExposures;
    const config = {
        version: 1,
        mode: normalizeMode(input.mode || env.WEB_PUBLISHING_MODE),
        tlsEdge: normalizeTlsEdge(input.tlsEdge || env.WEB_PUBLISHING_TLS_EDGE),
        baseDomain,
        publicUrl: normalizeString(input.publicUrl || env.WEB_PUBLISHING_PUBLIC_URL),
        livekitMediaIp: normalizeIpv4(
            input.livekitMediaIp || env.WEB_PUBLISHING_LIVEKIT_MEDIA_IP,
            'WebMeet media public IP',
        ),
        turnExternalIp: normalizeIpv4(
            input.turnExternalIp || env.WEB_PUBLISHING_TURN_EXTERNAL_IP,
            'TURN external IP',
        ),
        // The external proxy trust boundary is deployment-owned. Dashboard or MCP
        // drafts cannot broaden it: every trusted peer must come from explicit env
        // and must be one exact host address, never a bridge subnet containing
        // arbitrary sibling containers.
        externalProxyCidrs: normalizeExternalProxyCidrs(
            env.WEB_PUBLISHING_EXTERNAL_PROXY_CIDRS,
        ),
        tunnel: {
            source: normalizeString(input.tunnel?.source) || 'none',
            tokenSet: Boolean(input.tunnel?.tokenSet || env.WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN || env.TUNNEL_TOKEN),
            tunnelId: normalizeString(input.tunnel?.tunnelId || env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID),
            tunnelName: normalizeString(input.tunnel?.tunnelName || env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_NAME),
        },
        exposures,
    };
    const { routes } = normalizeRouteModel({
        baseDomain: config.baseDomain,
        exposures: config.exposures,
    });
    const livekitRoutes = routes.filter((route) => route.enabled && route.originId === 'livekit-http');
    if (livekitRoutes.length !== 1) {
        throw new Error('Web Publishing requires exactly one enabled LiveKit signaling exposure.');
    }
    const officeRoutes = routes.filter((route) => route.enabled && route.originId === 'onlyoffice');
    if (officeRoutes.length !== 1) {
        throw new Error('Web Publishing requires exactly one enabled OnlyOffice editor exposure.');
    }
    const livekitHost = livekitRoutes[0].hostname;
    const isLocal = !baseDomain && livekitHost === '127.0.0.1';
    if (!baseDomain && !isLocal) {
        throw new Error('A public LiveKit signaling exposure requires WEB_PUBLISHING_BASE_DOMAIN.');
    }
    if (isLocal) {
        if (officeRoutes[0].hostname !== 'office.localhost') {
            throw new Error('Local OnlyOffice publishing must use the canonical office.localhost hostname.');
        }
        if (config.mode !== 'nginx') {
            throw new Error('Local Web Publishing supports only nginx mode; Cloudflare modes require a public base domain.');
        }
        if (config.tlsEdge !== 'none') {
            throw new Error('Local Web Publishing must use WEB_PUBLISHING_TLS_EDGE=none.');
        }
        if (config.livekitMediaIp || config.turnExternalIp) {
            throw new Error('Local Web Publishing must not declare public media or TURN IP addresses.');
        }
    } else {
        const expectedHost = `meet.${baseDomain}`;
        if (livekitHost !== expectedHost) {
            throw new Error(`Public LiveKit signaling hostname must be the canonical ${expectedHost}.`);
        }
        if (config.tlsEdge === 'none') {
            throw new Error('Public WebMeet signaling requires an explicit trusted TLS edge contract.');
        }
        if (modeUsesCloudflare(config.mode) && config.tlsEdge !== 'cloudflare') {
            throw new Error('Cloudflare publishing modes require WEB_PUBLISHING_TLS_EDGE=cloudflare.');
        }
        if (!modeUsesCloudflare(config.mode) && config.tlsEdge !== 'external') {
            throw new Error('nginx public publishing requires WEB_PUBLISHING_TLS_EDGE=external.');
        }
        if (!config.livekitMediaIp) {
            throw new Error('WEB_PUBLISHING_LIVEKIT_MEDIA_IP is required for public WebMeet media.');
        }
        if (!config.turnExternalIp) {
            throw new Error('WEB_PUBLISHING_TURN_EXTERNAL_IP is required for the DNS-only TURN endpoint.');
        }
        if (config.tlsEdge === 'external' && !config.externalProxyCidrs.length) {
            throw new Error('WEB_PUBLISHING_EXTERNAL_PROXY_CIDRS is required for an external TLS edge.');
        }
    }
    return {
        ...config,
        exposures: routes,
    };
}

export function isTurnHostname(hostname) {
    return /^turn\./i.test(normalizeString(hostname));
}

export function buildCloudflaredIngress(routes) {
    const turnRoute = routes.find((route) => route?.enabled && isTurnHostname(route.hostname));
    if (turnRoute) {
        throw new Error(`TURN hostname ${turnRoute.hostname} must not be published through the Cloudflare HTTP tunnel; use a DNS-only record instead.`);
    }
    const hostnameOrder = new Map();
    for (const route of routes) {
        if (!route?.enabled || hostnameOrder.has(route.hostname)) continue;
        hostnameOrder.set(route.hostname, hostnameOrder.size);
    }
    const ingress = routes
        .filter((route) => route.enabled)
        .map((route, index) => ({ route, index }))
        .sort((left, right) => {
            if (left.route.hostname !== right.route.hostname) {
                return (hostnameOrder.get(left.route.hostname) ?? left.index)
                    - (hostnameOrder.get(right.route.hostname) ?? right.index);
            }
            const leftPath = left.route.path || '';
            const rightPath = right.route.path || '';
            if (leftPath && rightPath && leftPath.length !== rightPath.length) {
                return rightPath.length - leftPath.length;
            }
            if (leftPath && !rightPath) return -1;
            if (!leftPath && rightPath) return 1;
            return left.index - right.index;
        })
        .map(({ route }) => ({
            hostname: route.hostname,
            ...(route.path ? { path: route.path } : {}),
            service: route.originId === 'livekit-http' ? CLOUDFLARE_NGINX_ORIGIN : route.service,
        }));
    ingress.push({ service: 'http_status:404' });
    return ingress;
}

export function buildTurnDnsRecord(config) {
    if (!config?.baseDomain) return null;
    const content = normalizeIpv4(config.turnExternalIp, 'TURN external IP');
    if (!content) throw new Error('TURN external IP is required before planning the DNS-only TURN endpoint.');
    return {
        type: 'A',
        name: `turn.${config.baseDomain}`,
        content,
        ttl: 1,
        proxied: false,
    };
}

function publicUrlForRoute(route, scheme = 'https') {
    if (!route?.hostname) return '';
    return `${scheme}://${route.hostname}`;
}

function addValue(values, name, value, { sensitive = false, source = 'generated' } = {}) {
    const normalized = normalizeString(value);
    if (!normalized || GENERATED_SECRET_NAMES.has(name) || name.startsWith('PLOINKY_AGENT_')) return;
    values.push({ name, value: normalized, sensitive, source });
}

export function buildProviderValues(config, env = {}) {
    const values = [];
    const routes = config.exposures || [];
    const byOrigin = new Map();
    for (const route of routes) {
        if (!route.enabled || byOrigin.has(route.originId)) continue;
        byOrigin.set(route.originId, route);
    }
    const explorerRoute = byOrigin.get('router');
    const officeRoute = byOrigin.get('onlyoffice');
    const livekitRoute = byOrigin.get('livekit-http');
    const explorerUrl = config.publicUrl || publicUrlForRoute(explorerRoute);
    const officeUrl = config.baseDomain
        ? publicUrlForRoute(officeRoute)
        : `http://${officeRoute.hostname}:${DEFAULT_LISTEN_PORT}`;
    const livekitHost = livekitRoute?.hostname || '';
    const trustedTls = config.tlsEdge === 'cloudflare' || config.tlsEdge === 'external';
    if (config.baseDomain && !trustedTls) {
        throw new Error('Refusing to advertise wss:// without an explicit trusted TLS edge contract.');
    }
    const livekitPublicUrl = trustedTls
        ? `wss://${livekitHost}`
        : `ws://127.0.0.1:${DEFAULT_LISTEN_PORT}`;
    const livekitUpstream = livekitRoute.service;
    // OnlyOfficeAgent consumes this value inside the same container. Its editor
    // proxy must target the bundled Document Server, not loop back through its
    // own network-scoped DNS identity. Cross-container Web Publishing traffic uses
    // onlyoffice:8080 through DEFAULT_ORIGINS above.
    const officeInternal = 'http://127.0.0.1:80';
    // TURN host is derived independently from the signaling/TLS hostname: it mirrors how the
    // LiveKit route already builds `meet.<baseDomain>`, using its own `turn.` label, and must
    // never be reused/aliased from livekitHost (that was the hostname-conflation bug).
    // Emit the local default explicitly. Ploinky provider application updates
    // named values but does not infer deletion from an omitted output, so an
    // empty local value would leave a stale public TURN hostname in place.
    const turnHost = config.baseDomain ? `turn.${config.baseDomain}` : '127.0.0.1';

    addValue(values, 'ONLYOFFICE_PUBLIC_URL', officeUrl);
    addValue(values, 'ONLYOFFICE_INTERNAL_URL', officeInternal, { source: 'default' });
    addValue(values, 'ONLYOFFICE_CALLBACK_BASE_URL', explorerUrl);
    addValue(values, 'WEBMEET_PUBLIC_LIVEKIT_URL', livekitPublicUrl);
    addValue(values, 'WEBMEET_LIVEKIT_URL', livekitUpstream, { source: 'default' });
    addValue(values, 'WEBMEET_LIVEKIT_NODE_IP', config.livekitMediaIp, { source: 'explicit' });
    addValue(values, 'WEBMEET_TURN_HOST', turnHost);
    addValue(values, 'WEBMEET_TURN_EXTERNAL_IP', config.turnExternalIp, { source: 'explicit' });
    addValue(
        values,
        'WEBMEET_TURN_ALLOWED_PEER_IPS',
        config.livekitMediaIp ? `${config.livekitMediaIp}/32` : '',
        { source: 'explicit' },
    );
    const scopedToken = normalizeString(env.WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN || env.TUNNEL_TOKEN);
    addValue(values, 'WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN', scopedToken, {
        sensitive: true,
        source: 'tunnel-token',
    });
    addValue(values, 'WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID', config.tunnel?.tunnelId || env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID, {
        source: 'cloudflare-api',
    });
    addValue(values, 'WEB_PUBLISHING_CLOUDFLARE_TUNNEL_NAME', config.tunnel?.tunnelName || env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_NAME, {
        source: 'cloudflare-api',
    });

    return values;
}

export function buildProviderWarnings(config) {
    const warnings = [];
    if (!config.baseDomain) {
        warnings.push('Local browser routes are available at http://office.localhost:8081 and ws://127.0.0.1:8081/rtc; public topology is not configured.');
    }
    if (modeUsesCloudflare(config.mode) && (config.exposures || []).some((entry) => entry.originId === 'livekit-http')) {
        warnings.push('Cloudflare HTTP tunnels can publish LiveKit signaling, but LiveKit/TURN UDP media still requires explicit direct media-plane exposure.');
    }
    if (config.baseDomain) {
        warnings.push(`The DNS-only TURN A record turn.${config.baseDomain} must resolve directly to ${config.turnExternalIp} with proxying disabled.`);
    }
    if (config.tlsEdge === 'external') {
        warnings.push(`The trusted external TLS proxy must send meet.${config.baseDomain} to the loopback-published Nginx connector at 127.0.0.1:${EXTERNAL_NGINX_LISTEN_PORT}, have its original socket address listed in WEB_PUBLISHING_EXTERNAL_PROXY_CIDRS, and overwrite X-Real-IP with the validated client address; raw port 8081 does not serve public LiveKit signaling.`);
    }
    if ((config.exposures || []).some((entry) => isTurnHostname(entry.hostname))) {
        warnings.push('TURN hostnames must never be published through nginx or the Cloudflare HTTP tunnel; configure them as DNS-only (grey-cloud) records pointed directly at the TURN server instead.');
    }
    return warnings;
}
