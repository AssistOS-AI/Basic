import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// OCI runtimes mount these files individually. Copy their bytes to private
// regular files so an unprivileged child can make its own read-only mounts
// without remounting the OCI runtime's locked mount points.
export const COPIED_SYSTEM_FILES = Object.freeze(['/etc/resolv.conf', '/etc/hosts']);
export const MAX_SYSTEM_FILE_BYTES = 64 * 1024;

export function stageSystemFiles({ sourceRoot = '/', temporaryRoot = os.tmpdir() } = {}) {
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'bwrap-system-'));
    fs.chmodSync(directory, 0o700);
    const sources = new Map();
    const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
    try {
        for (const destination of COPIED_SYSTEM_FILES) {
            let fd;
            try {
                // The source names are fixed by policy. Following a system
                // symlink is intentional; fstat validates the opened target.
                fd = fs.openSync(path.join(sourceRoot, destination), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                throw error;
            }
            try {
                const stat = fs.fstatSync(fd);
                if (!stat.isFile() || stat.size > MAX_SYSTEM_FILE_BYTES) {
                    throw new Error(`unsafe or oversized fixed system file '${destination}'`);
                }
                const bytes = Buffer.alloc(MAX_SYSTEM_FILE_BYTES + 1);
                let length = 0;
                while (length < bytes.length) {
                    const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
                    if (count === 0) break;
                    length += count;
                }
                if (length > MAX_SYSTEM_FILE_BYTES) throw new Error(`oversized fixed system file '${destination}'`);
                const source = path.join(directory, path.basename(destination));
                fs.writeFileSync(source, bytes.subarray(0, length), { flag: 'wx', mode: 0o444 });
                sources.set(destination, source);
            } finally {
                fs.closeSync(fd);
            }
        }
        return { directory, sources, cleanup };
    } catch (error) {
        cleanup();
        throw error;
    }
}
