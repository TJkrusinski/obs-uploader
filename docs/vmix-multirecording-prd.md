# PRD: OBS and vMix Multi-Recording → Descript Uploader

**Status:** Proposed
**Revision:** 1
**Platforms:** Windows and macOS desktop application
**Primary vMix platform:** Windows
**Working product name:** Recording Upload
**Existing product:** OBS Upload

## 1. Summary

Extend the existing OBS-to-Descript uploader to support vMix, including vMix MultiCorder ISO recordings.

The product will shift from a file-oriented model—where every discovered file becomes its own Descript project—to a session-oriented model:

> One production session becomes one Descript project containing the program recording and all associated ISO recordings.

A session may include:

- One primary or program recording.
- Zero or more ISO recordings.
- Multiple sequential file segments from any source.
- Files distributed across multiple configured directories.
- Video recordings only; audio-only files are not eligible for upload.
- Recordings produced by OBS or vMix.

Every finalized vMix video clip is uploaded intact as a separate track in one Descript multitrack sequence. Manifest frame positions determine track offsets, Program is ordered first, and the `Recording` composition contains that sequence exactly once.

Split recordings use stacked-clip mode: each physical `clipitem` remains an independent sequence track at its XMEML timeline position. The application does not silently concatenate or transcode source media.

## 2. Problem

The current application assumes:

- OBS is the only recording source.
- OBS reports the exact completed file path through WebSocket.
- One recording event produces one file.
- Every file should create an independent Descript project.
- Only one recordings directory needs to be monitored.

These assumptions do not hold for vMix productions.

A typical vMix production may generate:

- A program recording.
- Multiple camera ISO recordings through MultiCorder.
- Separate files for calls, presentations, or clean feeds.
- Periodically split files from the same source.
- Files in separate directories or storage volumes.
- Multiple files with identical basenames.
- A main recording and MultiCorder recordings that start or stop several seconds apart.

Uploading every ISO as a separate Descript project would fragment a single production across many projects and make the media difficult to locate and use.

