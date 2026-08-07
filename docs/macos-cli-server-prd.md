# Product Requirements: Movie Recorder Upload

## Document status

- Status: Draft for review
- Date: 2026-08-07
- Product: Movie Recorder Upload
- Package and executable: `movie-recorder-upload`
- Target platform: macOS

## 1. Summary

Rebuild the existing Electron desktop uploader as a macOS-only Node.js single
executable application (SEA). The executable runs as a command-line process and
serves a local web application for administration.

The product connects to Softron MovieRecorder Express, detects gang recording
sessions containing up to eight time-aligned files, validates completed media
with FFmpeg tooling, reconciles the session with Descript, and creates a single
multitrack Descript project when the session has not already been uploaded.

The rewrite deliberately removes Electron, OBS support, Windows support,
SQLite, OS credential-store integration, and GitHub Actions release automation.
This is a hard cutover: the replacement does not migrate or import any legacy
application data.

## 2. Problem

The existing desktop application carries platform, packaging, persistence, and
integration complexity that is no longer required. The production workflow is
macOS-only and centered on MovieRecorder Express. Operators need a reliable
background process with a familiar browser-based dashboard, not a native
desktop shell.

The replacement must be simple to install and operate while remaining safe
across process restarts, MovieRecorder disconnects, partially written files,
upload retries, and ambiguous Descript responses.

## 3. Goals

1. Distribute the application as a macOS Node.js SEA.
2. Start a local administration server whenever the executable launches.
3. Represent operator intent as one of two modes: `standby` or `watching`.
4. Restore configuration and unfinished recording work after a restart.
5. Connect only to Softron MovieRecorder Express.
6. Discover recording destinations from the MovieRecorder API whenever
   possible.
7. Treat a gang recording as one session with four files initially and up to
   eight files later.
8. Validate that every completed file is stable and structurally usable before
   upload.
9. Consider only recordings from the current local calendar day for new or
   retried uploads.
10. Prevent duplicate Descript imports through durable local state and remote
   reconciliation.
11. Preserve the useful dashboard and settings experience in a browser UI.
12. Keep all persisted state inspectable and recoverable without SQLite.

## 4. Non-goals

- Electron, a native application window, tray integration, or native file
  dialogs.
- OBS recording or OBS WebSocket support.
- Windows or Linux support.
- Multi-user or Internet-facing administration.
- Hosting the administration server on a public interface.
- Migrating or importing any existing Electron settings, SQLite ledger,
  credential-store secret, queue state, or application state.
- GitHub Actions builds, release publishing, or in-application auto-update.
- Starting, stopping, pausing, or otherwise controlling MovieRecorder
  recordings.
- Moving existing Descript projects when configuration changes.
- Editing the Descript API key through the web UI.

## 5. Users and operating environment

The primary user is a studio operator running the executable on a Mac that can:

- reach MovieRecorder Express over the local network;
- read the MovieRecorder recording destination directly or through a mounted
  volume;
- execute the required FFmpeg validation tool; and
- reach the Descript API and signed upload endpoints.

The first release targets Apple Silicon macOS. Intel macOS support is not a
release requirement unless explicitly added later.

## 6. Product principles

- **Local first:** management listens on loopback by default.
- **Durable before external:** persist intent before starting an upload.
- **Remote truth wins:** reconcile MovieRecorder and Descript rather than
  trusting stale process memory.
- **No silent loss:** uncertain sessions require review instead of being
  discarded.
- **Idempotent recovery:** a restart must not create a second Descript project.
- **Today only:** prior-day media never enters or re-enters the upload pipeline.
- **Operator-readable state:** JSON files and activity messages should explain
  what the application believes and why.

## 7. Launch and CLI behavior

Running the executable without a subcommand starts the application.

```text
movie-recorder-upload [--data-dir PATH] [--host HOST] [--port PORT] [--open]
```

Required behavior:

