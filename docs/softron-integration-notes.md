# Softron MovieRecorder integration notes

Reference inspected on 2026-08-05: [MovieRecorder REST API](http://192.168.1.206:8080/api.html)

Live instance observed:

- Product: MovieRecorder Express 4.6.8 (build 406173)
- REST base URL: `http://192.168.1.206:8080`
- Four enabled Blackmagic sources
- One file destination named `h264_records`
- Destination path reported by the API: `/Users/mts-macbook-pro/Movies/mts-records`

## Relevant API surface

- `GET /info` verifies connectivity and identifies the MovieRecorder instance.
- `GET /sources` returns stable source `unique_id` values plus `is_recording`,
  `is_paused`, `recording_name`, `recording_start_date`, `recording_end_date`,
  and each source's enabled destinations. On the live 4.6.8 instance, each
  enabled destination also includes `destination_recording_path`, which gives
  the exact current/completed filename.
- `GET /sources/{unique_id}` returns the same per-source recording state.
- `GET /sources/{unique_id}/info` provides a lightweight current-state check,
  including `is_recording` and `is_paused`, but not session dates or filenames.
- `GET /destinations` maps destination IDs to names and, for file destinations,
  output directories.
- `ws://{host}:{port}/remote` with WebSocket subprotocol
  `v1.1.main_update.movierecorder.softronmedia.com` pushes source and destination
  insertion, removal, and replacement messages. Source replacement messages are
  the immediate recording-state signal.

Password protection, when enabled, is documented as a `password` query
parameter. It should be stored in the operating-system credential store and
added to REST and WebSocket connection URLs.

## Recommended session-boundary algorithm

1. On connection, fetch `/sources` and `/destinations` and index both by their
   stable `unique_id` values.
2. Open the `/remote` WebSocket. Treat it as the low-latency notification path,
   while retaining REST polling as reconnect and missed-event recovery.
3. When an enabled source changes from `is_recording: false` to `true`, open a
   local capture session. Save the source ID, display name, recording name,
   API start date, enabled file-destination IDs, and a directory snapshot for
   every mapped destination.
4. Coalesce sources that begin together into one session. A small debounce is
   needed because gang recording can produce one source event at a time.
5. Track every participating source until all of them report
   `is_recording: false`. Do not close the session when only one camera stops.
6. Confirm the stopped state with `GET /sources`, save the reported end dates,
   and begin file finalization checks.
7. Resolve the basename of each source's `destination_recording_path` inside the
   configured local/mounted folder. Also compare the destination directory to
   its start snapshot to capture manual splits. Candidate session files are the
   union of those paths and files new or changed during the session. Wait for size and
   modification time to remain unchanged across repeated probes before creating
   the Descript import.
8. Upload all finalized candidates together. Use a configured Softron source ID
   as the Program/primary source; treat the other source files as ISO tracks.

The WebSocket should reconnect with backoff. After every reconnect, a fresh
`GET /sources` comparison must synthesize any start or stop transition that was
missed while disconnected.

## Important API limitation

The HTML reference does not document the completed filename, but the inspected
MovieRecorder 4.6.8 response includes `destination_recording_path` inside each
source's `enabled_destinations`. It also exposes `manual_split`, which can create
several files during one recording; a directory delta remains necessary to catch
every split segment.

Therefore the integration needs a filesystem mapping for every file destination:

- If this app runs on the MovieRecorder Mac, the API path can be used directly.
- If it runs on another computer, the destination must be shared/mounted and the
  settings must map the destination ID to the corresponding local mount path.

Directory deltas are only unambiguous when unrelated writers are not adding
files to the same destination during the session. Before implementation is
considered complete, record one short multi-source test and inspect the actual
filename convention. If filenames consistently include `recording_name` and/or
the source name, use that as an additional membership check. Otherwise each
recording workflow should use a dedicated destination directory.

## Implementation slice

1. Add `softron` settings: host, port, optional password, primary source ID, and
   destination-ID-to-local-path mappings.
2. Add a Softron client with REST bootstrap, WebSocket transitions, reconnect,
   and periodic REST reconciliation.
3. Add a session coordinator that coalesces source starts and waits for all
   participating sources to stop.
4. Add destination snapshot/delta discovery and stable-file validation.
5. Extend the Descript import builder to create one synchronized multitrack
   composition from the discovered Softron files.
6. Add fixture-driven tests for partial stops, missed WebSocket events,
   reconnects, manual splits, and unrelated destination files.
