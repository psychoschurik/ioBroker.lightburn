import * as dgram from 'node:dgram';
import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';

const RESPONSE_OK = 'OK';
const RESPONSE_BUSY_OR_FAILED = '!';
const RESPONSE_INVALID = '?';

interface LightBurnConfig {
    host?: string;
    commandPort?: number | string;
    responsePort?: number | string;
    bindAddress?: string;
    timeoutMs?: number | string;
    pollInterval?: number | string;
}

interface PendingCommand {
    command: string;
    resolve: (response: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

class LightBurn extends Adapter {
    declare config: LightBurnConfig;
    private socket: dgram.Socket | null = null;
    private pendingCommand: PendingCommand | null = null;
    private commandQueue: Promise<void> = Promise.resolve();
    private pollTimer: NodeJS.Timeout | null = null;
    private isUnloading = false;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({
            ...options,
            name: 'lightburn',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setStateAsync('info.connection', false, true);
        await this.setStateAsync('info.busy', false, true);
        await this.openSocket();

        this.subscribeStates('control.*');
        this.startPolling();
        await this.refreshStatus('startup');
    }

    private onUnload(callback: () => void): void {
        try {
            this.isUnloading = true;

            if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }

            if (this.pendingCommand) {
                clearTimeout(this.pendingCommand.timer);
                this.pendingCommand.reject(new Error('Adapter is unloading'));
                this.pendingCommand = null;
            }

            if (this.socket) {
                this.socket.close();
                this.socket = null;
            }

            callback();
        } catch (error) {
            this.log.error(`Error during unload: ${this.getErrorMessage(error)}`);
            callback();
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            return;
        }

        const stateId = id.substring(this.namespace.length + 1);

        try {
            switch (stateId) {
                case 'control.start':
                    if (state.val === true) {
                        await this.executeControlCommand(stateId, 'START');
                    }
                    break;

                case 'control.close':
                    if (state.val === true) {
                        await this.executeControlCommand(stateId, 'CLOSE');
                    }
                    break;

                case 'control.forceClose':
                    if (state.val === true) {
                        await this.executeControlCommand(stateId, 'FORCECLOSE');
                    }
                    break;

                case 'control.ping':
                    if (state.val === true) {
                        await this.executeControlCommand(stateId, 'PING');
                    }
                    break;

                case 'control.status':
                    if (state.val === true) {
                        await this.refreshStatus('manual');
                        await this.setStateAsync(stateId, false, true);
                    }
                    break;

                case 'control.loadFile':
                    await this.executePathCommand(stateId, 'LOADFILE', state.val);
                    break;

                case 'control.forceLoad':
                    await this.executePathCommand(stateId, 'FORCELOAD', state.val);
                    break;

                case 'control.importFile':
                    await this.executePathCommand(stateId, 'IMPORT', state.val);
                    break;

                case 'control.laser':
                    await this.executePathCommand(stateId, 'LASER', state.val);
                    break;

                case 'control.command':
                    await this.executeRawCommand(stateId, state.val);
                    break;

                default:
                    this.log.debug(`Unhandled state change: ${stateId}`);
            }
        } catch (error) {
            const message = this.getErrorMessage(error);
            this.log.warn(`Failed to process ${stateId}: ${message}`);
            await this.setStateAsync('info.lastError', message, true);
            await this.setStateAsync('info.connection', false, true);
        }
    }

    private openSocket(): Promise<void> {
        return new Promise((resolve, reject) => {
            const bindAddress = this.normalizeHost(this.config.bindAddress, '0.0.0.0');
            const responsePort = this.normalizePort(this.config.responsePort, 19841);
            let settled = false;

            const done = (): void => {
                if (settled) {
                    return;
                }

                settled = true;
                resolve();
            };

            const fail = (error: Error): void => {
                if (settled) {
                    return;
                }

                settled = true;
                reject(error);
            };

            const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            this.socket = socket;

            socket.once('listening', () => {
                this.log.info(`Listening for LightBurn UDP responses on ${bindAddress}:${responsePort}`);
                done();
            });

            socket.on('message', message => {
                this.handleResponse(message);
            });

            socket.on('error', error => {
                if (this.pendingCommand) {
                    clearTimeout(this.pendingCommand.timer);
                    this.pendingCommand.reject(error);
                    this.pendingCommand = null;
                }

                if (!settled) {
                    fail(error);
                    return;
                }

                if (!this.isUnloading) {
                    this.log.error(`UDP socket error: ${error.message}`);
                }
            });

            socket.bind(responsePort, bindAddress);
        });
    }

    private handleResponse(message: Buffer): void {
        const response = message.toString('utf8').trim();

        if (!this.pendingCommand) {
            this.log.debug(`Received unexpected UDP response: ${response}`);
            return;
        }

        clearTimeout(this.pendingCommand.timer);
        this.pendingCommand.resolve(response);
        this.pendingCommand = null;
    }

    private sendQueued(command: string): Promise<string> {
        const result = this.commandQueue.then(
            () => this.sendCommand(command),
            () => this.sendCommand(command),
        );

        this.commandQueue = result.then(
            () => undefined,
            () => undefined,
        );

        return result;
    }

    private sendCommand(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const socket = this.socket;

            if (!socket) {
                reject(new Error('UDP socket is not open'));
                return;
            }

            const host = this.normalizeHost(this.config.host, '127.0.0.1');
            const commandPort = this.normalizePort(this.config.commandPort, 19840);
            const timeoutMs = this.normalizeTimeout(this.config.timeoutMs, 2000);
            const payload = Buffer.from(command, 'utf8');

            const timer = setTimeout(() => {
                this.pendingCommand = null;
                reject(new Error(`No response from LightBurn for ${command} within ${timeoutMs} ms`));
            }, timeoutMs);

            this.pendingCommand = { command, resolve, reject, timer };

            socket.send(payload, commandPort, host, error => {
                if (!error) {
                    return;
                }

                clearTimeout(timer);
                this.pendingCommand = null;
                reject(error);
            });
        });
    }