1. Resolve the application data directory.
2. Start the HTTP server so health and setup information are available even
   when configuration is missing or invalid.
3. Load configuration and recording records.
4. Validate but do not expose the Descript API key.
5. Recover unfinished recording and upload work.
6. Enter the desired `standby` or `watching` mode.
7. Print the administration URL and data-file locations to stdout.
8. Handle `SIGINT` and `SIGTERM` with an orderly shutdown and final state flush.

Default filesystem layout:

- State directory: `~/.movie-recorder-upload`
- Configuration: `~/.movie-recorder-upload/config.json`
- Recording ledger: `~/.movie-recorder-upload/records.json`
- Logs: `~/.movie-recorder-upload/logs/`
- Host: `127.0.0.1`
- Port: `8503`

`--data-dir PATH` relocates the complete state directory for development and
testing. CLI host and port options override the corresponding configuration for
that process. Relative data paths must not depend on the directory from which
the executable happens to be launched.

## 8. Configuration and secrets

### 8.1 Single configuration file

There is no `.env` file. `~/.movie-recorder-upload/config.json` is the sole
configuration source and contains both ordinary settings and secrets, including
the Descript API key and optional Softron password.

Requirements:

- The complete configuration document is never served, returned by an API, or
  included in UI state.
- Logs never contain the Descript key, Softron password, authorization headers,
  signed upload URLs, or complete secret-bearing request URLs.
- The application warns when `config.json` permissions are broader than
  owner-only.
- The state directory is created with mode `0700`; `config.json` and
  `records.json` are created with mode `0600`.
- The UI exposes only whether each required secret is configured and whether its
  most recent verification succeeded.
- A missing Descript key prevents upload but does not prevent the server from
  starting or MovieRecorder sessions from being recorded locally.
- Configuration snapshots stored in recording records omit API keys and
  passwords.

### 8.2 Hard-cutover policy

The new application is a fresh system rather than an upgrade of the Electron
application.

- The application creates new `config.json` and `records.json` files on first
  launch when they do not exist. The operator supplies the Descript API key in
  the new configuration file.
- It does not read or translate the old settings JSON, SQLite database, Keychain
  items, OBS configuration, or Electron application metadata.
- It does not infer that legacy queue rows are work that must be resumed.
- Legacy files are left untouched; removing or archiving them is an operator
  decision outside this product.
- Descript remote lookup remains mandatory for idempotency and duplicate
  prevention. It is not a data-migration mechanism.

### 8.3 Application configuration

`~/.movie-recorder-upload/config.json` stores all application configuration.

```ts
interface AppConfig {
  schemaVersion: 1;
  desiredMode: "standby" | "watching";
  server: {
    host: "127.0.0.1";
    port: number;
    openBrowser: boolean;
  };
  softron: {
    baseUrl: string;
    password: string | null;
    primarySourceId: string | null;
    enabledSourceIds: string[];
    destinationMappings: Record<string, string>;
  };
  descript: {
    apiKey: string | null;
    destinationRoot: string;
    // Local calendar timezone, initialized from the host Mac; never UTC by
    // default unless the Mac itself is configured for UTC.
    recordingTimezone: string;
    recordingDateFormat: "yy-MM-dd" | "M.d.yy" | "MM.dd.yy";
  };
  tools: {
    ffprobePath: string;
  };
}
```

`destinationMappings` maps a MovieRecorder destination `unique_id` to a locally
readable directory. A mapping may be filled automatically when the API path is
valid on the current Mac. Otherwise the operator must provide the mounted path.

Configuration changes apply to future sessions. Each session stores a snapshot
of the configuration that determines its source roles, local paths, Descript
folder, and project name. These snapshots exclude `descript.apiKey` and
`softron.password`.

## 9. System state model

The operator-facing mode has exactly two values:

- `standby`: the server and UI run, but the application does not maintain a
  MovieRecorder connection or watch recording destinations.
