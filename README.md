# ioBroker.lightburn

Unofficial ioBroker adapter for LightBurn.

This adapter reads LightBurn state through the official LightBurn REST API. It
can show job progress, machine position, connected device information, current
project metadata, layers, cut settings, jog settings, and override values in
ioBroker.

Legacy UDP control commands are still available behind an explicit setting for
actions that are not currently exposed by the REST API, such as starting the
current job.

## Requirements

- ioBroker with js-controller 6.0.11 or newer
- Node.js 20 or newer
- LightBurn with REST API support
- Network access from the ioBroker host to the computer running LightBurn

LightBurn REST uses fixed HTTP port `19520`.

## LightBurn setup

LightBurn serves the REST API whenever LightBurn is open.

By default the API is reachable only on the LightBurn computer through
`localhost:19520`. To access it from another computer, enable:

```text
Settings > Extensions > Allow API Access From Network
```

Pairing is always localhost-only. If ioBroker runs on the same computer as
LightBurn, set `restHost` to `127.0.0.1` and click **Pair with LightBurn** in
the adapter settings, or trigger `control.pair`. LightBurn will show a consent
dialog. Approve it within 30 seconds.

If ioBroker runs on another computer, pair a local helper on the LightBurn
computer and paste the resulting secret into the adapter settings.

For Windows, the adapter configuration offers a download button for a small
helper. The file is also included in the adapter admin files:

```text
admin\pair-lightburn.cmd
```

Run it on the LightBurn computer. It opens the LightBurn consent dialog, prints
the returned secret, and copies it to the clipboard.

## Adapter configuration

- `LightBurn REST host/IP`: IP address of the LightBurn computer. Use
  `127.0.0.1` when ioBroker and LightBurn run on the same machine.
- `REST API port`: fixed LightBurn port `19520`.
- `Pairing application name`: name shown in the LightBurn consent dialog.
- `REST API secret`: HMAC shared secret returned by LightBurn pairing.
- `Pair with LightBurn`: sets `control.pair` to `true` and stores the returned
  secret automatically. This only works when the adapter instance runs on the
  LightBurn computer.
- `Download Windows pairing helper`: downloads `pair-lightburn.cmd` from the
  adapter. Use it on the LightBurn computer when ioBroker runs elsewhere.
- `State polling interval`: polls `/api/events/poll` for job progress and
  position.
- `Poll project, layers, and cuts`: also polls `/api/project`, `/api/layers`,
  and `/api/cuts`.
- `Project polling interval`: slower polling interval for project data.
- `Enable legacy UDP control commands`: enables `START`, `PAUSE`, `CLOSE`,
  `FORCECLOSE`, and raw UDP commands. Leave disabled unless you explicitly need
  these actions.

## States

### Important status states

- `info.connection`: machine/device connection reported by LightBurn.
- `info.apiConnection`: REST API request success.
- `info.apiPaired`: adapter has a REST secret.
- `info.lastEndpoint`: last REST endpoint used.
- `info.lastError`: last adapter-side error.

### Job states

- `job.state`: `idle`, `running`, or `paused`.
- `job.running`: true when the job is running.
- `job.paused`: true when the job is paused.
- `job.progressPercent`: REST-reported progress from 0 to 100.
- `job.startedAt`: adapter-observed start timestamp.
- `job.elapsedSeconds`: elapsed time observed by the adapter.
- `job.estimatedTotalSeconds`: estimated total runtime from elapsed time and
  progress.
- `job.remainingSeconds`: estimated remaining time.

LightBurn REST provides progress directly. Remaining time is calculated by the
adapter from progress and observed elapsed time.

### Position and machine states

- `position.machine.x`, `position.machine.y`, `position.machine.z`
- `position.workpiece.x`, `position.workpiece.y`, `position.workpiece.z`
- `device.connected`
- `device.name`
- `device.supportsZ`
- `device.supportsOverrides`

### Project data

- `project.filename`
- `project.modified`
- `project.shapeCount`
- `project.deviceName`
- `project.units.distance`
- `project.units.speed`
- `project.raw`
- `layers.raw`
- `cuts.raw`

The raw states contain the JSON returned by LightBurn for dashboards or custom
scripts.

## ioBroker.devices widget

The adapter includes a widget for the `ioBroker.devices` dashboard. Add it in
the Devices dashboard with **+ > LightBurn status** and select the LightBurn
adapter instance. The widget supports `1x1`, `2x0.5`, `2x1`, and `2x2`.

The widget shows:

- `device.name`: Device Name
- `job.progressPercent`: progress in percent
- `job.remainingSeconds`: estimated remaining runtime
- `project.filename`: currently opened LightBurn file

The Pause button writes `true` to `control.pause`. Like `control.start`, this
uses LightBurn's legacy UDP command interface and requires
`Enable legacy UDP control commands`.

### Upload states

- `control.uploadFile`: write a local file path to import that file into the
  current LightBurn project.
- `control.openFile`: write a local file path to open that file as the new
  LightBurn project.
- `upload.lastFile`
- `upload.lastMode`
- `upload.lastResponse`

The file path must be readable by the ioBroker host.

### Legacy UDP control states

These require `Enable legacy UDP control commands`.

- `control.start`: sends UDP `START`.
- `control.pause`: sends UDP `PAUSE`.
- `control.close`: sends UDP `CLOSE`.
- `control.forceClose`: sends UDP `FORCECLOSE`.
- `control.udpCommand`: sends a raw UDP command line.
- `info.lastUdpCommand`
- `info.lastUdpResponse`

## What the REST API does not provide

The current public REST API does not expose camera images, LightBurn's visual
preview, or direct start/stop job control. Camera streams must be exposed
separately, for example by using an IP camera or an MJPEG/RTSP bridge for a USB
camera.

## Safety

Remote monitoring and automation are not safety systems. Keep LightBurn and the
laser under direct supervision and use the usual machine safety checks before
triggering any machine action.

## Install locally

From an ioBroker host, install the adapter from a Git repository:

```bash
iob url https://github.com/friebe/ioBroker.lightburn
```

For a local development copy:

```bash
npm install
npm test
```

## References

- [LightBurn REST API](https://github.com/LightBurnSoftware/LightBurn-REST)
- [LightBurn REST getting started](https://github.com/LightBurnSoftware/LightBurn-REST/blob/main/docs/getting-started.md)
- [LightBurn REST OpenAPI specification](https://github.com/LightBurnSoftware/LightBurn-REST/blob/main/docs/openapi.yaml)

## Disclaimer

This is an unofficial adapter and is not affiliated with LightBurn Software.
LightBurn is a trademark of LightBurn Software.
