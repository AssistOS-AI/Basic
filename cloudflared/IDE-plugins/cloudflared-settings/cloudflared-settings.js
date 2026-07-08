const CLOUDFLARED_MCP_PATH = '/cloudflared/mcp';
const DEFAULT_ORIGINS = Object.freeze([
    Object.freeze({
        id: 'router',
        label: 'Ploinky router',
        service: 'http://host.containers.internal:8080'
    }),
    Object.freeze({
        id: 'onlyoffice',
        label: 'OnlyOffice Document Server',
        service: 'http://host.containers.internal:8082'
    })
]);

function normalizeString(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeRoutePath(value) {
    const raw = normalizeString(value);
    if (!raw) {
        return '';
    }
    return raw.startsWith('/') ? raw : `/${raw}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function extractToolText(result) {
    if (typeof result === 'string') {
        return result;
    }
    if (Array.isArray(result?.content)) {
        return result.content
            .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
            .map((entry) => entry.text)
            .join('\n')
            .trim();
    }
    if (typeof result?.text === 'string') {
        return result.text;
    }
    return '';
}

function getErrorMessage(error) {
    return error?.message || String(error || 'Unknown error');
}

function formatJson(value) {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return '';
    }
}

function normalizeOrigin(entry) {
    return {
        id: normalizeString(entry?.id),
        label: normalizeString(entry?.label, normalizeString(entry?.id)),
        service: normalizeString(entry?.service),
        description: normalizeString(entry?.description)
    };
}

function normalizeOrigins(origins) {
    const normalized = Array.isArray(origins)
        ? origins.map(normalizeOrigin).filter((entry) => entry.id)
        : [];
    return normalized.length ? normalized : DEFAULT_ORIGINS.map(normalizeOrigin);
}

function routeToDraft(route = {}, index = 0, origins = DEFAULT_ORIGINS) {
    const fallbackOrigin = origins[0]?.id || 'router';
    return {
        id: normalizeString(route.id, `route_${index + 1}`),
        enabled: route.enabled !== false,
        hostname: normalizeString(route.hostname),
        path: normalizeString(route.path),
        originId: normalizeString(route.originId, fallbackOrigin),
        description: normalizeString(route.description)
    };
}

function summarizeCloudflareConfig(config = {}) {
    const hasApi = Boolean(config.apiTokenConfigured && config.accountIdConfigured && config.tunnelId);
    if (hasApi) {
        return 'Configured';
    }
    if (config.apiTokenConfigured || config.accountIdConfigured || config.tunnelId) {
        return 'Partial';
    }
    return 'Not configured';
}

function assertOkPayload(payload, toolName) {
    if (payload && payload.ok === false) {
        throw new Error(payload.error || payload.message || `${toolName} failed.`);
    }
    return payload;
}

export function shouldCreateDnsRecords(input) {
    return input?.checked === true;
}

export class CloudflaredSettings {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.props = element?.props || element?._componentProxy?.props || {};
        this.state = {
            status: 'Loading cloudflared status...',
            statusType: '',
            tunnelState: 'unknown',
            apiState: 'Loading',
            baseDomain: 'Any',
            origins: DEFAULT_ORIGINS.map(normalizeOrigin),
            routes: [routeToDraft({}, 0, DEFAULT_ORIGINS)],
            ingress: []
        };
        this.mcpClient = null;
        this.mcpClientPromise = null;
        this.bound = false;
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.cacheElements();
        this.bindEvents();
        this.render();
        this.loadStatus();
    }

    cacheElements() {
        this.tunnelStateEl = this.element.querySelector('#cloudflaredTunnelState');
        this.apiStateEl = this.element.querySelector('#cloudflaredApiState');
        this.baseDomainEl = this.element.querySelector('#cloudflaredBaseDomain');
        this.routesBody = this.element.querySelector('#cloudflaredRoutesBody');
        this.createDnsInput = this.element.querySelector('#cloudflaredCreateDns');
        this.ingressPreview = this.element.querySelector('#cloudflaredIngressPreview');
        this.statusEl = this.element.querySelector('#cloudflaredSettingsStatus');
    }

    bindEvents() {
        if (this.bound) {
            return;
        }
        this.bound = true;

        this.element.querySelector('[data-local-action="closeModal"]')?.addEventListener('click', () => {
            this.closeModal();
        });

        this.element.addEventListener('click', (event) => {
            const actionTarget = event.target?.closest?.('[data-route-action]');
            if (!actionTarget) {
                return;
            }
            const action = actionTarget.getAttribute('data-route-action');
            const row = actionTarget.closest('[data-route-row]');
            if (action === 'refresh') {
                this.loadStatus();
            } else if (action === 'add') {
                this.addRoute();
            } else if (action === 'remove') {
                this.removeRoute(Number(row?.dataset?.routeRow || -1));
            } else if (action === 'validate') {
                this.validateRoutes();
            } else if (action === 'apply') {
                this.applyRoutes();
            }
        });

        this.element.addEventListener('input', (event) => {
            if (event.target?.closest?.('[data-route-row]')) {
                this.state.status = '';
                this.state.statusType = '';
                this.renderStatus();
            }
        });
    }

    closeModal() {
        if (globalThis.assistOS?.UI?.closeModal) {
            globalThis.assistOS.UI.closeModal(this.element, null);
        }
    }

    async ensureMcpClient() {
        if (this.mcpClient) {
            return this.mcpClient;
        }
        if (this.mcpClientPromise) {
            return this.mcpClientPromise;
        }

        this.mcpClientPromise = (async () => {
            const module = await import('/MCPBrowserClient.js');
            if (!module || typeof module.createAgentClient !== 'function') {
                throw new Error('MCP browser client module is unavailable.');
            }
            this.mcpClient = module.createAgentClient(CLOUDFLARED_MCP_PATH);
            return this.mcpClient;
        })();

        try {
            return await this.mcpClientPromise;
        } finally {
            this.mcpClientPromise = null;
        }
    }

    async callCloudflared(toolName, args = {}) {
        const client = await this.ensureMcpClient();
        const toolResult = await client.callTool(toolName, args);
        return assertOkPayload(parseCloudflaredToolPayload(toolResult), toolName);
    }

    setBusy(isBusy) {
        this.element.classList.toggle('cloudflared-busy', Boolean(isBusy));
    }

    setStatus(message, statusType = '') {
        this.state.status = message;
        this.state.statusType = statusType;
        this.renderStatus();
    }

    loadStateFromStatus(payload) {
        const origins = normalizeOrigins(payload.origins);
        const routes = Array.isArray(payload.routes) && payload.routes.length
            ? payload.routes.map((route, index) => routeToDraft(route, index, origins))
            : [routeToDraft({}, 0, origins)];
        const tunnelStatus = payload.status || {};

        this.state.origins = origins;
        this.state.routes = routes;
        this.state.ingress = [];
        this.state.tunnelState = normalizeString(tunnelStatus.state, 'unknown');
        this.state.apiState = summarizeCloudflareConfig(payload.cloudflare || {});
        this.state.baseDomain = normalizeString(payload.baseDomain, 'Any');
    }

    async loadStatus() {
        this.setBusy(true);
        this.setStatus('Loading cloudflared status...');
        try {
            const payload = await this.callCloudflared('cloudflared_status');
            this.loadStateFromStatus(payload);
            const statusMessage = this.state.tunnelState === 'running'
                ? 'Cloudflared is running.'
                : `Cloudflared status: ${this.state.tunnelState}.`;
            this.render();
            this.setStatus(statusMessage, this.state.tunnelState === 'running' ? 'success' : 'warning');
        } catch (error) {
            this.setStatus(getErrorMessage(error), 'error');
        } finally {
            this.setBusy(false);
        }
    }

    addRoute() {
        this.state.routes = this.collectRouteDrafts();
        this.state.routes.push(routeToDraft({}, this.state.routes.length, this.state.origins));
        this.renderRoutes();
    }

    removeRoute(index) {
        if (!Number.isInteger(index) || index < 0) {
            return;
        }
        const routes = this.collectRouteDrafts();
        routes.splice(index, 1);
        this.state.routes = routes.length ? routes : [routeToDraft({}, 0, this.state.origins)];
        this.renderRoutes();
    }

    collectRouteDrafts() {
        if (!this.routesBody) {
            return this.state.routes;
        }
        const rows = Array.from(this.routesBody.querySelectorAll('[data-route-row]'));
        return rows.map((row, index) => ({
            id: normalizeString(row.dataset.routeId, `route_${index + 1}`),
            enabled: Boolean(row.querySelector('[data-route-field="enabled"]')?.checked),
            hostname: normalizeString(row.querySelector('[data-route-field="hostname"]')?.value),
            path: normalizeString(row.querySelector('[data-route-field="path"]')?.value),
            originId: normalizeString(row.querySelector('[data-route-field="originId"]')?.value),
            description: normalizeString(row.querySelector('[data-route-field="description"]')?.value)
        }));
    }

    collectNormalizedRoutes() {
        const routes = normalizeRouteDrafts(this.collectRouteDrafts());
        if (!routes.length) {
            throw new Error('Add at least one enabled route with a hostname and origin.');
        }
        return routes;
    }

    async validateRoutes() {
        let routes;
        try {
            routes = this.collectNormalizedRoutes();
        } catch (error) {
            this.setStatus(getErrorMessage(error), 'error');
            return;
        }

        this.setBusy(true);
        this.setStatus('Validating routes...');
        try {
            const payload = await this.callCloudflared('cloudflared_routes_validate', { routes });
            this.state.routes = Array.isArray(payload.routes) && payload.routes.length
                ? payload.routes.map((route, index) => routeToDraft(route, index, this.state.origins))
                : this.collectRouteDrafts();
            this.state.origins = normalizeOrigins(payload.origins);
            this.state.ingress = Array.isArray(payload.ingress) ? payload.ingress : [];
            this.render();
            this.setStatus('Routes validated.', 'success');
        } catch (error) {
            this.setStatus(getErrorMessage(error), 'error');
        } finally {
            this.setBusy(false);
        }
    }

    async applyRoutes() {
        let routes;
        try {
            routes = this.collectNormalizedRoutes();
        } catch (error) {
            this.setStatus(getErrorMessage(error), 'error');
            return;
        }

        this.setBusy(true);
        this.setStatus('Applying routes...');
        try {
            const payload = await this.callCloudflared('cloudflared_routes_apply', {
                routes,
                createDnsRecords: shouldCreateDnsRecords(this.createDnsInput)
            });
            this.state.routes = Array.isArray(payload.routes) && payload.routes.length
                ? payload.routes.map((route, index) => routeToDraft(route, index, this.state.origins))
                : this.collectRouteDrafts();
            this.state.origins = normalizeOrigins(payload.origins);
            this.state.ingress = Array.isArray(payload.ingress) ? payload.ingress : [];
            this.render();
            this.setStatus('Routes applied.', 'success');
        } catch (error) {
            this.setStatus(getErrorMessage(error), 'error');
        } finally {
            this.setBusy(false);
        }
    }

    render() {
        this.renderSummary();
        this.renderRoutes();
        this.renderIngress();
        this.renderStatus();
    }

    renderSummary() {
        if (this.tunnelStateEl) {
            this.tunnelStateEl.textContent = this.state.tunnelState;
        }
        if (this.apiStateEl) {
            this.apiStateEl.textContent = this.state.apiState;
        }
        if (this.baseDomainEl) {
            this.baseDomainEl.textContent = this.state.baseDomain;
        }
    }

    renderRoutes() {
        if (!this.routesBody) {
            return;
        }

        const rows = this.state.routes.length
            ? this.state.routes
            : [routeToDraft({}, 0, this.state.origins)];

        this.routesBody.innerHTML = rows
            .map((route, index) => this.renderRouteRow(route, index))
            .join('');
    }

    renderRouteRow(route, index) {
        const originOptions = this.state.origins.map((origin) => {
            const selected = origin.id === route.originId ? ' selected' : '';
            const label = origin.label || origin.id;
            return `<option value="${escapeHtml(origin.id)}"${selected}>${escapeHtml(label)}</option>`;
        }).join('');
        return `
            <tr data-route-row="${index}" data-route-id="${escapeHtml(route.id || '')}">
                <td>
                    <input data-route-field="enabled" type="checkbox"${route.enabled === false ? '' : ' checked'} aria-label="Enabled">
                </td>
                <td>
                    <input data-route-field="hostname" class="form-input" type="text" value="${escapeHtml(route.hostname)}" placeholder="app.example.com" spellcheck="false">
                </td>
                <td>
                    <input data-route-field="path" class="form-input" type="text" value="${escapeHtml(route.path)}" placeholder="/">
                </td>
                <td>
                    <select data-route-field="originId" class="form-input">${originOptions}</select>
                </td>
                <td>
                    <input data-route-field="description" class="form-input" type="text" value="${escapeHtml(route.description)}" placeholder="Route note">
                </td>
                <td>
                    <button type="button" class="general-button cloudflared-remove-button" data-route-action="remove" aria-label="Remove route">X</button>
                </td>
            </tr>
        `;
    }

    renderIngress() {
        if (this.ingressPreview) {
            this.ingressPreview.value = this.state.ingress.length ? formatJson(this.state.ingress) : '';
        }
    }

    renderStatus() {
        if (!this.statusEl) {
            return;
        }
        this.statusEl.textContent = this.state.status || '';
        this.statusEl.classList.toggle('success', this.state.statusType === 'success');
        this.statusEl.classList.toggle('error', this.state.statusType === 'error');
        this.statusEl.classList.toggle('warning', this.state.statusType === 'warning');
    }
}

export function normalizeRouteDrafts(drafts = []) {
    if (!Array.isArray(drafts)) {
        return [];
    }

    return drafts
        .map((route) => {
            if (!route || route.enabled === false) {
                return null;
            }
            const hostname = normalizeString(route.hostname).toLowerCase().replace(/\.+$/g, '');
            const originId = normalizeString(route.originId);
            if (!hostname || !originId) {
                return null;
            }
            const normalized = {};
            const id = normalizeString(route.id);
            const path = normalizeRoutePath(route.path);
            const description = normalizeString(route.description);
            if (id) {
                normalized.id = id;
            }
            normalized.enabled = true;
            normalized.hostname = hostname;
            if (path) {
                normalized.path = path;
            }
            normalized.originId = originId;
            if (description) {
                normalized.description = description;
            }
            return normalized;
        })
        .filter(Boolean);
}

export function parseCloudflaredToolPayload(payload) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && !Array.isArray(payload.content) && typeof payload.text !== 'string') {
        return payload;
    }

    const rawText = extractToolText(payload);
    if (!rawText) {
        return {};
    }

    try {
        const parsed = JSON.parse(rawText);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        throw new Error('Invalid cloudflared tool payload.');
    }
}
