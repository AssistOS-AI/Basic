const WEB_PUBLISHING_MCP_PATH = '/web-publishing/mcp';

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function scopedDocument(element) {
    return {
        getElementById(id) {
            return element?.querySelector?.(`#${id}`) || null;
        },
    };
}

export class WebPublishingSettings {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.documentRef = scopedDocument(element);
        this.bound = false;
        this.invalidate?.();
    }

    beforeRender() {}

    afterRender() {
        this.bindEvents();
        refreshPublishingState({ documentRef: this.documentRef })
            .catch((error) => setStatus(error?.message || 'Refresh failed', this.documentRef));
    }

    bindEvents() {
        if (this.bound) {
            return;
        }
        this.bound = true;
        this.documentRef.getElementById('webPublishingRefresh')?.addEventListener('click', () => {
            refreshPublishingState({ documentRef: this.documentRef })
                .catch((error) => setStatus(error?.message || 'Refresh failed', this.documentRef));
        });
        this.documentRef.getElementById('webPublishingValidate')?.addEventListener('click', () => {
            validatePublishingConfig({ documentRef: this.documentRef })
                .catch((error) => setStatus(error?.message || 'Validation failed', this.documentRef));
        });
        this.documentRef.getElementById('webPublishingApply')?.addEventListener('click', () => {
            applyPublishingConfig({ documentRef: this.documentRef })
                .catch((error) => setStatus(error?.message || 'Apply failed', this.documentRef));
        });
    }
}

export function normalizeExposureDrafts(drafts = []) {
    if (!Array.isArray(drafts)) return [];
    return drafts
        .filter((entry) => entry && entry.enabled !== false)
        .map((entry) => {
            const hostname = text(entry.hostname).toLowerCase();
            const originId = text(entry.originId);
            if (!hostname || !originId) return null;
            const rawPath = text(entry.path);
            return {
                id: text(entry.id) || undefined,
                enabled: true,
                hostname,
                path: rawPath ? (rawPath.startsWith('/') ? rawPath : `/${rawPath}`) : '',
                originId,
                description: text(entry.description),
            };
        })
        .filter(Boolean);
}

export function parseWebPublishingToolPayload(payload) {
    if (payload?.isError) {
        const errorText = Array.isArray(payload.content)
            ? payload.content.find((entry) => entry?.type === 'text')?.text
            : '';
        return { ok: false, error: errorText || 'Web Publishing MCP tool failed.' };
    }
    const textContent = Array.isArray(payload?.content)
        ? payload.content.find((entry) => entry?.type === 'text')?.text
        : '';
    try {
        return textContent ? JSON.parse(textContent) : {};
    } catch {
        return { ok: false, error: textContent || 'Web Publishing returned invalid JSON.' };
    }
}

export function shouldCreateDnsRecords(checkbox) {
    return Boolean(checkbox?.checked);
}

function setStatus(message, documentRef = (typeof document === 'undefined' ? null : document)) {
    const target = documentRef?.getElementById?.('webPublishingStatus');
    if (target) target.textContent = message;
}

function setTextById(documentRef, id, value) {
    const target = documentRef?.getElementById?.(id);
    if (target) target.textContent = value;
}

function presence(value) {
    return value ? 'present' : 'missing';
}

export function modeUsesCloudflareApply(mode, createDnsRecords = false) {
    const normalized = text(mode).toLowerCase();
    return normalized === 'cloudflare-api' || createDnsRecords === true;
}

export function draftConfigFromDocument(documentRef = document) {
    const tunnelSource = documentRef?.getElementById?.('webPublishingTunnelSource')?.value || '';
    const tunnelTokenSet = documentRef?.getElementById?.('webPublishingTunnelTokenSet')?.value === 'true';
    const tunnelId = documentRef?.getElementById?.('webPublishingTunnelId')?.value || '';
    const tunnelName = documentRef?.getElementById?.('webPublishingTunnelName')?.value || '';
    return {
        mode: documentRef?.getElementById?.('webPublishingMode')?.value || 'nginx',
        tlsEdge: documentRef?.getElementById?.('webPublishingTlsEdge')?.value || 'none',
        baseDomain: documentRef?.getElementById?.('webPublishingBaseDomain')?.value || '',
        livekitMediaIp: documentRef?.getElementById?.('webPublishingLivekitMediaIp')?.value || '',
        turnExternalIp: documentRef?.getElementById?.('webPublishingTurnExternalIp')?.value || '',
        tunnel: {
            source: tunnelSource,
            tokenSet: tunnelTokenSet,
            tunnelId,
            tunnelName,
        },
    };
}

export function updateStateIndicators(result = {}, documentRef = document) {
    const config = result.config || {};
    const cloudflare = result.cloudflare || config.cloudflare || {};
    const secrets = result.secrets || {};
    const tunnel = config.tunnel || {};
    setTextById(documentRef, 'webPublishingApiTokenState', presence(cloudflare.apiTokenConfigured));
    setTextById(documentRef, 'webPublishingAccountState', presence(cloudflare.accountIdConfigured));
    setTextById(documentRef, 'webPublishingZoneState', presence(cloudflare.zoneIdConfigured));
    setTextById(documentRef, 'webPublishingTunnelTokenState', presence(tunnel.tokenSet || secrets.tunnelTokenSet));
}

