# ioBroker.lightburn

Unofficial ioBroker adapter for LightBurn.

This adapter talks to LightBurn through its UDP automation interface. It can send
basic LightBurn commands from ioBroker states, for example loading a file,
importing a file, selecting a laser, starting the current job, checking status,
pinging LightBurn, and closing LightBurn.

## Requirements

- ioBroker with js-controller 6.0.11 or newer
- Node.js 20 or newer
- LightBurn with UDP automation support
- Network access from the ioBroker host to the computer running LightBurn

LightBurn listens for commands on UDP port `19840` and responds on UDP port
`19841` by default.

## Configuration

In the adapter instance settings:

- `LightBurn host/IP`: IP address of the LightBurn computer. Use `127.0.0.1`
  when ioBroker and LightBurn run on the same machine.
- `UDP command port`: default `19840`.
- `UDP response port`: default `19841`.
- `Local bind address`: default `0.0.0.0`.
- `Command timeout`: how long the adapter waits for a UDP response.
- `Status polling interval`: automatic `STATUS` polling in seconds. Set `0`
  to disable.

## States

### Info states

- `info.connection`: true when LightBurn responds successfully.
- `info.busy`: true when `STATUS` returns `!`, which means the laser is busy.
- `info.lastCommand`: last UDP command sent by the adapter.
- `info.lastResponse`: last raw response from LightBurn.
- `info.lastError`: last adapter-side error.

### Control states

- `control.start`: sends `START`.
- `control.status`: sends `STATUS`.
- `control.ping`: sends `PING`.
- `control.close`: sends `CLOSE`.
- `control.forceClose`: sends `FORCECLOSE`.
- `control.loadFile`: sends `LOADFILE:<path>`.
- `control.forceLoad`: sends `FORCELOAD:<path>`.
- `control.importFile`: sends `IMPORT:<path>`.
- `control.laser`: sends `LASER:<name>`.
- `control.command`: sends a raw command line.

LightBurn returns `OK` for success, `!` for unsuccessful or busy, and `?` for an
invalid command.

## Safety

This adapter can start a laser job. Keep LightBurn and the laser under direct
supervision and use the usual machine safety checks before triggering `START`.

## Install locally

From an ioBroker host, install the adapter from a Git repository or from a local
folder during development:

```bash
iob url https://github.com/friebe/ioBroker.lightburn
```

For a local development copy:

```bash
npm install
npm test
```

## Disclaimer

This is an unofficial adapter and is not affiliated with LightBurn Software.
LightBurn is a trademark of LightBurn Software.