vMix’s HTTP API exposes `recording` and `multiCorder` state, but does not provide the completed file paths. File discovery must therefore remain directory-based. See the [vMix HTTP API documentation](https://www.vmix.com/help28/DeveloperAPI.html).

## 3. Product decision

The application will introduce a first-class **capture session**.

A capture session represents one production recording period and owns all files generated during that period.

The model becomes:

```text
Capture session
├── Primary source
│   ├── Program Part 1.mp4
│   └── Program Part 2.mp4
├── ISO: Camera 1
│   ├── Camera 1 Part 1.mp4
│   └── Camera 1 Part 2.mp4
├── ISO: Camera 2
│   └── Camera 2.mp4
└── ISO: Presentation
    └── Presentation.mp4
```

The corresponding Descript structure will be:

```text
<configured root>/<date>/
└── <session project name>
    ├── Composition: Recording
    │   └── MultiCorder Sequence
    └── Media / MultiCorder Sequence tracks
        ├── Program Part 1
        ├── Program Part 2
        ├── Camera 1 Part 1
        ├── Camera 1 Part 2
        ├── Camera 2
        └── Presentation
```

All physical clips are synchronized in `MultiCorder Sequence` from finalized XMEML frame placement. `Recording` references the sequence once; individual files are never appended directly to the composition.

## 4. Goals

### Primary goals

1. Support both OBS and vMix as recording sources.
2. Support one primary recording and multiple ISO recording locations.
3. Group files from the same production into one capture session.
4. Create exactly one Descript project per capture session.
5. Include all eligible program and ISO media in that project.
6. Prevent active or partially finalized files from uploading.
7. Preserve correct grouping across file splits.
8. Recover safely from application restarts, network interruptions, and partial uploads.
9. Preserve existing OBS functionality.
10. Make the session and individual-file states visible to the operator.
11. Preserve manifest-derived synchronization within one frame.

### Secondary goals

- Support vMix running on another machine when its recording directories are mounted locally.
- Support UNC paths and mapped Windows drives.
- Support vMix without its HTTP API using filesystem activity as a fallback.
- Provide deterministic project naming and reconciliation.
- Allow one ISO source to be designated as primary for ISO-only productions.

## 5. Non-goals

The initial release will not:

- Automatically align ISO recordings using timecode or audio.
- Consolidate split files into one generated file per logical source.
- Switch camera angles based on the vMix program cut.
- Transcode unsupported media.
- Ingest a live NDI, SRT, or SDI stream.
- Copy files directly from an inaccessible remote vMix machine.
- Control Start Recording, Stop Recording, or MultiCorder from the uploader.
- Support vMix Instant Replay session media.
- Automatically reconstruct arbitrary historical MultiCorder sessions when the application was not monitoring them.
- Automatically associate unrelated graphics, images, or production assets.
- Modify or move existing Descript projects.
- Combine simultaneous OBS and vMix sources into the same session.
- Upload files while a session is still actively recording.

## 6. Terminology

| Term | Definition |
|---|---|
| Recorder | OBS or vMix |
| Capture session | One production recording period and its associated media |
| Primary source | The Program or operator-selected source ordered first in the multitrack sequence |
| ISO source | An independently recorded camera, call, output, or other source |
| Recording location | A configured local or mounted directory monitored for media |
| Segment | One of several sequential files generated for the same source |
| Finalizing | The period after recording stops while files are still closing or appearing |
| Ready | All session files are stable and the session can upload |
| Media key | The unique name used for a file inside a Descript import request |
| Program recording | The switched or primary production output |

## 7. Supported workflows

### 7.1 OBS single recording

An OBS user records one program file.

The application receives the exact stopped file path from OBS, creates a session containing that file as the primary source, finalizes the session, and creates one Descript project.

This must behave substantially like the current product.

### 7.2 vMix program-only recording

A vMix user records the main program output.

The application detects that vMix recording has started, opens a session, discovers the resulting file in the configured program directory, and waits for vMix to stop.

After the file becomes stable, it creates one Descript project containing that file and a `Recording` composition.

### 7.3 vMix program plus ISO recordings

The user starts the vMix main recorder and MultiCorder.

The application opens one session when either recorder becomes active. Files from the program and configured ISO directories are attached to that session.

The session stays open until both the main recorder and MultiCorder have stopped. All media is then uploaded to one Descript project.

### 7.4 MultiCorder-only recording

The user runs MultiCorder without the main vMix recorder.

One manifest track must be designated as the primary source. Its physical clips are ordered first in `MultiCorder Sequence`; all other ISO clips follow in manifest order, and `Recording` references the sequence once.

### 7.5 Split recordings

vMix may split a recording into a new file every configured number of minutes. See the [vMix MultiCorder documentation](https://www.vmix.com/help28/MultiCorder.html).

Every split file remains part of the same capture session. Each physical XMEML `clipitem` becomes a sequence track whose offset is calculated from its manifest start frame. Split files are not concatenated; a session exceeding 14 physical clips moves to `needs_review`.

The application does not upload a completed segment while the overall session remains active.

### 7.6 Remote vMix machine

The uploader may run on a different computer from vMix if:

- The vMix API is reachable from the uploader.
- Every recording directory is mounted or shared.
- The uploader has read access to the mounted directory.
- The configured path is meaningful on the uploader machine.

The vMix API’s Windows path is not assumed to be accessible or automatically translated. The operator explicitly selects the locally accessible path.

### 7.7 Folder-only vMix mode

If the vMix Web API is unavailable or intentionally disabled, the application may group files using filesystem activity.

The UI must identify such sessions as `Filesystem inferred`. API-connected sessions are identified as `vMix confirmed`.

## 8. Recorder configuration

The Settings screen will include a **Recording source** section.

### 8.1 Recorder selection

Field:

```ts
type RecorderType = 'obs' | 'vmix'
```

Options:

- OBS Studio
- vMix

Changing the recorder applies to future sessions. It does not reclassify existing sessions.

Monitoring must restart when the active recorder changes.

### 8.2 OBS configuration

Retain:

- Host
- WebSocket port
- Password
- Connect and detect folder
- Connection test

OBS’s detected recording directory becomes the default primary recording location. The operator may override it with a locally accessible directory.

### 8.3 vMix configuration

Fields:

- Host, default `127.0.0.1`
- HTTP API port, default `8088`
- Use vMix API toggle
- Test connection
- Connection status
- Last successful poll
- Current main recording state
- Current MultiCorder state

The application polls the vMix XML API and reads:

```xml
<recording>True</recording>
<multiCorder>True</multiCorder>
```

The application will not expose controls that start or stop vMix recording.

### 8.4 Recording locations

The user configures one or more recording locations.

Each location contains:

```ts
interface RecordingLocation {
  id: string
  path: string
  label: string
  role: 'primary' | 'iso'
  enabled: boolean
  filenameFilter: string | null
}
```

Example:

| Label | Role | Directory | Filter |
|---|---|---|---|
| Program | Primary | `D:\Recordings\Program` | None |
| Camera 1 | ISO | `D:\Recordings\Camera 1` | None |
| Camera 2 | ISO | `E:\ISO\Camera 2` | None |
| Calls | ISO | `E:\ISO\Calls` | `Call*` |

Requirements:

- Exactly one enabled location must be primary.
- Zero or more ISO locations may be configured.
- Every enabled location must be readable.
- Paths may be local, mapped drives, or UNC paths.
- A path may be used more than once only when filename filters are non-overlapping.
- Duplicate canonical paths without filters are rejected.
- Location labels must be unique after case-insensitive normalization.
- Changes apply only to sessions opened after saving.
- Each session persists a snapshot of its recording-location configuration.

### 8.5 Folder validation

The application will verify:

- The directory exists.
- The directory is readable.
- The directory can be enumerated.
- The path does not point to a file.
- The directory is not duplicated accidentally.
- The filename filter is syntactically valid.
- At least one supported file type can be selected by the filter.

Write access is not required.

## 9. Session lifecycle

A session has the following states:

```ts
type CaptureSessionStatus =
  | 'recording'
  | 'connection_lost'
  | 'finalizing'
  | 'needs_review'
  | 'ready'
  | 'uploading'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'canceled'
```

### 9.1 Opening a vMix session

When API integration is enabled, a session opens when either state transitions from inactive to active:

```text
recording: False → True
multiCorder: False → True
```

If the second recording mode becomes active while a session is already open, it joins the current session.

The session start time is the earliest of:

1. The observed vMix transition.
2. The creation time of the first associated file.
3. A persisted start time from a recovered session.

### 9.2 Closing a vMix session

A session begins finalizing when:

```text
recording = False
AND
multiCorder = False
```

Both states must remain false for at least five seconds to avoid closing on a brief transition.

### 9.3 Folder-only session opening

Without API state:

- The first new eligible file or actively growing candidate opens a session.
- Additional files discovered while the session is open join it.
- Any file creation, size change, or modification resets the session activity timer.

### 9.4 Folder-only session closing

A folder-inferred session enters finalization after:

- No candidate file has changed for 60 seconds.
- No new candidate has appeared for 60 seconds.
- Every known candidate passes file-stability validation.

The longer quiet window is intentional because there is no authoritative recorder state.

### 9.5 Finalization grace period

When a session enters `finalizing`:

1. Continue scanning all session locations.
2. Wait at least 15 seconds for late file creation or rename events.
3. Require every included file to be stable.
4. Reset the 15-second timer whenever a new file appears.
5. Transition to `ready` only after all conditions pass.

If finalization does not complete within ten minutes, transition to `needs_review`.

### 9.6 API connection loss

If vMix becomes unreachable during an active session:

- Preserve the open session.
- Continue monitoring all configured directories.
- Set the session to `connection_lost`.
- Do not assume recording has stopped.
- Attempt to reconnect automatically.
- Return to `recording` if vMix reports an active recorder.
- Enter `finalizing` if vMix reconnects and reports both recorders inactive.

After ten minutes of connection loss and filesystem quiet, the session becomes `needs_review`. It must not upload automatically unless the operator explicitly finalizes it.

### 9.7 Manual finalization

For a `needs_review` session, the operator can select **Finalize session**.

Before accepting:

- No included file may currently be changing.
- Every file must pass stability validation.
- The operator receives a warning that recorder state could not be confirmed.

The finalization source is persisted as `manual`.

## 10. File discovery and stability

### 10.1 Discovery mechanisms

Each enabled directory uses:

- Native filesystem watching for low-latency discovery.
- Periodic directory scans as a reliability fallback.
- A targeted scan after a vMix stop transition.
- A startup scan for session recovery.

Filesystem watching alone is not considered reliable enough for network shares.

### 10.2 Candidate eligibility

A file is eligible when:

- It is a regular file.
- It matches the location’s filter.
- It has a supported extension.
- It was not present in the location baseline before the session.
- Its creation or first-observed time falls within the session window.
- It is not already assigned to another session.
- It is not a known temporary or partial filename.

Path comparisons must respect Windows case-insensitive behavior.

### 10.3 Stability validation

A file is stable when:

- Its size is greater than zero.
- Its size is unchanged across three probes.
- Its modification time is unchanged across the same probes.
- Probes occur at least two seconds apart.
- The file remains present and readable.
- Its video container exposes readable duration, dimensions, native frame rate, frame count when available, and audio-channel metadata.
- Its reported duration covers the physical source duration declared by XMEML.
- Its frame rate, frame count, dimensions, and audio-channel count match the XMEML file declaration whenever those fields are present.
- Its final three seconds decode without a video error.
- Its size and modification time remain unchanged throughout metadata inspection and tail decoding.
- It can be opened read-only and its final byte can be read from the same stable snapshot.
- The file is not known to be the current active output.
- The session has entered finalization, unless the file is merely being recorded in the ledger without uploading.

A stable split segment may be attached to an active session, but it will not upload until the session closes.

Opening a file with Node's filesystem API is an accessibility check, not proof that an external Windows process has closed every handle. vMix may share a file while it remains open, and Node does not expose an exclusive `CreateFile` share mode. When API status is enabled, active Recorder or MultiCorder state is the authoritative guard; quiet-window, read-handle, ffprobe, and tail-decode checks provide the filesystem fallback.

An empty or not-yet-created file remains pending and is retried by the ten-second scan. If the same unresolved state remains unchanged for ten minutes, the session becomes `needs_review`.

### 10.4 Files that disappear

If a file disappears before upload:

- Mark it `missing`.
- Keep it associated with the session.
- Prevent the session from uploading automatically.
- Move the session to `needs_review`.
- Allow the operator to locate the file, exclude it, or cancel the session.

### 10.5 Filename collisions

Different ISO directories may contain identical basenames.

The application creates a unique Descript media key without renaming the local file:

```text
Program — Recording.mp4
Camera 1 — Recording.mp4
Camera 2 — Recording.mp4
```

Further collisions receive a numeric suffix:

```text
Camera 1 — Recording (2).mp4
```

The original basename and local path remain stored in the ledger.

## 11. Source and segment ordering

Each discovered file receives:

```ts
type SessionFileRole = 'primary' | 'iso'

interface SessionFile {
  sourceLabel: string
  role: SessionFileRole
  segmentIndex: number
}
```

Sequence tracks are sorted by:

1. Primary source first.
2. Manifest video-track index.
3. Timeline start frame.
4. Manifest clip index.
5. Existing segment index.
6. Descript media key.

Creation and modification timestamps may help discovery, but never determine synchronization. `Recording` contains `MultiCorder Sequence` exactly once.

## 12. Descript project behavior

### 12.1 Destination

The session’s start time determines its date folder:

```text
<destination root>/<formatted session date>
```

The resolved destination is persisted when the session is created.

Settings changes must not affect existing sessions.

### 12.2 Project naming

Default project name:

```text
YYYY-MM-DD_HH-mm-ss
```

The timestamp uses the configured recording timezone and the session’s persisted start time.

If another session already owns the same name and folder, use:

```text
YYYY-MM-DD_HH-mm-ss-02
YYYY-MM-DD_HH-mm-ss-03
```

The selected name is persisted before any Descript request.

### 12.3 Import request

A single import job contains all included session files.

Conceptual request:

```json
{
  "project_name": "2026-07-16_14-32-10",
  "folder_name": "Studio Uploads/26-07-16",
  "team_access": "edit",
  "add_media": {
    "Program — Program 001.mp4": {
      "content_type": "video/mp4",
      "file_size": 1200345123
    },
    "Camera 1 — Camera 1 001.mp4": {
      "content_type": "video/mp4",
      "file_size": 1199345123
    },
    "Camera 2 — Camera 2 001.mp4": {
      "content_type": "video/mp4",
      "file_size": 1211345123
    },
    "MultiCorder Sequence": {
      "tracks": [
        { "media": "Program — Program 001.mp4", "offset": 0 },
        { "media": "Camera 1 — Camera 1 001.mp4", "offset": 0 },
        { "media": "Camera 2 — Camera 2 001.mp4", "offset": 1.5015 }
      ]
    }
  },
  "add_compositions": [
    {
      "name": "Recording",
      "clips": [
        {
          "media": "MultiCorder Sequence"
        }
      ]
    }
  ]
}
```

The composition always contains one sequence clip. When a source has multiple physical segments, each segment is a separate sequence track with its own manifest-derived offset.

### 12.4 Upload order

Files upload sequentially by default:

1. Primary physical clips.
2. Remaining clips in manifest-track and timeline order.

Uploads use bounded concurrency of two files to avoid saturating the recording disk.

The implementation must stream files from disk and must not load entire files into memory.

### 12.5 ISO-only sessions

A session cannot become ready without at least one primary file.

For a MultiCorder-only production, the operator must designate one ISO location as primary in Settings.

If no primary file is discovered:

- Set the session to `needs_review`.
- Allow the operator to designate one included source as primary.
- Recalculate the composition before upload.

### 12.6 Empty ISO source

A configured ISO location producing no file does not block upload.

The session detail will show:

```text
Camera 3: No recording discovered
```

This is a warning, not an error, because a source may have been intentionally inactive.

## 13. Supported media

The uploader will accept only formats documented as compatible with Descript.

Initial eligible video containers:

- `.mp4`
- `.m4v`
- `.mov`
- `.mkv`
- `.webm`

Audio-only containers are not eligible for discovery or upload.

Known unsupported vMix outputs include AVI, MXF, and WMV. Descript also requires compatible codecs inside supported containers. See [Descript supported file types](https://help.descript.com/hc/en-us/articles/10164098416909-Supported-file-types).

Recommended vMix configuration:

```text
Container: MP4
Video: H.264
Audio: AAC
```

The application will:

- Reject known unsupported extensions before upload.
- Explain why the file was excluded.
- Warn that a supported extension does not guarantee codec compatibility.
- Surface Descript’s import error if codec validation fails remotely.
- Not transcode media.
- Warn when a file exceeds Descript’s documented per-file upload limit.

The current `.avi` acceptance behavior must be removed or converted into a visible unsupported-format error.

## 14. Database changes

Introduce session-level storage rather than extending the existing file-oriented recording row indefinitely.

### 14.1 Capture sessions

```sql
CREATE TABLE capture_sessions (
  id TEXT PRIMARY KEY,
  recorder_type TEXT NOT NULL,
  status TEXT NOT NULL,
  session_start TEXT NOT NULL,
  session_end TEXT,
  finalization_source TEXT,
  descript_folder_path TEXT NOT NULL,
  descript_project_name TEXT NOT NULL,
  descript_project_id TEXT,
  descript_job_id TEXT,
  timeline_timebase INTEGER,
  timeline_ntsc INTEGER,
  sync_mode TEXT NOT NULL DEFAULT 'unknown',
  manifest_path TEXT,
  manifest_hash TEXT,
  import_attempt_id TEXT,
  import_payload_hash TEXT,
  configuration_snapshot TEXT NOT NULL,
  error_message TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`finalization_source` values:

```text
obs_event
vmix_api
filesystem
manual
```

### 14.2 Session files

```sql
CREATE TABLE session_files (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_role TEXT NOT NULL,
  local_path TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  descript_media_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  modified_at TEXT NOT NULL,
  segment_index INTEGER NOT NULL,
  manifest_track_index INTEGER,
  manifest_clip_index INTEGER,
  manifest_clip_id TEXT,
  timeline_start_frame INTEGER,
  timeline_end_frame INTEGER,
  stability_status TEXT NOT NULL,
  upload_status TEXT NOT NULL,
  error_message TEXT,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES capture_sessions(id)
);
```

### 14.3 Upload states

Per-file upload status:

```ts
type SessionFileUploadStatus =
  | 'pending'
  | 'uploading'
  | 'transferred'
  | 'uploaded'
  | 'failed'
  | 'excluded'
  | 'missing'
```

### 14.4 Existing recording migration

Each existing `recordings` row becomes:

- One capture session.
- One primary session file.
- The same Descript folder, project name, project ID, job ID, and status.
- A configuration snapshot identifying the legacy source as OBS.
- The same hidden state and timestamps.

Migration must be transactional and idempotent.

The existing table may remain temporarily for rollback compatibility, but new application behavior will read from the session tables after successful migration.

## 15. Upload failure and retry behavior

### 15.1 Persist before transfer

Immediately after Descript creates an import job, persist:

- Project ID.
- Job ID.
- Project URL.
- Import attempt ID and a SHA-256 of the exact import payload.
- Every returned media upload target’s association with its local file.
- Current per-file state.

Signed upload URLs should not be logged. Persisting the URLs themselves is optional and should only occur if required for same-process recovery.

### 15.2 Partial transfer failure

If one file fails:

- Stop starting additional transfers.
- Mark the failed file.
- Preserve files whose bytes reached the signed URL as `transferred`.
- Mark the session `failed`.
- Do not mark the project completed.
- Show the exact failed source and filename.

### 15.3 Retry

Retry must first inspect the stored Descript job.

If the job is still active, resume polling it before taking any replacement action. If it stopped successfully, reconcile every expected media key and `Recording` before completing the session.

If any signed-URL transfer was interrupted and the old job cannot complete successfully, create a newly named project and submit the full request again. Do not patch an incomplete project with another sequence/composition request.

### 15.4 Reconciliation

For session-based entries, reconciliation uses:

1. Stored job ID.
2. Stored project ID.
3. Persisted destination and project name only as secondary evidence.

A matching project name alone must not mark a multi-file session complete.

A session becomes `completed` only when the associated Descript import job reports success.

## 16. Application restart recovery

On startup:

1. Load sessions in `recording`, `connection_lost`, `finalizing`, `ready`, `uploading`, or `processing`.
2. Re-establish recorder connectivity.
3. Restart all required directory watchers.
4. Rescan the persisted configuration snapshot’s locations.
5. Revalidate every unfinished file.
6. Poll stored Descript jobs.
7. Resume only operations known to be safe.

Specific behavior:

- `recording`: confirm recorder state before closing.
- `connection_lost`: attempt reconnection and continue scans.
- `finalizing`: restart finalization timers.
- `ready`: return to upload queue.
- `uploading`: inspect the remote job and per-file states before resuming.
- `processing`: poll the stored job.
- Missing mounted drives move the session to `needs_review`; they do not discard it.

## 17. Dashboard requirements

The dashboard becomes session-oriented.

### 17.1 Session row

Each row displays:

- Session start time.
- Recorder: OBS or vMix.
- Status.
- Primary source label.
- Number of ISO sources.
- Number of files.
- Total size.
- Descript destination.
- Current upload progress.
- Warning or failure summary.

Example:

```text
July 16, 2026 at 2:32 PM
vMix · Program + 4 ISO sources · 7 files · 38.4 GB
Finalizing files
```

### 17.2 Expandable session details

Expanding a session shows:

| Source | Role | Files | Size | State |
|---|---|---:|---:|---|
| Program | Primary | 2 | 9.8 GB | Ready |
| Camera 1 | ISO | 2 | 8.9 GB | Ready |
| Camera 2 | ISO | 1 | 7.1 GB | Ready |
| Presentation | ISO | 1 | 3.2 GB | Ready |
| Guest Call | ISO | 1 | 9.4 GB | Stabilizing |

Individual files display:

- Original filename.
- Logical Descript media name.
- Segment number.
- Local path.
- Size.
- Stability state.
- Upload state.
- Error message.

### 17.3 Live recording state

While vMix is recording, the dashboard shows:

```text
Recording in progress
Main recorder: Active
MultiCorder: Active
Files discovered: 5
Current size: 24.1 GB
```

No upload button is available while recorder state is active.

### 17.4 Session actions

Depending on state:

- Cancel upload.
- Retry upload.
- Hide session.
- Restore hidden session.
- Finalize session.
- Select primary source.
- Exclude an unsupported or unwanted file.
- Re-include an excluded file.
- Open containing folder.
- Recheck files.

Files cannot be excluded after upload begins.

## 18. Settings and status copy

Replace OBS-specific product copy with recorder-neutral language.

Examples:

| Current | Replacement |
|---|---|
| OBS → Descript | Recordings → Descript |
| OBS output folder | Primary recording folder |
| Connect to OBS to detect | Choose a recording source |
| OBS reports recording stopped | Your recorder has finished and files are stable |
| OBS connection | Recorder connection |

Product naming should be decided before release. If `OBS Upload` remains the public name, the UI must still clearly state that vMix is supported. A recorder-neutral product name is preferable.

## 19. Activity log

Session-aware activity examples:

```text
14:32:10  vMix recording started.
14:32:11  Opened capture session 2026-07-16_14-32-10.
14:32:14  Discovered Program — Part 1.mp4.
14:32:15  Discovered Camera 1 — Part 1.mp4.
14:32:15  Discovered Camera 2 — Part 1.mp4.
15:02:14  Discovered Program — Part 2.mp4.
15:32:48  vMix recording and MultiCorder stopped.
15:32:48  Finalizing 7 files.
15:33:07  Session ready: 7 files, 38.4 GB.
15:33:08  Created Descript import job.
15:33:09  Uploading Program — Part 1.mp4.
16:14:22  All files transferred; Descript is processing.
16:21:40  Descript project completed.
```

The log must not include:

- Descript tokens.
- OBS passwords.
- Signed upload URLs.
- vMix credentials, if credentials are later supported.

## 20. Historical reconciliation

### Initial behavior

Reconciliation will:

- Recover files belonging to an existing persisted session.
- Recover sessions interrupted by an application restart.
- Detect untracked eligible files.
- Avoid automatically guessing that arbitrary historical files belong together.

Untracked historical files are presented as `Unassigned recordings`.

For the first release, the operator may:

- Import each unassigned file as its own recovered session.
- Select several files and create one recovered session.
- Choose which source is primary.
- Assign source labels.
- Review the resulting project name and destination.

Automatic historical grouping based solely on timestamps or filenames is deferred because incorrect grouping could place unrelated productions in one Descript project.

## 21. Security and privacy

- Descript tokens remain in the operating-system credential store.
- OBS passwords remain in the credential store.
- vMix credentials, if later required, must also use the credential store.
- Settings JSON may contain hosts, ports, labels, and filesystem paths.
- Signed Descript upload URLs must never be written to ordinary logs.
- Files are read only after explicit directory configuration.
- The uploader does not modify or delete local recordings.
- Canceling an upload does not delete source media.
- Opening a containing folder requires an explicit user action.

## 22. Performance requirements

- Support at least 16 simultaneously recorded sources.
- Support at least 100 files in one session.
- Support files up to the current Descript plan/API limit.
- Stream uploads without buffering an entire file in memory.
- Maintain idle memory usage within 150 MB above the current application baseline.
- Directory scanning must not continuously stat every historical file after it has been ledgered.
- vMix API polling should default to approximately two seconds while monitoring.
- Filesystem fallback scans should run every 10–30 seconds.
- Uploads are sequential initially.
- UI updates should be throttled so frequent file-size changes do not cause excessive renderer traffic.

## 23. Reliability requirements

- A local path may belong to no more than one session.
- A Descript project name is fixed before the import request.
- Destination settings are fixed per session.
- Segment order is fixed before upload.
- Restarting the application must not create a second session for the same files.
- Repeated filesystem events must be idempotent.
- Repeated recorder-state events must be idempotent.
- A remote project name match alone must not complete a session.
- No file may upload before it passes stability checks.
- No vMix session may upload while either `recording` or `multiCorder` is active.
- Database migrations must be transactional.
- Unavailable recording volumes must produce visible recoverable errors.

## 24. Success metrics

The release is successful when:

- At least 99% of monitored vMix sessions produce exactly one local capture-session record.
- No actively growing file is uploaded during testing or production.
- A program-plus-ISO production produces exactly one Descript project.
- All eligible source files appear in that project.
- Split primary segments appear in chronological order in `Recording`.
- Restarting during recording does not duplicate the session.
- Restarting during upload does not silently mark a partial project complete.
- Existing OBS users can upgrade without reconfiguring their Descript destination.
- OBS single-file behavior remains functionally equivalent to the existing application.

## 25. Acceptance criteria

### Recorder configuration

1. The user can select OBS or vMix.
2. vMix defaults to host `127.0.0.1` and port `8088`.
3. The user can test vMix API connectivity.
4. The UI shows main recorder and MultiCorder state.
5. The user can configure one primary location and multiple ISO locations.
6. Every location can have a unique label and optional filename filter.
7. Invalid, unreadable, or duplicate locations cannot be saved without explanation.
8. Configuration changes affect future sessions only.

### Session grouping

9. Starting the vMix recorder opens a session.
10. Starting MultiCorder opens a session if one is not already open.
11. Starting MultiCorder during a program recording joins the existing session.
12. A session remains active until both vMix recording states are inactive.
13. Files from every configured location join the active session.
14. Split files remain in the same session.
15. Repeated filesystem events do not create duplicate file records.
16. Identical basenames from different directories receive unique media keys.
17. A session cannot belong to more than one Descript project.

### File safety

18. Zero-byte files are never queued for upload.
19. Growing files are never queued for upload.
20. Files must pass three stability probes.
21. vMix files must expose valid media metadata, match the XMEML file declaration, cover its source duration, and pass a final-tail decode before upload.
22. A late-created file resets finalization.
23. A missing file moves the session to `needs_review`.
24. An API connection loss does not automatically finalize an active session.
25. The operator can manually finalize a stable session after a connection loss.

### Descript behavior

26. One session creates one Descript project.
27. All eligible session files are declared in one import request.
28. `Recording` contains `MultiCorder Sequence` exactly once.
29. Program tracks appear first, followed by deterministic manifest order.
30. Every physical clip is a sequence track at its normalized XMEML frame offset.
31. An ISO-only session requires a designated primary source.
32. Unsupported formats are blocked before the import request.
33. The project destination is based on the session’s persisted start time.
34. Changing destination settings does not move an existing session.
35. Completion requires successful Descript job status.
36. Project-name matching alone cannot complete a multi-file session.

### Recovery

37. Restarting during recording restores the open session.
38. Restarting during finalization resumes stability checks.
39. Restarting before upload returns a ready session to the queue.
40. Restarting during processing resumes job polling.
41. Missing network volumes produce a recoverable visible state.
42. Existing single-file recording rows migrate without losing project or status data.
43. Migration can run more than once without duplicating sessions.

### Dashboard

44. The dashboard lists sessions rather than individual top-level files.
45. Each session shows recorder, sources, file count, total size, and destination.
46. Expanding a session shows every source and file.
47. Upload and stability errors identify the affected source and filename.
48. The operator can hide, restore, retry, cancel, and inspect sessions.
49. The UI clearly distinguishes API-confirmed and filesystem-inferred sessions.

### OBS regression

50. OBS connection and password storage continue to work.
51. OBS recording-stop events continue to trigger prompt discovery.
52. OBS’s detected recording directory remains the default primary location.
53. Existing OBS destination and reconciliation behavior remains intact.
54. An upgraded OBS installation does not require a database reset.

## 26. Delivery phases

### Phase 1: Session data model

- Add capture-session and session-file tables.
- Migrate existing recordings.
- Refactor Descript imports to accept multiple files.
- Convert dashboard data from recordings to sessions.
- Preserve OBS behavior through the new model.

### Phase 2: Generalized directory monitoring

- Add multiple recording locations.
- Add source labels and roles.
- Implement collision-safe media keys.
- Strengthen stability detection.
- Implement session finalization.

### Phase 3: vMix integration

- Add recorder selection.
- Add vMix API connection and polling.
- Track `recording` and `multiCorder`.
- Connect vMix state transitions to session lifecycle.
- Add filesystem-only fallback behavior.

### Phase 4: Recovery and operator controls

- Recover open sessions after restart.
- Add `needs_review`.
- Add manual finalization and primary-source selection.
- Add session detail and per-file statuses.
- Add partial-upload retry protections.

### Phase 5: Validation and release

- Test program-only vMix recording.
- Test MultiCorder with multiple ISO sources.
- Test split files.
- Test separate drives and UNC paths.
- Test API disconnection.
- Test restart during every session state.
- Test partial Descript upload failures.
- Run a live three-file direct-upload integration against Descript to verify sequence offsets and endpoint-schema compatibility.
- Run full OBS regression.
- Update branding, README, setup instructions, and release notes.

## 27. Recommended release boundary

The first production release should include:

- OBS and vMix recorder selection.
- vMix program recording and MultiCorder state.
- One primary plus multiple ISO locations.
- One session → one Descript project.
- A Program-first synchronized multitrack sequence.
- Stacked physical tracks for split Program and ISO clips.
- Restart recovery.
- Manual review for ambiguous sessions.
- Supported-format validation.
- Session-level dashboard and retry behavior.

Automatic audio/timecode alignment, split-file consolidation, automatic transcoding, Instant Replay, and automatic historical session reconstruction remain explicitly deferred.
