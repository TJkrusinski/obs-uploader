# Movie Recorder Upload

Movie Recorder Upload is a macOS command-line application that watches Softron
MovieRecorder Express gang recordings and creates one synchronized multitrack
Descript project per session. It serves its administration dashboard on
`127.0.0.1`; Electron, OBS, SQLite, OS credential stores, and legacy-data
migration are intentionally not part of this product.

## Run from source

Requirements: Node.js 24+, `ffprobe` on `PATH` (or an explicit configured path),
and a Mac that can read each MovieRecorder destination or mounted equivalent.

```bash
npm install
npm run build
node dist-server/main/main.js --data-dir .local-data --open
```

The default URL is `http://127.0.0.1:8503`. The complete CLI is:

```text
movie-recorder-upload [--data-dir PATH] [--host 127.0.0.1] [--port PORT] [--open]
```

The application creates `config.json` and `records.json` with mode `0600` in a
state directory with mode `0700`. Without `--data-dir`, that directory is
`~/.movie-recorder-upload`. Add the Descript API key directly to `config.json`;
it cannot be viewed or edited in the browser.

```json
{
  "schemaVersion": 1,
  "desiredMode": "standby",
  "server": { "host": "127.0.0.1", "port": 8503, "openBrowser": false },
  "softron": {
    "baseUrl": "http://192.168.1.20:8080",
    "password": null,
    "primarySourceId": null,
    "enabledSourceIds": ["stable-program-source-id", "camera-2", "camera-3", "camera-4"],
    "destinationMappings": { "movie-destination-id": "/Volumes/Studio Recordings" }
  },
  "descript": {
    "apiKey": "replace-in-config-only",
    "destinationRoot": "Studio",
    "recordingTimezone": "America/Los_Angeles",
    "recordingDateFormat": "yy-MM-dd"
  },
  "tools": { "ffprobePath": "ffprobe" }
}
```

Start in standby, test both services in the dashboard, select one to eight stable
source IDs, and map any MovieRecorder destination that is not directly readable
on this Mac. Entering watching mode is refused while a selected source has an
unresolved destination.

Channel 1 (the first selected source in MovieRecorder's API order) is always the
Program source. Discovered files are naturally sorted by filename and paired
one-to-one with channels 1 through N; channel 2 onward become ascending ISO
tracks. A file/channel count mismatch is retained for review.

## Persistence and recovery

Every ledger mutation is serialized, fsynced, atomically renamed, and backed up
as `records.json.bak`. Sessions snapshot non-secret configuration, stable source
and destination IDs, file fingerprints, ffprobe results, and Descript import
identifiers. Recovery uses job/project lookup before any new import. Prior-day
media remains visible but cannot start or restart an upload.

## Apple Silicon single executable

Build the ad-hoc-signed local SEA with:

```bash
npm run build:sea
release/movie-recorder-upload --version
```

The build embeds the production server bundle and hashed web assets in an
Apple-Silicon Node.js SEA at `release/movie-recorder-upload`; it does not require
Node.js on the target Mac. The local build performs ad-hoc signing. Production
Developer ID signing and notarization, if desired, are an operator-managed local
release step.

## Implemented operating decisions

- MovieRecorder API paths are preferred; destination mappings support mounted
  volumes on another Mac.
- `ffprobe` is supplied by the host and performs container/stream probing, not a
  full frame decode.
- The browser opens only with `--open` or `server.openBrowser: true`.
- Gang starts coalesce within ten seconds; ambiguous later starts require review.
- Operators run the process directly; no LaunchAgent is installed.
- Project folders use the configured local recording date, and project names use
  the saved recording name plus `YYYY-MM-DD_HH-mm-ss`.

## Verification

```bash
npm run typecheck
npm test
npm run build:sea
```

The automated suite covers configuration redaction and permissions, atomic JSON
recovery and schema rejection, local-calendar behavior including DST, Softron
parsing and file association, media validation, import payload safety, and the
loopback API security boundary. A production release still requires the PRD's
manual four-source MovieRecorder-to-Descript alignment acceptance run.