- `watching`: the application continually connects to MovieRecorder, observes
  recording state, watches destination files, and processes eligible sessions.

Connection health is separate from desired mode. A watching system may be
`connecting`, `connected`, `degraded`, or `disconnected` while it retries. This
distinction prevents a transient network failure from silently changing the
operator's requested mode back to standby.

Changing modes through the UI must be persisted before starting or stopping the
watcher. On restart, the application attempts to resume the persisted desired
mode.

## 10. Recording persistence

`~/.movie-recorder-upload/records.json` is the durable ledger for recording
sessions, files, and recent activity. It contains a schema version and stable
record IDs.

Minimum recording states:

```text
recording
connection_lost
finalizing
validating
reconciling
uploading
processing
completed
needs_review
failed
skipped
```

Each record contains, at minimum:

- stable local record ID;
- creation and update timestamps;
- MovieRecorder instance identity;
- session start and end timestamps;
- persisted local eligibility date and the timezone used to calculate it;
- participating source snapshots and stable source IDs;
- configured primary source ID;
- destination snapshots and local path mappings;
- discovered file paths and immutable file fingerprints;
- validation results;
- resolved Descript folder and deterministic project name;
- import payload hash and attempt ID;
- Descript project ID, job ID, and project URL when known;
- current status, retry count, and actionable error message.

### 10.1 JSON durability

All writes are serialized through one in-process writer. Persistence uses an
atomic replace strategy:

1. Serialize and validate the complete next document.
2. Write a temporary file in the same directory.
3. Flush the temporary file.
4. Rename it over the active file.
5. Retain a last-known-good backup.

The application must never update the JSON file in place. It must reject an
unsupported future schema version and surface a recovery error when neither the
active file nor backup can be parsed.

## 11. MovieRecorder integration

The integration uses the API documented by the target MovieRecorder Express
instance.

Required endpoints:

- `GET /info` verifies connectivity and product identity.
- `GET /sources` returns source identity, recording state, recording name,
  recording dates, enabled destinations, and available recording paths.
- `GET /destinations` returns stable destination IDs and filesystem paths.
- `ws://<host>:<port>/remote` with subprotocol
  `v1.1.main_update.movierecorder.softronmedia.com` provides low-latency source
  and destination change notifications.

The WebSocket is an acceleration mechanism. Periodic REST snapshots remain the
recovery and source-of-truth path. After connection loss or WebSocket reconnect,
the application fetches a complete REST snapshot and synthesizes any missed
start or stop transitions.

Stable `unique_id` values must be used instead of source indexes.

### 11.1 Destination discovery

At connection time, the application joins each source's enabled destination IDs
to `GET /destinations`.

- If a destination API path exists and is readable locally, use it.
- If it is not readable locally, require a configured destination mapping.
- Prefer an exact `destination_recording_path` returned for a source.
- Retain a directory baseline/delta fallback to find split files and recover
  when an exact path is missing.
- Refuse to start watching selected sources whose file destinations cannot be
  resolved locally.

## 12. Gang session behavior

The initial production configuration contains four simultaneous sources. The
data model and UI must support one through eight participating sources without
schema changes.

1. When the first selected source transitions into recording, persist a new
   `recording` record immediately.
2. Snapshot current sources, destinations, recording names, start dates,
   destination paths, and directory contents.
3. Coalesce near-simultaneous selected source starts into the same gang session.
4. Add a source to the session only when its start time and recording identity
   are consistent with that session; ambiguous late starts require review.
5. A source stopping does not finalize the gang while another participating
   source is still recording.
6. After all participating sources stop, confirm the state with `GET /sources`
   and begin finalization.
7. A MovieRecorder disconnect during recording changes the record to
   `connection_lost`; it is reconciled from a fresh snapshot after reconnection.
8. Manual splits belong to the same session and produce multiple clips on the
   corresponding Descript track.

