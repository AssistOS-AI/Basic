function text(value) {
    return typeof value === 'string' ? value.trim() : '';
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
    return {
        mode: documentRef?.getElementById?.('webPublishingMode')?.value || 'nginx',
        baseDomain: documentRef?.getElementById?.('webPublishingBaseDomain')?.value || '',
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
    if (!window.AssistOS?.callTool) {
        setStatus('MCP bridge unavailable');
        return { ok: false };
    }
    const response = await window.AssistOS.callTool(tool, input);
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
        const baseDomain = documentRef?.getElementById?.('webPublishingBaseDomain');
        if (mode && config.mode) mode.value = config.mode;
        if (baseDomain && config.baseDomain) baseDomain.value = config.baseDomain;
        updateStateIndicators(result, documentRef);
        setStatus(`Mode ${config.mode || 'unknown'}`, documentRef);
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
    if (!modeUsesCloudflareApply(config.mode, createDnsRecords)) {
        setStatus('Saved', documentRef);
        return saved;
    }
    const applied = await invokeTool('web_publishing_cloudflare_tunnel_apply', {
        config,
        createDnsRecords,
    });
    updateStateIndicators(applied, documentRef);
    setStatus(applied.ok ? 'Applied' : applied.error || 'Apply failed', documentRef);
    return applied;
}

if (typeof document !== 'undefined') {
    document.getElementById('webPublishingRefresh')?.addEventListener('click', () => refreshPublishingState());
    document.getElementById('webPublishingValidate')?.addEventListener('click', () => validatePublishingConfig());
    document.getElementById('webPublishingApply')?.addEventListener('click', () => applyPublishingConfig());
}
