# ADR-001: OBS → Descript Desktop Uploader (Revision 4)

## Status

Proposed

## Context

The application watches an OBS recording folder, uploads completed recordings to Descript, and periodically reconciles local recordings against Descript projects.

Recordings should be grouped in Descript by day, but the top-level destination should not be hardcoded. Different users or production environments may want roots such as:

```text
OBS Recordings
Studio Uploads
Podcast
Client Work/Acme
```

The application therefore needs a simple, visible way to configure where new Descript projects are created.

## Decision

The Electron application will expose a configurable **Descript destination root folder** in its UI.

The effective folder for an uploaded recording will be:

```text
<destination root>/<YY-MM-DD>
```

For example:

```text
Configured root: Studio Uploads

Studio Uploads/
├── 2026-07-10/
├── 2026-07-11/
└── 2026-07-12/
```

Each OBS recording becomes one Descript project inside the folder corresponding to the recording's local calendar day.

## Naming Convention

| Item | Convention |
|---|---|
| Destination root | User-configurable, default `OBS Recordings` |
| Daily folder | `<destination root>/YY-MM-DD` |
| Project | `YYYY-MM-DD_HH-mm-ss` |
| Composition | `Recording` |
| Media | Original OBS filename |

The recording timestamp is interpreted using the timezone configured by the application. The initial default is the operating system's local timezone.

## Settings UI

The Electron app will include a **Settings** screen with a "Descript destination" section.

### Fields

- **Root folder**
  - Editable text field
  - Default: `OBS Recordings`
  - Example helper text: `Studio Uploads` or `Client Work/Acme`
- **Folder preview**
  - Read-only preview of the effective folder for today
  - Example: `Studio Uploads/2026-07-10`
- **Timezone**
  - Defaults to the operating system timezone
  - Used to determine which date folder receives a recording
- **Test destination**
  - Verifies the Descript token and confirms that the configured path can be used by an import request
  - Must not create a permanent empty project merely to test configuration
- **Save**
  - Persists settings locally
- **Cancel**
  - Discards unsaved changes

The main dashboard will also show the active destination folder so the operator can verify it without opening Settings.

Example:

```text
Destination
Studio Uploads/2026-07-10
```

## Validation

Before saving, the UI will:

1. Trim leading and trailing whitespace.
2. Normalize repeated separators.
3. Remove leading and trailing `/` separators.
4. Reject an empty value.
5. Reject control characters.
6. Warn when the path appears unintentionally deep.
7. Show the normalized folder preview.

Examples:

```text
"  Studio Uploads//Podcast/  "
```

becomes:

```text
Studio Uploads/Podcast
```

Folder segments may contain spaces. The application should avoid imposing unnecessary filename restrictions beyond those required by the Descript API.

## Persistence

Application settings will be stored in the Electron application-data directory.

The stored configuration includes:

```ts
interface AppSettings {
  descriptDestinationRoot: string;
  recordingTimezone: string;
}
```

The Descript API token remains in the operating system credential store rather than in the general settings file or SQLite database.

Settings changes apply to recordings discovered after the change. Existing ledger entries retain the resolved destination folder assigned when they were first discovered.

This prevents a settings change from moving, duplicating, or reclassifying recordings that are already queued or uploaded.

## Upload Behavior

When a completed recording is discovered, the main process resolves and stores:

```ts
const dailyFolder =
  `${settings.descriptDestinationRoot}/${recordingDate}`;
```

Example Descript import request:

```json
{
  "project_name": "2026-07-10_15-08-41",
  "folder_name": "Studio Uploads/2026-07-10",
  "add_media": {
    "2026-07-10 15-08-41.mkv": {
      "content_type": "video/x-matroska",
      "file_size": 523184293
    }
  },
  "add_compositions": [
    {
      "name": "Recording",
      "clips": [
        {
          "media": "2026-07-10 15-08-41.mkv"
        }
      ]
    }
  ]
}
```

The resolved `folder_name` is persisted on the recording ledger row before the import request begins.

