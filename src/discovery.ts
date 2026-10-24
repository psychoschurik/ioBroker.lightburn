import * as http from 'node:http';
import { isIPv4 } from 'node:net';

export interface DiscoveryResult {
    host: string;
    port: number;
    status: 'lightburn' | 'http-service';
    httpStatus: number;
}

export function discoveryHosts(cidr: string): string[] {
    const [address, prefixText, extra] = cidr.trim().split('/');
    const prefix = Number(prefixText);
    if (!isIPv4(address) || !/^\d+$/.test(prefixText ?? '') || extra !== undefined || prefix < 24 || prefix > 32) {
        throw new Error('Enter an IPv4 subnet with prefix /24 to /32, e.g. 192.168.23.0/24');
    }
    const parts = address.split('.').map(Number);
    if (
        !(
            parts[0] === 10 ||
            (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
            (parts[0] === 192 && parts[1] === 168)
        )
    ) {
        throw new Error('Discovery supports private IPv4 networks only (10.*, 172.16-31.*, 192.168.*)');
    }
    const value = parts.reduce((total, part) => total * 256 + part, 0);
    const size = 2 ** (32 - prefix);
    const base = Math.floor(value / size) * size;
    const hosts: string[] = [];
    for (let offset = size > 2 ? 1 : 0; offset < size - (size > 2 ? 1 : 0); offset++) {
        const ip = base + offset;
        hosts.push([24, 16, 8, 0].map(shift => (ip >>> shift) & 255).join('.'));
    }
    return hosts;
}

export function probeHost(host: string, port: number, signal: AbortSignal): Promise<DiscoveryResult | null> {
    return new Promise(resolve => {
        if (signal.aborted) {
            resolve(null);
            return;
        }
        let settled = false;
        const resources: { timer?: NodeJS.Timeout; request?: http.ClientRequest } = {};
        const finish = (result: DiscoveryResult | null): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(resources.timer);
            resources.request?.destroy();
            resolve(result);
        };
        // Only the public landing page is requested; never send credentials or trigger pairing.
        resources.request = http.get({ host, port, path: '/', signal, agent: false }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
                body += chunk;
                if (body.length > 65536) {
                    finish(null);
                }
            });
            response.on('error', () => finish(null));
            response.on('end', () =>
                finish({
                    host,
                    port,
                    status: response.statusCode === 200 && /\blightburn\b/i.test(body) ? 'lightburn' : 'http-service',
                    httpStatus: response.statusCode ?? 0,
                }),
            );
        });
        resources.timer = setTimeout(() => finish(null), 1500);
        resources.request.on('error', () => finish(null));
    });
}

export async function scanNetwork(hosts: string[], port: number, signal: AbortSignal): Promise<DiscoveryResult[]> {
    const results: DiscoveryResult[] = [];
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(16, hosts.length) }, async () => {
            while (!signal.aborted && next < hosts.length) {
                const host = hosts[next++];
                const result = await probeHost(host, port, signal);
                if (result) {
                    results.push(result);
                }
            }
        }),
    );
    return results.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}