Version one may enforce a single active gang session. If MovieRecorder presents
overlapping sessions that cannot be assigned deterministically, preserve all
candidate files and mark the affected record `needs_review`.

## 13. File discovery and validation

Candidate files are the union of:

- exact recording paths reported per source;
- files created or changed relative to the session's destination baseline; and
- files recovered during restart reconciliation that match the saved session
  window and source metadata.

Before media validation, each candidate must remain unchanged in size and
modification time across repeated probes. Zero-byte, missing, inaccessible, or
still-changing files do not upload.

FFmpeg tooling then validates each stable candidate. At minimum, validation
must confirm:

- the file can be opened by `ffprobe`;
- a supported video or audio stream is present;
- duration is finite and greater than zero;
- stream and container metadata can be read without fatal errors; and
- the file remains unchanged during validation.

Validation results and the FFmpeg tool version are persisted. Validation is
repeatable and may be retried from the UI. A failed file places the session in
`needs_review` or `failed`; no subset of a gang session uploads automatically.

A full decode of every frame is not required for version one unless review
decides that container and stream probing is insufficient. The deployment must
define whether `ffprobe` is bundled/extracted with the SEA or supplied separately
through `tools.ffprobePath`.

## 14. Descript integration and duplicate prevention

The Descript API key comes only from `config.json`. The server owns all Descript
requests.

### 14.1 Local-day reconciliation boundary

Discovery and reconciliation apply a strict "today" filter before a session can
enter validation or begin a new upload. "Today" means the calendar date in the
configured local recording timezone, initialized from the host Mac's current
IANA timezone. UTC is not used unless the host is intentionally configured to
use UTC.

At the beginning of each pass, the application captures one current instant and
derives local midnight at the start of that date and local midnight at the start
of the next date. It must use timezone-aware calendar boundaries rather than a
rolling 24-hour window so daylight-saving transitions remain correct.

Eligibility rules:

1. Prefer MovieRecorder's saved `recording_start_date` as the recording date.
2. When the API start date is missing, use the macOS filesystem creation time
   (`birthtime`) of the candidate file.
3. A file created before today's local midnight is ineligible even if it was
   modified today. Modification time must not promote old media into today's
   queue.
4. A file dated at or after the next local midnight is also ineligible and is
   reported as clock or metadata inconsistency.
5. When neither the API date nor a trustworthy creation time is available, do
   not upload automatically; retain the record for review.
6. Directory-baseline and reconciliation scans filter by this rule before
   probing, hashing, or calling Descript.
7. Records from earlier local dates remain visible as history but are not
   automatically discovered, validated, retried, or uploaded. Non-terminal
   records that never began a Descript import become `skipped` with an
   `outside_local_day` reason.
8. Manual retry actions cannot initiate a new upload for an earlier-date
   record.

A live gang session that was eligible when it began may finish normally if it
crosses local midnight. Its eligibility date is fixed and persisted when the
session is opened. If the application first discovers that stopped session only
after midnight, it is prior-day media and does not enter the upload pipeline.

Descript jobs or projects whose uploads already began while eligible may still
be polled after midnight so local history reaches a terminal state. This remote
status reconciliation must never submit new media or create a replacement
project for a prior-day record.

### 14.2 Duplicate prevention and import

Before creating an import, the application persists:

- the resolved Descript folder;
- deterministic project name;
- complete ordered file list;
- source roles and timeline offsets;
- a canonical import payload hash; and
- a stable local import attempt ID.

Reconciliation order:

1. If a Descript job ID is stored, query that job and update local state.
2. If a project ID is stored, query or otherwise verify that project.
3. Search the saved Descript folder for the deterministic project name.
4. When a matching project exists, associate it locally and do not create a new
   import.
5. Only when no job or project can be reconciled may the application submit a
   new import.

The import creates one Descript project containing one multitrack `Recording`
composition. The configured primary source is the Program track and all other
participating sources are ISO tracks. Timeline offsets derive from the saved
MovieRecorder start timestamps and file timestamps. Manual split files appear
as ordered clips on their source track.

