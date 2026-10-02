import WidgetGeneric, {
    AdapterReact,
    MuiMaterial,
    MuiIcons,
    React,
    getTileStyles,
    isNeumorphicTheme,
    type CustomWidgetPlugin,
    type WidgetGenericProps,
    type WidgetGenericState,
} from '@iobroker/dm-widgets';
import type { BoxProps, LinearProgressProps, Theme, TypographyProps } from '@mui/material';
import type { ConfigItemPanel, ConfigItemTabs } from '@iobroker/dm-utils';
import type { ConfigItemPanel as JsonConfigItemPanel } from '@iobroker/json-config';

const Box: React.ComponentType<BoxProps> = MuiMaterial?.Box;
const Typography: React.ComponentType<TypographyProps> = MuiMaterial?.Typography;
const LinearProgress: React.ComponentType<LinearProgressProps> = MuiMaterial?.LinearProgress;
const Button: React.ComponentType<any> = MuiMaterial?.Button;
const PauseIcon: React.ComponentType<{ sx?: Record<string, unknown> }> | undefined = MuiIcons?.Pause;
const I18n = AdapterReact?.I18n as { t?: (word: string) => string } | undefined;

const STATE_MAP = {
    apiConnection: 'info.apiConnection',
    connected: 'device.connected',
    deviceName: 'device.name',
    projectDeviceName: 'project.deviceName',
    progressPercent: 'job.progressPercent',
    remainingSeconds: 'job.remainingSeconds',
    jobState: 'job.state',
    filename: 'project.filename',
} as const;

type StateKey = keyof typeof STATE_MAP;

interface LightBurnStatusSettings extends CustomWidgetPlugin {
    instance?: string;
}

interface LightBurnStatusState extends WidgetGenericState {
    values: Partial<Record<StateKey, ioBroker.StateValue>>;
}

function t(word: string): string {
    return I18n?.t?.(word) || word;
}

function valueAsString(value: ioBroker.StateValue | undefined): string {
    return value === null || value === undefined ? '' : String(value);
}

function valueAsNumber(value: ioBroker.StateValue | undefined): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatPercent(value: number): string {
    return `${Math.round(Math.min(Math.max(value, 0), 100))}%`;
}

