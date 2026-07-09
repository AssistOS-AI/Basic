const HOST_GATEWAY = 'host.containers.internal';
const DEFAULT_LISTEN_PORT = 8081;

const DEFAULT_ORIGINS = [
    {
        id: 'router',
        label: 'Ploinky router',
        service: `http://${HOST_GATEWAY}:8080`,
        description: 'Explorer and router-hosted HTTP/WebSocket surfaces.',
    },
    {
        id: 'onlyoffice',
        label: 'OnlyOffice Document Server',
        service: `http://${HOST_GATEWAY}:8082`,
        description: 'OnlyOffice editor origin.',
    },
    {
        id: 'livekit-http',
        label: 'LiveKit HTTP signaling',
        service: `http://${HOST_GATEWAY}:7880`,
        description: 'LiveKit HTTP/WebSocket signaling origin. UDP/TURN media remains direct.',
    },
    {
        id: 'webmeet-static',
        label: 'WebMeet static surface',
        service: `http://${HOST_GATEWAY}:3001`,
        description: 'Optional WebMeet application/static origin.',
    },
];

const GENERATED_SECRET_NAMES = new Set([
    'WEBMEET_LIVEKIT_API_KEY',
    'WEBMEET_LIVEKIT_API_SECRET',
    'WEBMEET_TURN_PASSWORD',
    'PLOINKY_WEBMEET_MASTER_KEY',
    'ONLYOFFICE_JWT_SECRET',
    'JWT_SECRET',
]);

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeMode(value) {
    const mode = normalizeString(value).toLowerCase();
    if (!mode) return 'nginx';
    if (['nginx', 'token', 'cloudflare-token', 'cloudflare-api', 'nginx-cloudflare'].includes(mode)) {
        return mode === 'token' ? 'cloudflare-token' : mode;
    }
    throw new Error(`Unsupported Web Publishing mode: ${value}`);
}

function normalizeDomain(value) {
    const raw = normalizeString(value).toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!raw) return '';
    if (!/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/.test(raw)) {
        throw new Error(`Invalid base domain: ${value}`);
    }
    return raw;
}

function normalizeHostname(value, { baseDomain = '' } = {}) {
    const raw = normalizeDomain(value);
    if (!raw) throw new Error('Exposure hostname is required.');
    if (raw.includes('*')) throw new Error('Wildcard hostnames are not enabled for Web Publishing.');
    if (baseDomain && raw !== baseDomain && !raw.endsWith(`.${baseDomain}`)) {
        throw new Error(`Hostname ${raw} must be under ${baseDomain}.`);
    }
    return raw;
}

function normalizePathPattern(value) {
    const raw = normalizeString(value);
    if (!raw) return '';
    const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
    if (/[\u0000-\u001f]/.test(withSlash)) {
        throw new Error('Exposure path contains control characters.');
    }
    if (withSlash.length > 256) {
        throw new Error('Exposure path must be at most 256 characters.');
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
    if (parsed.hostname !== HOST_GATEWAY && parsed.hostname !== '127.0.0.1') {
        throw new Error(`Exposure service host must be ${HOST_GATEWAY} or 127.0.0.1.`);
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
    if (!baseDomain) return [];
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
    return { routes, origins };
}

export function normalizePublishingConfig(input = {}, env = {}) {
    const baseDomain = normalizeDomain(input.baseDomain || env.WEB_PUBLISHING_BASE_DOMAIN);
    const config = {
        version: 1,
        mode: normalizeMode(input.mode || env.WEB_PUBLISHING_MODE),
        baseDomain,
        publicUrl: normalizeString(input.publicUrl || env.WEB_PUBLISHING_PUBLIC_URL),
        publicHost: normalizeDomain(input.publicHost || env.WEB_PUBLISHING_PUBLIC_HOST),
        lanHost: normalizeString(input.lanHost) || '127.0.0.1',
        listenPort: Number(input.listenPort || DEFAULT_LISTEN_PORT),
        certEmail: normalizeString(input.certEmail || env.WEB_PUBLISHING_CERT_EMAIL),
        tunnel: {
            source: normalizeString(input.tunnel?.source) || 'none',
            tokenSet: Boolean(input.tunnel?.tokenSet || env.WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN || env.TUNNEL_TOKEN),
            tunnelId: normalizeString(input.tunnel?.tunnelId || env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID),
            tunnelName: normalizeString(input.tunnel?.tunnelName || env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_NAME),
        },
        exposures: Array.isArray(input.exposures) && input.exposures.length
            ? input.exposures
            : defaultExposuresForDomain(baseDomain),
    };
    const { routes } = normalizeRouteModel({
        baseDomain: config.baseDomain,
        exposures: config.exposures,
    });
    return {
        ...config,
        exposures: routes,
    };
}

export function buildCloudflaredIngress(routes) {
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
            service: route.service,
        }));
    ingress.push({ service: 'http_status:404' });
    return ingress;
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
    const officeUrl = publicUrlForRoute(officeRoute);
    const livekitHost = livekitRoute?.hostname || config.publicHost;
    const livekitPublicUrl = livekitHost ? `wss://${livekitHost}` : '';
    const livekitUpstream = livekitRoute?.service || `http://${HOST_GATEWAY}:7880`;
    const officeInternal = `http://${HOST_GATEWAY}:8082`;

    addValue(values, 'ONLYOFFICE_PUBLIC_URL', officeUrl);
    addValue(values, 'ONLYOFFICE_INTERNAL_URL', officeInternal, { source: 'default' });
    addValue(values, 'ONLYOFFICE_CALLBACK_BASE_URL', explorerUrl);
    addValue(values, 'WEBMEET_PUBLIC_LIVEKIT_URL', livekitPublicUrl);
    addValue(values, 'WEBMEET_LIVEKIT_URL', livekitUpstream, { source: 'default' });
    addValue(values, 'WEBMEET_TLS_HOSTNAME', livekitHost);
    addValue(values, 'WEBMEET_TURN_HOST', livekitHost);
    addValue(values, 'WEBMEET_TURN_EXTERNAL_IP', config.publicHost);
    addValue(values, 'WEBMEET_TURN_REALM', livekitHost || config.baseDomain);
    addValue(values, 'WEBMEET_CERT_EMAIL', config.certEmail, { source: 'explicit' });
    addValue(values, 'WEBMEET_LIVEKIT_UPSTREAM', livekitUpstream, { source: 'default' });

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
    if (!config.baseDomain && !config.publicUrl && !config.publicHost) {
        warnings.push('A base domain or explicit public host settings are needed before public topology can be generated.');
    }
    if (String(config.mode || '').includes('cloudflare') && (config.exposures || []).some((entry) => entry.originId === 'livekit-http')) {
        warnings.push('Cloudflare HTTP tunnels can publish LiveKit signaling, but LiveKit/TURN UDP media still requires explicit direct media-plane exposure.');
    }
    return warnings;
}