The complete gang is submitted as one import. Automatic upload is blocked when:

- no primary source can be identified;
- any selected file is missing, unstable, or invalid;
- a file cannot be associated with a source;
- the payload exceeds Descript limits; or
- remote reconciliation is inconclusive.

Signed upload URLs are ephemeral and must not be persisted or logged.

## 15. Restart and recovery

On every launch, recovery runs before new uploads begin.

Recovery evaluates the local-day boundary first. A prior-day record with no
persisted Descript job or project is not resumed and becomes `skipped` with an
`outside_local_day` reason. A prior-day record that already owns a Descript job
or project may perform read-only remote status checks, but recovery must not
create an import, request replacement upload URLs, or resume sending local
media. The exception is a persisted eligible gang that MovieRecorder still
reports as actively recording; it may remain active and finish under the local
date fixed when the session began.

- `recording` or `connection_lost`: query MovieRecorder and reconstruct the
  active or recently stopped session.
- `finalizing` or `validating`: rediscover and revalidate the saved candidates.
- `reconciling`, `uploading`, or `processing`: query Descript before considering
  a new import.
- `needs_review` or `failed`: preserve the record without automatic destructive
  changes.
- `completed` or `skipped`: require no automatic work.

If local and remote evidence conflict, prefer `needs_review` over a duplicate
upload. Recovery actions append operator-readable activity entries.

## 16. Administration server and UI

The server binds to `127.0.0.1` by default and serves the React administration
application and JSON API from one origin. Version one has no user accounts and
must refuse non-loopback binding unless an explicit future security mode is
implemented.

The server must validate `Host` and `Origin`, reject cross-origin state-changing
requests, set restrictive security headers, and avoid permissive CORS. A
per-launch bootstrap token or equivalent same-origin session mechanism protects
state-changing local endpoints from drive-by browser requests.

The UI remains visually similar to the existing application and includes:

- current standby/watching mode and an explicit mode control;
- MovieRecorder connection health and last successful snapshot;
- configured/missing Descript key status and connection-test result;
- discovered sources, recording indicators, primary source, and destinations;
- destination mapping health;
- active gang session and participating files;
- queue/history grouped by status;
- validation and upload progress;
- actionable errors and retry/reconcile controls;
- recent activity; and
- settings for configuration fields that are safe to expose and edit.

The Descript API key is never displayed or editable in the UI. The UI tells the
operator which `config.json` path is in use and requires a process restart after
the API key changes unless hot reload is intentionally added later. UI-driven
configuration updates preserve secret fields without returning them to the
browser.

Server-sent events are preferred for live state updates unless bidirectional
WebSockets materially simplify the implementation. Mutations use ordinary HTTP
requests with schema validation.

## 17. Minimum administration API

The exact route names are implementation details, but the UI requires
equivalent capabilities:

- read application snapshot and health;
- read a redacted configuration view and update UI-editable fields;
- enter standby or watching mode;
- test MovieRecorder connectivity and refresh sources/destinations;
- test the configured Descript key;
- list records and inspect one record;
- retry discovery, validation, reconciliation, or upload for a record;
- mark a record skipped or restore it to review;
- select a primary source when automatic association is inconclusive; and
- stream state/activity changes.

All inputs are validated. Errors return stable machine codes plus concise
operator messages.

## 18. Packaging and distribution

- Electron and `electron-builder` are removed.
- `better-sqlite3`, `keytar`, and OBS-specific dependencies are removed.
- The production server bundle and web assets are embedded in a macOS SEA.
- Builds are local npm scripts; `.github/workflows` is removed.
- The executable reports its version and build metadata through the CLI and UI.
- The SEA build is reproducible for the supported macOS architecture.
- Signing and notarization are not automated by GitHub Actions. If required for
  distribution, they must be handled by a documented local release command.

