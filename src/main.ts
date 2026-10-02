import * as crypto from 'node:crypto';
import * as dgram from 'node:dgram';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as utils from '@iobroker/adapter-core';

const REST_PORT = 19520;
const UDP_COMMAND_PORT = 19840;
const UDP_RESPONSE_PORT = 19841;
const RESPONSE_OK = 'OK';
const RESPONSE_BUSY_OR_FAILED = '!';
const RESPONSE_INVALID = '?';

type JobStateValue = 'idle' | 'running' | 'paused';
type RestCapability = 'state' | 'project' | 'upload';

interface LightBurnConfig {
    restHost?: string;
    restPort?: number | string;
    restSecret?: string;
    applicationName?: string;
    requestTimeoutMs?: number | string;
    pollInterval?: number | string;
    projectPollInterval?: number | string;
    enableProjectPolling?: boolean;
    enableUdpControl?: boolean;
    udpHost?: string;
    udpCommandPort?: number | string;
    udpResponsePort?: number | string;
    udpBindAddress?: string;
    udpTimeoutMs?: number | string;
}

interface PendingUdpCommand {
    command: string;
    resolve: (response: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

interface RestErrorBody {
    error?: string;
}

interface ConnectResponse {
    status?: string;
    secret?: string;
}

interface ConnectionStatus {
    connected?: boolean;
    device_name?: string;
    supports_z?: boolean;
    supports_overrides?: boolean;
}

interface JobState {
    state?: JobStateValue;
    progress?: number;
}

interface AxisPosition {
    x?: number;
    y?: number;
    z?: number;
}

interface PositionSnapshot {
    machine?: AxisPosition;
    workpiece?: AxisPosition;
}

interface Overrides {
    speed_percent?: number;
    power_percent?: number;
}

interface AuxState {
    spindle_on?: boolean;
    spindle_rpm?: number;
    coolant_on?: boolean;
    vacuum_on?: boolean;
}

interface JogSettings {
    xy_distance?: number;
    z_distance?: number;
    xy_speed?: number;
    z_speed?: number;
    units?: string;
}

interface PollSnapshot {
    position?: PositionSnapshot;
    job?: JobState;
    overrides?: Overrides;
    aux?: AuxState;
    connection?: ConnectionStatus;
    settings?: JogSettings;
}

interface ProjectSnapshot {
    filename?: string;
    modified?: boolean;
    shape_count?: number;
    units?: {
        distance?: string;
        speed?: string;
    };
    device?: {
        name?: string;
        supports_z?: boolean;
    };
}

type RestRequestBody = string | Buffer;

class LightBurn extends utils.Adapter {
    private udpSocket: dgram.Socket | null = null;
    private pendingUdpCommand: PendingUdpCommand | null = null;
    private udpCommandQueue: Promise<void> = Promise.resolve();
    private pollTimer: NodeJS.Timeout | null = null;
    private projectPollTimer: NodeJS.Timeout | null = null;
    private isUnloading = false;
    private restSecret = '';
    private jobStartedAtMs: number | null = null;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'lightburn',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private get lightBurnConfig(): LightBurnConfig {
        return this.config;
    }

    private async onReady(): Promise<void> {
        this.restSecret = this.normalizeText(this.lightBurnConfig.restSecret);

        await this.setStateAsync('info.connection', false, true);
        await this.setStateAsync('info.apiConnection', false, true);
        await this.setStateAsync('info.apiPaired', Boolean(this.restSecret), true);
        await this.setStateAsync('info.busy', false, true);
        await this.setStateAsync('info.lastError', '', true);

        this.subscribeStates('control.*');

        if (this.isUdpControlEnabled()) {
            await this.openUdpSocket();
        }

        if (this.restSecret) {
            await this.refreshState('startup');
            await this.refreshProjectData('startup');
            this.startPolling();
        } else {
            this.log.info(
                'LightBurn REST secret is missing. Pair the adapter or paste a secret in the instance settings.',
            );
        }
    }

    private onUnload(callback: () => void): void {
        try {
            this.isUnloading = true;

            if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }

            if (this.projectPollTimer) {
                clearInterval(this.projectPollTimer);
                this.projectPollTimer = null;
            }

            if (this.pendingUdpCommand) {
                clearTimeout(this.pendingUdpCommand.timer);
                this.pendingUdpCommand.reject(new Error('Adapter is unloading'));
                this.pendingUdpCommand = null;
            }

            if (this.udpSocket) {
                this.udpSocket.close();
                this.udpSocket = null;
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
                case 'control.pair':
                    if (state.val === true) {
                        await this.pairRestApi();
                        await this.setStateAsync(stateId, false, true);
                    }
                    break;

                case 'control.refresh':
                case 'control.status':
                    if (state.val === true) {
                        await this.refreshState('manual');
                        await this.setStateAsync(stateId, false, true);
                    }
                    break;

                case 'control.refreshProject':
                    if (state.val === true) {
                        await this.refreshProjectData('manual');
                        await this.setStateAsync(stateId, false, true);
                    }
                    break;

                case 'control.uploadFile':
                    await this.uploadFile(stateId, state.val, false);
                    break;

                case 'control.openFile':
                    await this.uploadFile(stateId, state.val, true);
                    break;

                case 'control.start':
                    if (state.val === true) {
                        await this.executeUdpControlCommand(stateId, 'START');
                    }
                    break;

                case 'control.pause':
                    if (state.val === true) {
                        await this.executeUdpControlCommand(stateId, 'PAUSE');
                    }
                    break;

                case 'control.close':
                    if (state.val === true) {
                        await this.executeUdpControlCommand(stateId, 'CLOSE');
                    }
                    break;

                case 'control.forceClose':
                    if (state.val === true) {
                        await this.executeUdpControlCommand(stateId, 'FORCECLOSE');
                    }
                    break;

                case 'control.udpCommand':
                case 'control.command':
                    await this.executeRawUdpCommand(stateId, state.val);
                    break;

                default:
                    this.log.debug(`Unhandled state change: ${stateId}`);
            }
        } catch (error) {
            const message = this.getErrorMessage(error);
            this.log.warn(`Failed to process ${stateId}: ${message}`);
            await this.setStateAsync('info.lastError', message, true);
            await this.setStateAsync('info.apiConnection', false, true);
            await this.setStateAsync('info.connection', false, true);

            if (stateId.startsWith('control.') && typeof state.val === 'boolean') {
                await this.setStateAsync(stateId, false, true);
            }
        }
    }

    private async pairRestApi(): Promise<void> {
        const capabilities: RestCapability[] = ['state', 'project', 'upload'];
        const applicationName = this.normalizeText(this.lightBurnConfig.applicationName) || 'ioBroker.lightburn';

        const response = await this.restRequest<ConnectResponse>('/api/connect', {
            method: 'POST',
            authenticated: false,
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                application_name: applicationName,
                capabilities,
            }),
        });