## SQLite Changes

Each recording row will store the destination selected at discovery time:

```sql
ALTER TABLE recordings
ADD COLUMN descript_folder_path TEXT;
```

For new installations, this field is part of the initial schema and is required before a recording enters the upload queue.

Relevant fields include:

```sql
descript_folder_path TEXT NOT NULL,
descript_project_name TEXT NOT NULL,
descript_project_id TEXT,
descript_job_id TEXT
```

This preserves deterministic reconciliation even after the user changes the configured root folder.

## Reconciliation

Reconciliation will not assume the application's current destination setting for every historical recording.

For each ledger entry, it will use the persisted:

```text
descript_folder_path
descript_project_name
```

For newly discovered files:

1. Determine the recording's calendar day in the configured timezone.
2. Resolve `<destination root>/YY-MM-DD`.
3. Persist the resolved path.
4. List projects in that exact Descript folder.
5. Match by deterministic project name.
6. Upload the recording when no match exists.

The app may optimize a reconciliation pass by grouping ledger entries by `descript_folder_path` so each folder is listed only once.

## Changing the Destination

Changing the root destination affects **future discoveries only**.

The UI will explain:

> New recordings will upload to the new destination. Recordings already queued or uploaded will remain associated with their original destination.

The first version will not move existing Descript projects between folders. Moving remote projects would introduce additional API requirements, ambiguity, and failure modes outside the core upload workflow.

The app may offer a separate future migration feature, but it is not part of this ADR.

## First-Run Experience

The initial setup flow will include:

1. Select the local OBS recording folder.
2. Connect to OBS.
3. enter and validate the Descript API token.
4. Choose the Descript destination root.
5. Review today's effective destination.
6. Start monitoring.

The destination field is prefilled with:

```text
OBS Recordings
```

so a user can accept the default without needing to understand Descript folder semantics.

## Dashboard Behavior

The dashboard will display:

- Overall application status
- OBS connection
- Descript connection
- Local recording folder
- Current Descript destination
- Active recording
- Active upload and progress
- Today's waiting, uploading, processing, completed, and failed recordings
- Last reconciliation result
- Recent activity

Example activity:

```text
14:32  Recording completed
14:32  Queued for Studio Uploads/2026-07-10
14:33  Upload started
14:36  Upload complete; Descript is processing
14:39  Project ready in Descript
```

## Consequences

### Positive

- The app works across studios, clients, shows, and production contexts.
- Operators can confirm the active destination visually.
- Daily folder organization remains automatic.
- Historical reconciliation remains stable after settings changes.
- The default remains simple enough for a basic desktop application.

### Negative

- The ledger must store the resolved folder for every recording.
- Changing the setting does not reorganize existing projects.
- The UI needs validation and a clear explanation of when changes take effect.
- Multiple configured roots can create a more fragmented Descript workspace if changed frequently.

## Alternatives Considered

### Hardcode `OBS Recordings`

Rejected because the application would be unnecessarily tied to one workspace convention.

### Select a destination for every upload

Rejected because it adds operator friction and undermines automatic background ingestion.

### Apply destination changes retroactively

Rejected for the initial version because moving or recreating existing Descript projects introduces duplicate and partial-migration risks.

### Create separate app profiles

Deferred. Profiles may later bundle the local recording directory, OBS connection, Descript drive, and destination root. A single configurable root is sufficient for the basic application.

## Acceptance Criteria

1. The destination root can be edited in Settings.
2. The UI previews today's effective Descript folder.
3. The default root is `OBS Recordings`.
4. Invalid or empty roots cannot be saved.
5. The setting persists across application restarts.
6. New recordings use `<configured root>/YY-MM-DD`.
7. Each recording stores its resolved folder before upload begins.
8. Existing queued recordings keep their original destination after a settings change.
9. Reconciliation uses the folder persisted on each recording row.
10. The dashboard always shows the current destination.
11. The Descript token is not stored in the normal settings file.
12. The application does not automatically move existing Descript projects when the root changes.