The records, configuration, and logs remain external data files and are never
embedded in replacement executables.

## 19. Logging and diagnostics

Logs are structured and written to stdout. An optional rotating file sink may be
added inside the data directory.

Every material transition logs the record ID, source IDs, state transition, and
result. Logs must not contain secrets, signed URLs, or secret configuration
values.

Health output distinguishes:

- server health;
- configuration validity;
- MovieRecorder reachability;
- destination readability;
- FFmpeg availability;
- Descript credential status; and
- watcher/recovery health.

## 20. Testing requirements

Automated tests must cover:

- configuration validation, redaction, and file-permission warnings;
- atomic JSON persistence, backups, corrupt-file recovery, and schema versions;
- standby/watching restoration;
- MovieRecorder source and destination parsing;
- WebSocket reconnect plus missed REST transitions;
- four- and eight-source gang starts and partial stops;
- connection loss during recording;
- exact-path and directory-delta discovery;
- local-calendar today filtering, daylight-saving boundaries, and rejection of
  old files modified today;
- manual splits and unrelated files in a destination;
- file-stability and FFmpeg validation outcomes;
- source association, primary selection, and timeline offsets;
- Descript payload generation and upload retries;
- crash recovery at every external-request boundary;
- duplicate project prevention;
- API validation and loopback security; and
- UI rendering for setup, standby, watching, recording, review, failure, and
  completion states.

At least one manual acceptance run must use a real four-source MovieRecorder
gang recording and confirm the resulting Descript multitrack alignment.

## 21. Acceptance criteria

1. A macOS executable starts the administration server without Electron or an
   installed Node.js runtime.
2. The UI loads from the printed loopback URL.
3. The application runs with only JSON persistence and no SQLite dependency.
4. Standby/watching intent survives restart.
5. Watching reconnects to MovieRecorder automatically after transient failure.
6. Source and destination discovery uses stable MovieRecorder IDs.
7. A four-source gang start creates one durable pending record before upload.
8. The record does not finalize until every participating source has stopped.
9. Up to eight source files can be represented without a schema change.
10. Destination API paths are used when readable and explicit mappings are
    required otherwise.
11. Reconciliation considers only the current local calendar day, never a UTC
    date or rolling 24-hour window.
12. Files created before today cannot enter or re-enter the upload pipeline,
    even when modified today.
13. Every upload candidate is stable and passes the defined FFmpeg validation.
14. A failed or ambiguous gang is retained for review and is not partially
    uploaded.
15. A valid gang produces one Descript project with a synchronized primary and
    ISO tracks.
16. Restarting during finalization, upload, or Descript processing does not
    create a duplicate project.
17. The Descript key exists only in `config.json` and process memory. It is
    absent from `records.json`, logs, API responses, and web assets.
18. Electron, OBS support, Windows packaging, SQLite, keytar, and GitHub Actions
    are absent from the finished package.
19. Legacy application files are neither imported nor deleted by the rewrite.

## 22. Review decisions

The following decisions should be resolved before implementation is considered
fully specified:

1. **Execution location:** Will the SEA run on the MovieRecorder Mac, or will it
   read a mounted destination from another Mac?
2. **FFmpeg distribution:** Bundle/extract a known `ffprobe` binary, require a
   Homebrew/system installation, or support both?
3. **Validation depth:** Is metadata/stream probing sufficient, or must every
   frame be decoded before upload?
4. **Launch behavior:** Should the CLI open the browser automatically by
   default, only with `--open`, or never?
5. **Background operation:** Is a documented `launchd` LaunchAgent required for
   version one, or will an operator keep the CLI process running?
6. **Session membership:** Confirm the gang coalescing window and behavior for a
   source that starts materially later than the others.
7. **Descript naming:** Confirm the destination folder and deterministic project
   naming convention retained from the existing application.
8. **History controls:** Confirm whether operators need skip, delete, hide, and
    retry actions, or only retry and inspect.