        if (response.status !== 'ok' || !response.secret) {
            throw new Error('LightBurn pairing did not return a secret');
        }

        this.restSecret = response.secret;
        await this.persistRestSecret(response.secret);
        await this.setStateAsync('info.apiPaired', true, true);
        await this.setStateAsync('info.lastError', '', true);
        this.log.info('LightBurn REST API pairing succeeded and the secret was stored in the adapter instance.');

        this.startPolling();
        await this.refreshState('pairing');
        await this.refreshProjectData('pairing');
    }

    private async persistRestSecret(secret: string): Promise<void> {
        const objectId = `system.adapter.${this.namespace}`;
        const instanceObject = await this.getForeignObjectAsync(objectId);

        if (!instanceObject) {
            throw new Error(`Cannot persist REST secret because ${objectId} was not found`);
        }

        instanceObject.native = {
            ...instanceObject.native,
            restSecret: secret,
        };

        await this.setForeignObjectAsync(objectId, instanceObject);
    }

    private async refreshState(source: string): Promise<void> {
        if (!this.ensureRestSecret()) {
            return;
        }

        try {
            const snapshot = await this.restRequest<PollSnapshot>('/api/events/poll');
            await this.applyPollSnapshot(snapshot);
            await this.setStateAsync('info.apiConnection', true, true);
            await this.setStateAsync('info.lastEndpoint', '/api/events/poll', true);
            await this.setStateAsync('info.lastError', '', true);
            this.log.debug(`LightBurn REST state refresh ${source} succeeded`);
        } catch (error) {
            await this.handleRestFailure(error, `LightBurn REST state refresh ${source} failed`);
        }
    }

    private async refreshProjectData(source: string): Promise<void> {
        if (!this.ensureRestSecret() || this.lightBurnConfig.enableProjectPolling === false) {
            return;
        }

        try {
            const [project, layers, cuts] = await Promise.all([
                this.restRequest<ProjectSnapshot>('/api/project'),
                this.restRequest<unknown>('/api/layers'),
                this.restRequest<unknown>('/api/cuts'),
            ]);

            await this.applyProjectSnapshot(project);
            await this.setJsonState('layers.raw', layers);
            await this.setJsonState('cuts.raw', cuts);
            await this.setStateAsync('info.apiConnection', true, true);
            await this.setStateAsync('info.lastEndpoint', '/api/project,/api/layers,/api/cuts', true);
            await this.setStateAsync('info.lastError', '', true);
            this.log.debug(`LightBurn REST project refresh ${source} succeeded`);
        } catch (error) {
            await this.handleRestFailure(error, `LightBurn REST project refresh ${source} failed`);
        }
    }

    private async applyPollSnapshot(snapshot: PollSnapshot): Promise<void> {
        const connection = snapshot.connection ?? {};
        const job = snapshot.job ?? {};
        const position = snapshot.position ?? {};
        const overrides = snapshot.overrides ?? {};
        const aux = snapshot.aux ?? {};
        const settings = snapshot.settings ?? {};

        await this.setStateAsync('info.connection', Boolean(connection.connected), true);
        await this.setStateAsync('device.connected', Boolean(connection.connected), true);
        await this.setStateAsync('device.name', connection.device_name ?? '', true);
        await this.setStateAsync('device.supportsZ', Boolean(connection.supports_z), true);
        await this.setStateAsync('device.supportsOverrides', Boolean(connection.supports_overrides), true);

        await this.applyJobState(job);

        await this.setNumberState('position.machine.x', position.machine?.x);
        await this.setNumberState('position.machine.y', position.machine?.y);
        await this.setNumberState('position.machine.z', position.machine?.z);
        await this.setNumberState('position.workpiece.x', position.workpiece?.x);
        await this.setNumberState('position.workpiece.y', position.workpiece?.y);
        await this.setNumberState('position.workpiece.z', position.workpiece?.z);

        await this.setNumberState('overrides.speedPercent', overrides.speed_percent);
        await this.setNumberState('overrides.powerPercent', overrides.power_percent);

        await this.setStateAsync('aux.spindleOn', Boolean(aux.spindle_on), true);
        await this.setNumberState('aux.spindleRpm', aux.spindle_rpm);
        await this.setStateAsync('aux.coolantOn', Boolean(aux.coolant_on), true);
        await this.setStateAsync('aux.vacuumOn', Boolean(aux.vacuum_on), true);

        await this.setNumberState('settings.xyDistance', settings.xy_distance);
        await this.setNumberState('settings.zDistance', settings.z_distance);
        await this.setNumberState('settings.xySpeed', settings.xy_speed);
        await this.setNumberState('settings.zSpeed', settings.z_speed);
        await this.setStateAsync('settings.units', settings.units ?? '', true);
    }

    private async applyJobState(job: JobState): Promise<void> {
        const state = job.state ?? 'idle';
        const progress = this.clampNumber(job.progress ?? 0, 0, 100);
        const active = state === 'running' || state === 'paused';
        const now = Date.now();

        if (active && this.jobStartedAtMs === null) {
            this.jobStartedAtMs = now;
        }

        if (!active) {
            this.jobStartedAtMs = null;
        }

        const elapsedSeconds = this.jobStartedAtMs ? Math.max(0, Math.floor((now - this.jobStartedAtMs) / 1000)) : 0;
        const estimatedTotalSeconds = active && progress > 0 ? Math.round(elapsedSeconds / (progress / 100)) : 0;
        const remainingSeconds =
            active && estimatedTotalSeconds > elapsedSeconds ? estimatedTotalSeconds - elapsedSeconds : 0;

        await this.setStateAsync('job.state', state, true);
        await this.setStateAsync('job.running', state === 'running', true);
        await this.setStateAsync('job.paused', state === 'paused', true);
        await this.setStateAsync('info.busy', active, true);
        await this.setNumberState('job.progressPercent', progress);
        await this.setStateAsync(
            'job.startedAt',
            this.jobStartedAtMs ? new Date(this.jobStartedAtMs).toISOString() : '',
            true,
        );
        await this.setNumberState('job.elapsedSeconds', elapsedSeconds);
        await this.setNumberState('job.estimatedTotalSeconds', estimatedTotalSeconds);
        await this.setNumberState('job.remainingSeconds', remainingSeconds);
    }

    private async applyProjectSnapshot(project: ProjectSnapshot): Promise<void> {
        await this.setStateAsync('project.filename', project.filename ?? '', true);
        await this.setStateAsync('project.modified', Boolean(project.modified), true);
        await this.setNumberState('project.shapeCount', project.shape_count);
        await this.setStateAsync('project.units.distance', project.units?.distance ?? '', true);
        await this.setStateAsync('project.units.speed', project.units?.speed ?? '', true);
        await this.setStateAsync('project.deviceName', project.device?.name ?? '', true);
        await this.setJsonState('project.raw', project);
    }

    private async uploadFile(
        stateId: string,
        value: ioBroker.StateValue | undefined,
        openAsProject: boolean,
    ): Promise<void> {
        if (!this.ensureRestSecret()) {
            await this.setStateAsync(stateId, '', true);
            return;
        }

        const filePath = this.normalizeText(value);

        if (!filePath) {
            await this.setStateAsync(stateId, '', true);
            return;
        }

        const data = await fs.readFile(filePath);
        const filename = path.basename(filePath);
        const endpoint = openAsProject ? '/api/file/open' : '/api/file/upload';
        const response = await this.restRequest<unknown>(endpoint, {
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'x-filename': filename,
            },
            body: data,
        });

        await this.setJsonState('upload.lastResponse', response);
        await this.setStateAsync('upload.lastFile', filePath, true);
        await this.setStateAsync('upload.lastMode', openAsProject ? 'open' : 'upload', true);
        await this.setStateAsync('info.lastEndpoint', endpoint, true);
        await this.setStateAsync(stateId, filePath, true);
        this.log.info(`LightBurn REST ${openAsProject ? 'open' : 'upload'} accepted ${filePath}`);
    }

    private async restRequest<T>(
        endpoint: string,
        options: {
            method?: 'GET' | 'POST';
            authenticated?: boolean;
            headers?: Record<string, string>;
            body?: RestRequestBody;
        } = {},
    ): Promise<T> {
        const authenticated = options.authenticated !== false;
        const url = `${this.getRestBaseUrl()}${endpoint}`;
        const timeoutMs = this.normalizeTimeout(this.lightBurnConfig.requestTimeoutMs, 5000);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const headers: Record<string, string> = {
                ...(options.headers ?? {}),
            };

            if (authenticated) {
                headers.authorization = `Bearer ${this.createBearerToken()}`;
            }

            const response = await fetch(url, {
                method: options.method ?? 'GET',
                headers,
                body: options.body,
                signal: controller.signal,
            });

            const text = await response.text();

            if (!response.ok) {
                throw new Error(this.formatRestError(endpoint, response.status, text));
            }

            if (!text) {
                return undefined as T;
            }

            return JSON.parse(text) as T;
        } finally {
            clearTimeout(timeout);
        }
    }

    private formatRestError(endpoint: string, status: number, body: string): string {
        try {
            const parsed = JSON.parse(body) as RestErrorBody;

            if (parsed.error) {
                return `${endpoint} failed with HTTP ${status}: ${parsed.error}`;
            }
        } catch {
            // Ignore parse errors and include the raw body below.
        }

        return `${endpoint} failed with HTTP ${status}${body ? `: ${body}` : ''}`;
    }

    private async handleRestFailure(error: unknown, prefix: string): Promise<void> {
        const message = this.getErrorMessage(error);
        await this.setStateAsync('info.apiConnection', false, true);
        await this.setStateAsync('info.connection', false, true);
        await this.setStateAsync('info.lastError', message, true);
        this.log.debug(`${prefix}: ${message}`);
    }

    private ensureRestSecret(): boolean {
        if (this.restSecret) {
            return true;
        }

        void this.setStateAsync('info.apiPaired', false, true);
        void this.setStateAsync('info.apiConnection', false, true);
        void this.setStateAsync('info.connection', false, true);
        void this.setStateAsync('info.lastError', 'LightBurn REST secret is missing', true);
        return false;
    }

    private createBearerToken(): string {
        const minute = Math.floor(Date.now() / 60000).toString();
        return crypto.createHmac('sha256', this.restSecret).update(minute).digest('hex');
    }

    private getRestBaseUrl(): string {
        const host = this.normalizeHost(this.lightBurnConfig.restHost, '127.0.0.1');
        const port = this.normalizePort(this.lightBurnConfig.restPort, REST_PORT);
        return `http://${host}:${port}`;
    }

    private startPolling(): void {
        if (this.pollTimer) {
            return;
        }

        const intervalSeconds = Number(this.lightBurnConfig.pollInterval);

        if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
            this.log.info('LightBurn REST state polling is disabled');
            return;
        }

        const intervalMs = Math.max(intervalSeconds * 1000, 1000);
        this.pollTimer = setInterval(() => {
            this.refreshState('poll').catch(error => {
                this.log.debug(`State polling failed: ${this.getErrorMessage(error)}`);
            });
        }, intervalMs);

        this.startProjectPolling();
    }

    private startProjectPolling(): void {
        if (this.projectPollTimer || this.lightBurnConfig.enableProjectPolling === false) {
            return;
        }

        const intervalSeconds = Number(this.lightBurnConfig.projectPollInterval);

        if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
            this.log.info('LightBurn REST project polling is disabled');
            return;
        }

        const intervalMs = Math.max(intervalSeconds * 1000, 10000);
        this.projectPollTimer = setInterval(() => {
            this.refreshProjectData('poll').catch(error => {
                this.log.debug(`Project polling failed: ${this.getErrorMessage(error)}`);
            });
        }, intervalMs);
    }

    private async openUdpSocket(): Promise<void> {
        return new Promise((resolve, reject) => {
            const bindAddress = this.normalizeHost(this.lightBurnConfig.udpBindAddress, '0.0.0.0');
            const responsePort = this.normalizePort(this.lightBurnConfig.udpResponsePort, UDP_RESPONSE_PORT);
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
            this.udpSocket = socket;

            socket.once('listening', () => {
                this.log.info(`Listening for LightBurn UDP responses on ${bindAddress}:${responsePort}`);
                done();
            });

            socket.on('message', message => {
                this.handleUdpResponse(message);
            });

            socket.on('error', error => {
                if (this.pendingUdpCommand) {
                    clearTimeout(this.pendingUdpCommand.timer);
                    this.pendingUdpCommand.reject(error);
                    this.pendingUdpCommand = null;
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

    private handleUdpResponse(message: Buffer): void {
        const response = message.toString('utf8').trim();

        if (!this.pendingUdpCommand) {
            this.log.debug(`Received unexpected UDP response: ${response}`);
            return;
        }

        clearTimeout(this.pendingUdpCommand.timer);
        this.pendingUdpCommand.resolve(response);
        this.pendingUdpCommand = null;
    }

    private sendQueuedUdpCommand(command: string): Promise<string> {
        const result = this.udpCommandQueue.then(
            () => this.sendUdpCommand(command),
            () => this.sendUdpCommand(command),
        );

        this.udpCommandQueue = result.then(
            () => undefined,
            () => undefined,
        );

        return result;
    }

    private sendUdpCommand(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.isUdpControlEnabled()) {
                reject(new Error('Legacy UDP control is disabled in the adapter settings'));
                return;
            }

            const socket = this.udpSocket;

            if (!socket) {
                reject(new Error('UDP socket is not open'));
                return;
            }

            const host = this.normalizeHost(
                this.lightBurnConfig.udpHost,
                this.normalizeHost(this.lightBurnConfig.restHost, '127.0.0.1'),
            );
            const commandPort = this.normalizePort(this.lightBurnConfig.udpCommandPort, UDP_COMMAND_PORT);
            const timeoutMs = this.normalizeTimeout(this.lightBurnConfig.udpTimeoutMs, 2000);
            const payload = Buffer.from(command, 'utf8');

            const timer = setTimeout(() => {
                this.pendingUdpCommand = null;
                reject(new Error(`No UDP response from LightBurn for ${command} within ${timeoutMs} ms`));
            }, timeoutMs);

            this.pendingUdpCommand = { command, resolve, reject, timer };

            socket.send(payload, commandPort, host, error => {
                if (!error) {
                    return;
                }

                clearTimeout(timer);
                this.pendingUdpCommand = null;
                reject(error);
            });
        });
    }

    private async executeUdpControlCommand(stateId: string, command: string): Promise<void> {
        const response = await this.sendAndRecordUdpCommand(command);
        await this.setStateAsync(stateId, false, true);
        this.log.info(`LightBurn UDP command ${command} returned ${response}`);
    }

    private async executeRawUdpCommand(stateId: string, value: ioBroker.StateValue | undefined): Promise<void> {
        const command = this.normalizeText(value);

        if (!command) {
            await this.setStateAsync(stateId, '', true);
            return;
        }

        const response = await this.sendAndRecordUdpCommand(command);
        await this.setStateAsync(stateId, command, true);
        this.log.info(`LightBurn UDP command ${command} returned ${response}`);
    }

    private async sendAndRecordUdpCommand(command: string): Promise<string> {
        this.validateUdpCommand(command);

        await this.setStateAsync('info.lastUdpCommand', command, true);
        await this.setStateAsync('info.lastError', '', true);

        const response = await this.sendQueuedUdpCommand(command);
        await this.applyUdpResponse(command, response);

        return response;
    }

    private async applyUdpResponse(command: string, response: string): Promise<void> {
        await this.setStateAsync('info.lastUdpResponse', response, true);

        if (response === RESPONSE_INVALID) {
            throw new Error(`LightBurn rejected invalid UDP command: ${command}`);
        }

        if (response === RESPONSE_BUSY_OR_FAILED) {
            throw new Error(`LightBurn could not execute UDP command: ${command}`);
        }

        if (response !== RESPONSE_OK) {
            this.log.debug(`LightBurn UDP command ${command} returned unexpected response: ${response}`);
        }
    }

    private isUdpControlEnabled(): boolean {
        return this.lightBurnConfig.enableUdpControl === true;
    }

    private validateUdpCommand(command: string): void {
        if (!command.trim()) {
            throw new Error('UDP command must not be empty');
        }

        if (/[\r\n\0]/.test(command)) {
            throw new Error('UDP command must be a single line');
        }
    }

    private async setNumberState(id: string, value: number | undefined): Promise<void> {
        await this.setStateAsync(id, Number.isFinite(value) ? Number(value) : 0, true);
    }

    private async setJsonState(id: string, value: unknown): Promise<void> {
        await this.setStateAsync(id, JSON.stringify(value ?? null), true);
    }

    private normalizeText(value: unknown): string {
        if (value === null || value === undefined) {
            return '';
        }

        if (typeof value === 'string') {
            return value.trim();
        }

        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
            return value.toString().trim();
        }

        return '';
    }

    private normalizeHost(value: unknown, fallback: string): string {
        const host = this.normalizeText(value);
        return host || fallback;
    }

    private normalizePort(value: unknown, fallback: number): number {
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

    private clampNumber(value: number, min: number, max: number): number {
        if (!Number.isFinite(value)) {
            return min;
        }

        return Math.min(Math.max(value, min), max);
    }

    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined): LightBurn => new LightBurn(options);
} else {
    new LightBurn();
}