    private async executeControlCommand(stateId: string, command: string): Promise<void> {
        const response = await this.sendAndRecord(command);
        await this.setStateAsync(stateId, false, true);
        this.log.info(`LightBurn command ${command} returned ${response}`);
    }

    private async executePathCommand(
        stateId: string,
        prefix: string,
        value: ioBroker.StateValue | undefined,
    ): Promise<void> {
        const text = this.normalizeText(value);

        if (!text) {
            await this.setStateAsync(stateId, '', true);
            return;
        }

        const response = await this.sendAndRecord(`${prefix}:${text}`);
        await this.setStateAsync(stateId, text, true);
        this.log.info(`LightBurn command ${prefix} returned ${response}`);
    }

    private async executeRawCommand(stateId: string, value: ioBroker.StateValue | undefined): Promise<void> {
        const command = this.normalizeText(value);

        if (!command) {
            await this.setStateAsync(stateId, '', true);
            return;
        }

        const response = await this.sendAndRecord(command);
        await this.setStateAsync(stateId, command, true);
        this.log.info(`LightBurn command ${command} returned ${response}`);
    }

    private async sendAndRecord(command: string): Promise<string> {
        this.validateCommand(command);

        await this.setStateAsync('info.lastCommand', command, true);
        await this.setStateAsync('info.lastError', '', true);

        const response = await this.sendQueued(command);
        await this.applyResponse(command, response);

        return response;
    }

    private async refreshStatus(source: string): Promise<void> {
        try {
            const response = await this.sendAndRecord('STATUS');
            this.log.debug(`LightBurn status ${source}: ${response}`);
        } catch (error) {
            const message = this.getErrorMessage(error);
            await this.setStateAsync('info.connection', false, true);
            await this.setStateAsync('info.busy', false, true);
            await this.setStateAsync('info.lastError', message, true);
            this.log.debug(`LightBurn status ${source} failed: ${message}`);
        }
    }

    private async applyResponse(command: string, response: string): Promise<void> {
        await this.setStateAsync('info.lastResponse', response, true);

        if (response === RESPONSE_INVALID) {
            await this.setStateAsync('info.connection', true, true);
            throw new Error(`LightBurn rejected invalid command: ${command}`);
        }

        if (command === 'STATUS') {
            await this.setStateAsync(
                'info.connection',
                response === RESPONSE_OK || response === RESPONSE_BUSY_OR_FAILED,
                true,
            );
            await this.setStateAsync('info.busy', response === RESPONSE_BUSY_OR_FAILED, true);
            return;
        }

        if (command === 'PING') {
            await this.setStateAsync('info.connection', response === RESPONSE_OK, true);
            return;
        }

        await this.setStateAsync('info.connection', response === RESPONSE_OK, true);

        if (response === RESPONSE_BUSY_OR_FAILED) {
            throw new Error(`LightBurn could not execute command: ${command}`);
        }
    }

    private startPolling(): void {
        const intervalSeconds = Number(this.config.pollInterval);

        if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
            this.log.info('LightBurn status polling is disabled');
            return;
        }

        const intervalMs = Math.max(intervalSeconds * 1000, 1000);
        this.pollTimer = setInterval(() => {
            this.refreshStatus('poll').catch(error => {
                this.log.debug(`Polling failed: ${this.getErrorMessage(error)}`);
            });
        }, intervalMs);
    }

    private validateCommand(command: string): void {
        if (!command.trim()) {
            throw new Error('Command must not be empty');
        }

        if (/[\r\n\0]/.test(command)) {
            throw new Error('Command must be a single UDP line');
        }
    }

    private normalizeText(value: ioBroker.StateValue | undefined): string {
        if (value === null || value === undefined) {
            return '';
        }
        if (typeof value === 'object') {
            return JSON.stringify(value);
        }

        return value.toString().trim();
    }

    private normalizeHost(value: string | undefined, fallback: string): string {
        const host = this.normalizeText(value);
        return host || fallback;
    }

    private normalizePort(value: string | number | undefined, fallback: number): number {
        const port = Number(value);

        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return fallback;
        }

        return port;
    }

    private normalizeTimeout(value: unknown, fallback: number): number {
        const timeout = Number(value);

        if (!Number.isFinite(timeout) || timeout < 250) {
            return fallback;
        }

        return timeout;
    }

    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<AdapterOptions> | undefined): LightBurn => new LightBurn(options);
} else {
    new LightBurn();
}
