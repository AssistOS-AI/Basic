import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const defaultConfigFile = '/data/config.json';
export const defaultStatusFile = '/data/status.json';
export const defaultSecretStateFile = '/data/secret-state.json';
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code !== 'ESRCH';
    }
}

function participantPid(fileName) {
    const match = fileName.match(/\.(?:choosing|ticket)\.(\d+)-/);
    return match ? Number(match[1]) : NaN;
}

async function listLockParticipants(lockFile, kind) {
    const directory = path.dirname(lockFile);
    const prefix = `${path.basename(lockFile)}.${kind}.`;
    try {
        const names = (await fs.readdir(directory)).filter((name) => name.startsWith(prefix));
        const participants = [];
        for (const name of names) {
            const filePath = path.join(directory, name);
            try {
                const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
                participants.push({ filePath, name, payload });
            } catch (error) {
                if (error?.code !== 'ENOENT') {
                    participants.push({
                        filePath,
                        name,
                        payload: { pid: participantPid(name), ticket: 0, invalid: true },
                    });
                }
            }
        }
        return participants;
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
}

async function liveLockParticipants(lockFile, kind) {
    const participants = await listLockParticipants(lockFile, kind);
    const live = [];
    for (const participant of participants) {
        if (processIsAlive(Number(participant.payload.pid))) {
            live.push(participant);
        } else {
            // Participant paths contain a per-attempt UUID and are never reused,
            // so deleting a dead owner's unique file cannot unlink a successor.
            await fs.unlink(participant.filePath).catch((error) => {
                if (error?.code !== 'ENOENT') throw error;
            });
        }
    }
    return live;
}

export async function withFileLock(lockFile, operation, {
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    retryMs = 10,
} = {}) {
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    const deadline = Date.now() + timeoutMs;
    const participantId = `${process.pid}-${randomUUID()}`;
    const choosingFile = `${lockFile}.choosing.${participantId}`;
    const ticketFile = `${lockFile}.ticket.${participantId}`;
    const owner = {
        id: participantId,
        pid: process.pid,
        createdAt: new Date().toISOString(),
    };
    await fs.writeFile(choosingFile, `${JSON.stringify(owner)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
    });
    try {
        const existingTickets = await liveLockParticipants(lockFile, 'ticket');
        const ticket = existingTickets.reduce(
            (maximum, participant) => Math.max(maximum, Number(participant.payload.ticket) || 0),
            0,
        ) + 1;
        await fs.writeFile(ticketFile, `${JSON.stringify({ ...owner, ticket })}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        await fs.unlink(choosingFile);

        while (true) {
            const choosing = await liveLockParticipants(lockFile, 'choosing');
            const tickets = await liveLockParticipants(lockFile, 'ticket');
            const predecessor = tickets.some((participant) => {
                if (participant.payload.id === participantId) return false;
                if (participant.payload.invalid) return true;
                const otherTicket = Number(participant.payload.ticket);
                return otherTicket < ticket
                    || (otherTicket === ticket && String(participant.payload.id) < participantId);
            });
            if (!choosing.length && !predecessor) break;
            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for Web Publishing state lock: ${path.basename(lockFile)}`);
            }
            await sleep(retryMs);
        }
        return await operation();
    } finally {
        await Promise.all([choosingFile, ticketFile].map((filePath) => (
            fs.unlink(filePath).catch((error) => {
                if (error?.code !== 'ENOENT') throw error;
            })
        )));
    }
}

function dataFileFromEnv(env, key, defaultFile, fileName) {
    const configured = env[key] || '';
    if (env.PLOINKY_PROVIDER_DATA_DIR && (!configured || configured === defaultFile)) {
        return path.join(env.PLOINKY_PROVIDER_DATA_DIR, fileName);
    }
    return configured || defaultFile;
}

export function configFileFromEnv(env = process.env) {
    return dataFileFromEnv(env, 'WEB_PUBLISHING_CONFIG_FILE', defaultConfigFile, 'config.json');
}

export function statusFileFromEnv(env = process.env) {
    return dataFileFromEnv(env, 'WEB_PUBLISHING_STATUS_FILE', defaultStatusFile, 'status.json');
}

export function secretStateFileFromEnv(env = process.env) {
    return dataFileFromEnv(env, 'WEB_PUBLISHING_SECRET_STATE_FILE', defaultSecretStateFile, 'secret-state.json');
}

export async function readJsonFile(filePath, fallback) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return fallback;
        throw error;
    }
}

export async function writeJsonFile(filePath, payload, { mode } = {}) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        ...(mode ? { mode } : {}),
    });
    if (mode) await fs.chmod(tempPath, mode);
    await fs.rename(tempPath, filePath);
    if (mode) await fs.chmod(filePath, mode);
    return payload;
}

export async function readConfig({ env = process.env } = {}) {
    // An absent file means "no saved dashboard override". Supplying normalized
    // local defaults here would outrank deployment env in normalizePublishingConfig
    // and break the first production start before the dashboard has saved anything.
    return readJsonFile(configFileFromEnv(env), {});
}

export async function writeConfig(config, { env = process.env } = {}) {
    const filePath = configFileFromEnv(env);
    return withFileLock(`${filePath}.lock`, () => writeJsonFile(filePath, {
        version: 1,
        updatedAt: new Date().toISOString(),
        ...config,
    }));
}

export async function readStatus({ env = process.env } = {}) {
    return readJsonFile(statusFileFromEnv(env), {
        state: 'unknown',
        updatedAt: '',
        nginx: { state: 'unknown' },
        cloudflared: { state: 'unknown', tokenSet: false },
    });
}

export async function writeStatus(update, { env = process.env } = {}) {
    const filePath = statusFileFromEnv(env);
    return withFileLock(`${filePath}.lock`, async () => {
        const previous = await readJsonFile(filePath, {}).catch(() => ({}));
        return writeJsonFile(filePath, {
            ...previous,
            ...update,
            updatedAt: new Date().toISOString(),
        });
    });
}

export async function readSecretState({ env = process.env } = {}) {
    return readJsonFile(secretStateFileFromEnv(env), {
        tunnelToken: '',
        tunnelId: '',
        tunnelName: '',
        updatedAt: '',
    });
}

export async function writeSecretState(update, { env = process.env } = {}) {
    const filePath = secretStateFileFromEnv(env);
    return withFileLock(`${filePath}.lock`, async () => {
        const previous = await readJsonFile(filePath, {}).catch(() => ({}));
        return writeJsonFile(filePath, {
            ...previous,
            ...update,
            updatedAt: new Date().toISOString(),
        }, { mode: 0o600 });
    });
}

export async function withOperationLock(operation, { env = process.env } = {}) {
    return withFileLock(`${configFileFromEnv(env)}.operation.lock`, operation);
}

export function redactSecretState(secretState = {}) {
    return {
        tunnelTokenSet: Boolean(secretState?.tunnelToken),
        tunnelIdSet: Boolean(secretState?.tunnelId),
        tunnelName: secretState?.tunnelName || '',
        updatedAt: secretState?.updatedAt || '',
    };
}

export function redactConfig(config, env = process.env) {
    return {
        ...config,
        cloudflare: {
            apiTokenConfigured: Boolean(env.WEB_PUBLISHING_CLOUDFLARE_API_TOKEN),
            accountIdConfigured: Boolean(env.WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID),
            zoneIdConfigured: Boolean(env.WEB_PUBLISHING_CLOUDFLARE_ZONE_ID),
        },
        tunnel: {
            ...(config?.tunnel || {}),
            tokenSet: Boolean(config?.tunnel?.tokenSet || env.WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN || env.TUNNEL_TOKEN),
        },
    };
}
