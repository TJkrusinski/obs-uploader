# OBS Upload

OBS Upload is a macOS and Windows Electron app that sends completed OBS recordings or vMix MultiCorder sessions to Descript.

It creates projects in this structure:

```text
[optional Descript root/]<YY-MM-DD>/<YYYY-MM-DD_HH-mm-ss>
```

Each OBS project contains a `Recording` composition and the original OBS media file. Each vMix project contains one Program-first multitrack sequence inserted into the `Recording` composition.
Projects created inside a Descript folder are shared with Drive members as editors, as required by Descript's folder-import API.

## What you need

1. **OBS Studio 28 or newer**, or **vMix MultiCorder** configured to write a legacy Final Cut Pro XML timeline. OBS uses its built-in WebSocket server; vMix can optionally use its HTTP API to prevent finalization while recording is active.
2. A **Descript API token**, scoped to the Descript Drive that should contain the new projects. In Descript, open **Settings → API tokens → Create token**, name it, select the Drive, and copy the token immediately. Descript shows the value only once.
3. Enough **Descript media minutes** for the material you upload. Imports are asynchronous and consume media minutes.

The app stores Descript and OBS secrets in the operating system credential store (Keychain on macOS, Credential Manager on Windows). Its ordinary settings JSON and SQLite ledger do not contain either secret.

## Development

```bash
npm install
npm run dev
```

Build an unpacked app:

```bash
npm run build:unpacked
```

The packaged app is written to `release/`.

## Notes

- Destination changes only affect recordings found afterward. Leave the optional root blank to create date folders directly at the Descript Drive root, and choose the date format in Settings. Each ledger entry saves its resolved folder at discovery time.
- The API creates missing nested Descript folders during the first matching import. Its folder APIs do not offer a non-mutating path-validation call, so **Test token** verifies authentication without creating a project.
- Reconciliation discovers only local files from the current calendar day (in the configured recording timezone), lists remote projects by saved folder path and deterministic project name, then checks asynchronous import job status.
- Descript's import API uses a signed direct-upload URL: the app requests it, streams the local recording to it, and polls the returned job.
- Turn off **Automatically upload discovered sessions** to keep monitoring and discovery active without starting new uploads. Queue sessions can also be marked **Don't upload session**, and individual files can be excluded before an upload begins.
- vMix XML and all referenced media must remain unchanged for 30 seconds, pass three size/mtime probes, match ffprobe metadata to the XMEML source declaration (duration, frame count/rate, dimensions, and audio channels when present), and successfully decode their final seconds before an import job is created.
- Empty or not-yet-created vMix outputs remain pending and are checked again by the 10-second scan. After ten unchanged minutes they become review items instead of waiting forever.
- A read-only `fs.open` plus final-byte read catches exclusive or unreadable files, but cannot prove that another Windows process has closed a shared file. Enabling vMix API status is the authoritative active-recorder guard.
- Every physical video `clipitem` in the finalized vMix XMEML timeline is uploaded intact as an independent track in one `MultiCorder Sequence`. Split clips keep their manifest-derived timeline offsets; they are not concatenated or transcoded.
- The Program track is placed first. Tracks named `Output 1` or `Program` are detected automatically; otherwise the queue asks the operator to choose the primary source.
- Descript supports at most 14 physical tracks in one sequence. Larger sessions remain in `needs_review` until clips are excluded or the session is canceled.
- ISO audio is preserved. When several files contain the same master mix, mute or exclude duplicate audio tracks from the combined script in Descript’s Sequence Editor.
- Media paths must remain inside the reconciliation folder or an additional recording root configured in Settings. Duplicate basename matches require operator review.