async function callMcp(tool, input = {}) {
    const mcpClientFactory = await import('/MCPBrowserClient.js').catch(() => null);
    if (mcpClientFactory && typeof mcpClientFactory.createAgentClient === 'function') {
        const client = mcpClientFactory.createAgentClient(WEB_PUBLISHING_MCP_PATH);
        return parseWebPublishingToolPayload(await client.callTool(tool, input));
    }
    const win = typeof window === 'undefined' ? null : window;
    if (!win?.AssistOS?.callTool) {
        setStatus('MCP bridge unavailable');
        return { ok: false };
    }
    const response = await win.AssistOS.callTool(tool, input);
    return parseWebPublishingToolPayload(response);
}

export async function refreshPublishingState({
    invokeTool = callMcp,
    documentRef = document,
} = {}) {
    const result = await invokeTool('web_publishing_status');
    if (result.ok) {
        const config = result.config || {};
        const mode = documentRef?.getElementById?.('webPublishingMode');
        const tlsEdge = documentRef?.getElementById?.('webPublishingTlsEdge');
        const baseDomain = documentRef?.getElementById?.('webPublishingBaseDomain');
        const livekitMediaIp = documentRef?.getElementById?.('webPublishingLivekitMediaIp');
        const turnExternalIp = documentRef?.getElementById?.('webPublishingTurnExternalIp');
        const tunnelSource = documentRef?.getElementById?.('webPublishingTunnelSource');
        const tunnelTokenSet = documentRef?.getElementById?.('webPublishingTunnelTokenSet');
        const tunnelId = documentRef?.getElementById?.('webPublishingTunnelId');
        const tunnelName = documentRef?.getElementById?.('webPublishingTunnelName');
        if (mode && config.mode) mode.value = config.mode;
        if (tlsEdge && config.tlsEdge) tlsEdge.value = config.tlsEdge;
        if (baseDomain && config.baseDomain) baseDomain.value = config.baseDomain;
        if (livekitMediaIp) livekitMediaIp.value = config.livekitMediaIp || '';
        if (turnExternalIp) turnExternalIp.value = config.turnExternalIp || '';
        if (tunnelSource) tunnelSource.value = config.tunnel?.source || '';
        if (tunnelTokenSet) tunnelTokenSet.value = config.tunnel?.tokenSet ? 'true' : 'false';
        if (tunnelId) tunnelId.value = config.tunnel?.tunnelId || '';
        if (tunnelName) tunnelName.value = config.tunnel?.tunnelName || '';
        updateStateIndicators(result, documentRef);
        setStatus(
            `Mode ${config.mode || 'unknown'} · state ${result.status?.state || 'unknown'}`,
            documentRef,
        );
    } else {
        setStatus(result.error || 'Refresh failed', documentRef);
    }
    return result;
}

export async function validatePublishingConfig({
    invokeTool = callMcp,
    documentRef = document,
} = {}) {
    const config = draftConfigFromDocument(documentRef);
    const result = await invokeTool('web_publishing_config_validate', { config });
    setStatus(result.ok ? 'Valid' : result.error || 'Invalid', documentRef);
    return result;
}

export async function applyPublishingConfig({
    invokeTool = callMcp,
    documentRef = document,
} = {}) {
    const config = draftConfigFromDocument(documentRef);
    const createDnsRecords = shouldCreateDnsRecords(documentRef?.getElementById?.('webPublishingCreateDns'));
    const saved = await invokeTool('web_publishing_config_apply', { config });
    if (!saved.ok) {
        setStatus(saved.error || 'Save failed', documentRef);
        return saved;
    }
    updateStateIndicators(saved, documentRef);
    if (saved.restartRequired) {
        setStatus('Saved; restart Web Publishing to apply', documentRef);
        return saved;
    }
    if (!modeUsesCloudflareApply(config.mode, createDnsRecords)) {
        setStatus('Applied', documentRef);
        return saved;
    }
    const applied = await invokeTool('web_publishing_cloudflare_tunnel_apply', {
        config,
        createDnsRecords,
    });
    updateStateIndicators(applied, documentRef);
    setStatus(
        applied.ok && applied.applied
            ? 'Applied'
            : applied.error || (applied.restartRequired ? 'Restart required' : 'Apply failed'),
        documentRef,
    );
    return applied;
}

if (typeof document !== 'undefined') {
    document.getElementById('webPublishingRefresh')?.addEventListener('click', () => {
        refreshPublishingState().catch((error) => setStatus(error?.message || 'Refresh failed'));
    });
    document.getElementById('webPublishingValidate')?.addEventListener('click', () => {
        validatePublishingConfig().catch((error) => setStatus(error?.message || 'Validation failed'));
    });
    document.getElementById('webPublishingApply')?.addEventListener('click', () => {
        applyPublishingConfig().catch((error) => setStatus(error?.message || 'Apply failed'));
    });
}
