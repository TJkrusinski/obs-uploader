# OBS Upload

OBS Upload is a macOS and Windows Electron app that sends completed OBS recordings to Descript.

It creates projects in this structure:

```text
[optional Descript root/]<YY-MM-DD>/<YYYY-MM-DD_HH-mm-ss>
```

Each project contains a `Recording` composition and the original OBS media file.
Projects created inside a Descript folder are shared with Drive members as editors, as required by Descript's folder-import API.

## What you need

1. **OBS Studio 28 or newer** with its built-in WebSocket server enabled.
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