function formatDuration(totalSeconds: number): string {
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
        return '--:--';
    }

    const seconds = Math.floor(totalSeconds);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const restSeconds = seconds % 60;

    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${restSeconds.toString().padStart(2, '0')}`;
    }

    return `${minutes}:${restSeconds.toString().padStart(2, '0')}`;
}

function fileNameOnly(filePath: string): string {
    return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
}

export class LightBurnStatusComponent extends WidgetGeneric<LightBurnStatusState, LightBurnStatusSettings> {
    private subscribed: { id: string; handler: (id: string, state: ioBroker.State) => void }[] = [];

    constructor(props: WidgetGenericProps<LightBurnStatusSettings>) {
        super(props);
        this.state = {
            ...this.state,
            values: {},
        };
    }

    static override getConfigSchema(): { name: string; schema: ConfigItemPanel | ConfigItemTabs } {
        const schema: JsonConfigItemPanel = {
            type: 'panel',
            items: {
                size: {
                    type: 'select',
                    label: 'wm_Size',
                    options: [
                        { value: '1x1', label: '1x1' },
                        { value: '2x0.5', label: '2x0.5' },
                        { value: '2x1', label: '2x1' },
                        { value: '2x2', label: '2x2' },
                    ],
                    default: '1x1',
                    format: 'radio',
                    horizontal: true,
                    noTranslation: true,
                    sm: 12,
                },
                instance: {
                    type: 'instance',
                    adapter: 'lightburn',
                    label: 'lightburndm_instance',
                    default: 'lightburn.0',
                    sm: 12,
                },
                name: {
                    type: 'text',
                    label: 'wm_Name',
                    sm: 12,
                    md: 6,
                },
                icon: {
                    type: 'component',
                    subType: 'iconSelect',
                    label: 'wm_Icon',
                    sm: 12,
                    md: 6,
                },
            },
        };

        return { name: 'lightburndm_widget_title', schema: schema as unknown as ConfigItemPanel };
    }

    private get instance(): string {
        return this.props.settings.instance || 'lightburn.0';
    }

    componentDidMount(): void {
        super.componentDidMount?.();
        this.subscribeStates();
    }

    componentDidUpdate(prevProps: Readonly<WidgetGenericProps<LightBurnStatusSettings>>): void {
        super.componentDidUpdate?.(prevProps, this.state);
        const previousInstance = prevProps.settings.instance || 'lightburn.0';

        if (previousInstance !== this.instance) {
            this.unsubscribeStates();
            this.setState({ values: {} }, () => this.subscribeStates());
        }
    }

    componentWillUnmount(): void {
        super.componentWillUnmount?.();
        this.unsubscribeStates();
    }

    private subscribeStates(): void {
        const context = this.props.stateContext;

        for (const [key, stateId] of Object.entries(STATE_MAP) as [StateKey, string][]) {
            const id = `${this.instance}.${stateId}`;
            const handler = (_id: string, state: ioBroker.State): void => {
                this.setState(prev => ({
                    values: {
                        ...prev.values,
                        [key]: state ? state.val : null,
                    },
                }));
            };

            context.getState(id, handler);
            this.subscribed.push({ id, handler });
        }
    }

    private unsubscribeStates(): void {
        const context = this.props.stateContext;

        for (const { id, handler } of this.subscribed) {
            context.removeState(id, handler);
        }

        this.subscribed = [];
    }

    private get progress(): number {
        return Math.min(Math.max(valueAsNumber(this.state.values.progressPercent), 0), 100);
    }

    private get remaining(): string {
        return formatDuration(valueAsNumber(this.state.values.remainingSeconds));
    }

    private get connected(): boolean {
        return this.state.values.connected === true && this.state.values.apiConnection !== false;
    }

    private get jobState(): string {
        return valueAsString(this.state.values.jobState) || 'idle';
    }

    private get deviceName(): string {
        return (
            this.props.settings.name ||
            valueAsString(this.state.values.deviceName) ||
            valueAsString(this.state.values.projectDeviceName) ||
            t(this.connected ? 'lightburndm_no_device' : 'lightburndm_offline')
        );
    }

    private get filename(): string {
        const filename = valueAsString(this.state.values.filename);
        return filename ? fileNameOnly(filename) : t('lightburndm_no_file');
    }

    private get stateLabel(): string {
        if (!this.connected) {
            return t('lightburndm_offline');
        }

        const key = `lightburndm_${this.jobState}`;
        return t(key) === key ? this.jobState : t(key);
    }

    private get canPause(): boolean {
        return this.connected && this.jobState === 'running';
    }

    protected override isTileActive(): boolean {
        return this.connected && (this.jobState === 'running' || this.jobState === 'paused');
    }

    private pauseJob(event: { stopPropagation: () => void }): void {
        event.stopPropagation();

        if (!this.canPause) {
            return;
        }

        void this.props.stateContext.getSocket().setState(`${this.instance}.control.pause`, true, false);
    }

    private renderProgress(height = 6): React.JSX.Element {
        return (
            <LinearProgress
                variant="determinate"
                value={this.progress}
                sx={{
                    height,
                    borderRadius: `${height}px`,
                    backgroundColor: 'rgba(127,127,127,0.22)',
                    '& .MuiLinearProgress-bar': {
                        borderRadius: `${height}px`,
                        backgroundColor: this.getAccentColor() || '#f45f42',
                    },
                }}
            />
        );
    }

    private tileSx(theme: Theme): Record<string, unknown> {
        return {
            ...(getTileStyles(
                theme,
                this.isTileActive(),
                this.getAccentColor(),
                false,
                this.getInactiveColor(),
            ) as any),
            boxSizing: 'border-box',
            position: 'relative',
            overflow: 'hidden',
            cursor: 'default',
            padding: isNeumorphicTheme(theme) ? '10px' : '12px',
        };
    }

    private renderFrame(styleFn: (theme: Theme) => React.CSSProperties, body: React.JSX.Element): React.JSX.Element {
        const settingsButton = this.renderSettingsButton();

        return (
            <Box
                id={String(this.props.widget.id)}
                className={this.getWidgetClass()}
                sx={(theme: Theme) => styleFn(theme)}
            >
                {body}
                <Box
                    onClick={event => event.stopPropagation()}
                    sx={{ display: 'contents' }}
                >
                    {this.renderIndicators(settingsButton)}
                </Box>
                {this.renderChart()}
            </Box>
        );
    }

    private getStyleWideSquare(theme: Theme): React.CSSProperties {
        return {
            ...WidgetGeneric.getStyleWideTall(theme),
            aspectRatio: '1',
        };
    }

    private renderMetaRow(label: string, value: string, strong = false): React.JSX.Element {
        return (
            <Box sx={{ minWidth: 0 }}>
                <Typography
                    variant="caption"
                    sx={{
                        display: 'block',
                        lineHeight: 1.15,
                        color: 'text.secondary',
                        fontSize: '0.66rem',
                    }}
                >
                    {label}
                </Typography>
                <Typography
                    variant={strong ? 'body2' : 'caption'}
                    noWrap
                    title={value}
                    sx={{
                        display: 'block',
                        lineHeight: 1.25,
                        fontWeight: strong ? 700 : 600,
                        minWidth: 0,
                    }}
                >
                    {value}
                </Typography>
            </Box>
        );
    }

    private renderPauseButton(compact = false): React.JSX.Element {
        const disabled = !this.canPause;

        return (
            <Button
                type="button"
                disabled={disabled}
                title={t('lightburndm_pause')}
                onClick={(event: { stopPropagation: () => void }) => this.pauseJob(event)}
                startIcon={compact || !PauseIcon ? undefined : <PauseIcon sx={{ fontSize: 17 }} />}
                sx={{
                    boxSizing: 'border-box',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: compact ? 0 : 0.5,
                    minWidth: compact ? 30 : 82,
                    height: compact ? 30 : 32,
                    px: compact ? 0 : 1,
                    borderRadius: compact ? '50%' : '16px',
                    color: disabled ? 'text.disabled' : '#fff',
                    backgroundColor: disabled ? 'rgba(127,127,127,0.16)' : this.getAccentColor() || '#f45f42',
                    cursor: disabled ? 'default' : 'pointer',
                    fontSize: '0.78rem',
                    fontWeight: 700,
                    lineHeight: 1,
                    opacity: disabled ? 0.65 : 1,
                    textTransform: 'none',
                    transition: 'background-color 0.15s ease, opacity 0.15s ease',
                    '& .MuiButton-startIcon': {
                        mr: 0.5,
                        ml: 0,
                    },
                    '&:hover': disabled
                        ? {}
                        : {
                              filter: 'brightness(0.95)',
                          },
                    '&:focus-visible': {
                        outline: '2px solid currentColor',
                        outlineOffset: '2px',
                    },
                }}
            >
                {compact && PauseIcon ? <PauseIcon sx={{ fontSize: 18 }} /> : null}
                {compact ? null : t('lightburndm_pause')}
            </Button>
        );
    }

    override renderCompact(): React.JSX.Element {
        const body = (
            <Box
                sx={(theme: Theme) => ({
                    ...this.tileSx(theme),
                    aspectRatio: '1',
                    display: 'grid',
                    gridTemplateRows: 'auto 1fr auto auto',
                    gap: 0.75,
                })}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0, pr: 2.5 }}>
                    <Typography
                        ref={this.nameRef}
                        variant="caption"
                        noWrap
                        sx={{ flex: 1, minWidth: 0, fontWeight: 700, color: 'text.secondary' }}
                    >
                        {this.deviceName}
                    </Typography>
                    {this.renderPauseButton(true)}
                </Box>
                <Box sx={{ alignSelf: 'center', minWidth: 0 }}>
                    <Typography
                        variant="h4"
                        sx={{
                            fontWeight: 800,
                            lineHeight: 1,
                            letterSpacing: 0,
                            color: this.isTileActive() ? this.getAccentColor() || '#f45f42' : 'text.primary',
                        }}
                    >
                        {formatPercent(this.progress)}
                    </Typography>
                    <Typography
                        variant="caption"
                        noWrap
                        sx={{ color: 'text.secondary', fontWeight: 600 }}
                    >
                        {this.stateLabel}
                    </Typography>
                </Box>
                {this.renderProgress(6)}
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr', gap: 0.35, minWidth: 0 }}>
                    {this.renderMetaRow(t('lightburndm_remaining'), this.remaining)}
                    {this.renderMetaRow(t('lightburndm_file'), this.filename)}
                </Box>
            </Box>
        );

        return this.renderFrame(theme => WidgetGeneric.getStyleCompact(theme), body);
    }

    override renderWide(): React.JSX.Element {
        const body = (
            <Box
                sx={(theme: Theme) => ({
                    ...this.tileSx(theme),
                    minHeight: 80,
                    display: 'grid',
                    gridTemplateColumns: '92px minmax(0, 1fr)',
                    alignItems: 'center',
                    gap: 1.5,
                })}
            >
                <Box>
                    <Typography
                        variant="h5"
                        sx={{
                            fontWeight: 800,
                            lineHeight: 1,
                            letterSpacing: 0,
                            color: this.isTileActive() ? this.getAccentColor() || '#f45f42' : 'text.primary',
                        }}
                    >
                        {formatPercent(this.progress)}
                    </Typography>
                    <Typography
                        variant="caption"
                        noWrap
                        sx={{ color: 'text.secondary', fontWeight: 600 }}
                    >
                        {this.stateLabel}
                    </Typography>
                    <Box sx={{ mt: 0.75 }}>{this.renderPauseButton(false)}</Box>
                </Box>
                <Box sx={{ minWidth: 0, display: 'grid', gap: 0.45 }}>
                    {this.renderMetaRow(t('lightburndm_device_name'), this.deviceName, true)}
                    {this.renderProgress(5)}
                    <Box sx={{ display: 'grid', gridTemplateColumns: '96px minmax(0, 1fr)', gap: 1 }}>
                        {this.renderMetaRow(t('lightburndm_remaining'), this.remaining)}
                        {this.renderMetaRow(t('lightburndm_file'), this.filename)}
                    </Box>
                </Box>
            </Box>
        );

        return this.renderFrame(theme => WidgetGeneric.getStyleWide(theme), body);
    }

    override renderWideTall(): React.JSX.Element {
        const body = (
            <Box
                sx={(theme: Theme) => ({
                    ...this.tileSx(theme),
                    height: '100%',
                    display: 'grid',
                    gridTemplateRows: 'auto auto auto 1fr',
                    gap: 1,
                })}
            >
                <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 1, alignItems: 'start' }}>
                    {this.renderMetaRow(t('lightburndm_device_name'), this.deviceName, true)}
                    {this.renderPauseButton(false)}
                </Box>
                <Box>
                    <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}>
                        <Typography
                            variant="h4"
                            sx={{
                                fontWeight: 800,
                                lineHeight: 1,
                                letterSpacing: 0,
                                color: this.isTileActive() ? this.getAccentColor() || '#f45f42' : 'text.primary',
                            }}
                        >
                            {formatPercent(this.progress)}
                        </Typography>
                        <Typography
                            variant="caption"
                            noWrap
                            sx={{ color: 'text.secondary', fontWeight: 700 }}
                        >
                            {this.stateLabel}
                        </Typography>
                    </Box>
                    {this.renderProgress(7)}
                </Box>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                    {this.renderMetaRow(t('lightburndm_progress'), formatPercent(this.progress))}
                    {this.renderMetaRow(t('lightburndm_remaining'), this.remaining)}
                </Box>
                {this.renderMetaRow(t('lightburndm_file'), this.filename, true)}
            </Box>
        );

        return this.renderFrame(theme => this.getStyleWideSquare(theme), body);
    }
}

export default LightBurnStatusComponent;
