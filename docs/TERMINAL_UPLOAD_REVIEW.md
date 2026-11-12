# Terminal upload repair and review

## Root cause

The hidden file chooser used BoardUI `Input`, which composes a React Aria
`TextField`. That component controls a string value and exposes a text-change
callback, whereas file selection needs the input's native `FileList`. A real
Chromium chooser reproduced the failure: after selecting a file, no upload
frame, progress dialog, or destination file appeared.

The chooser now uses the installed BoardUI `InputBase` with React Aria's input
and a native change handler, outside `TextField`. It copies the selected File
before clearing the input, so selecting the same filename again also works.
The ZMODEM chooser uses the same appropriate input component.

The old transport also counted queued WebSocket sends as successful uploads.
GoTTY only logged filesystem errors, so the browser could not confirm that a
file was saved. The repaired flow distinguishes confirmed and legacy transfers.

## Behavior

- Selection or drag-and-drop opens a persistent progress dialog, showing the
  filename, percentage and transferred bytes. Files up to 64 MiB, including
  empty files, are supported.
- Success includes the uploaded filename. Errors stay visible with a retry
  button retaining the selected File; unavailable connections disable retry.
- Cancel prevents further data frames and releases the remote transfer even
  during a pending browser file read; disconnects and missing receipts
  reject the upload rather than silently claiming success. Receipt timeouts are
  30 seconds per chunk.
- Observer upload controls remain hidden. Operators can upload without owner
  management privileges. Both Hub and GoTTY still enforce write permissions.
  A write-permission change during upload aborts it and dismisses stale progress.

## Compatible GoTTY extension

The matching GoTTY source changes are in `server/client_upload.go`,
`client_handler.go`, `session_manager.go`, and `hub_terminal.go` in the GoTTY
repository. No Rust Hub gateway or shared terminal-core package change is needed:
the gateway already forwards terminal data in both directions.

GoTTY advertises `hub-config.upload_ack: true` in terminal preferences. Hub
clears this capability on each connection and uses it only for that connection.

The existing browser-to-GoTTY `7` JSON frame gains an optional `uploadId`:

```json
{"uploadId":"request-id","name":"example.txt","size":3,"chunk":0,"totalChunks":1,"data":"YWJj"}
```

Opted-in requests receive a server-to-browser `d` JSON frame only on the
originating stream. HubConnection consumes it before terminal-core, without
putting it into terminal output, replay history or other clients' streams:

```json
{"uploadId":"request-id","name":"example.txt","chunk":0,"received":3,"done":true}
```

Failures use `error`; cancellation sends `7` plus
`{"uploadId":"request-id","cancel":true}`. Each acknowledged chunk gates the
next send, avoiding an unbounded burst into the Hub/device queues. Progress
advances on matching receipts, with 100% reserved for final completion.

GoTTY tracks opted-in transfers per client, validates order and exact byte count,
and writes a temporary file in the terminal working directory captured at the
first chunk. After the final chunk it syncs, closes and renames the file into
place, then reports success. Cancellation, errors, client removal, PTY restart
and server shutdown clean up incomplete temporary files. Existing destination
permissions are preserved; symlinks and nonregular destinations are rejected.
Concurrent acknowledged uploads to the same destination are rejected; different
destinations are independent.

Older GoTTY versions retain the original upload format. Hub drains its browser
send buffer and displays “已发送：文件名。当前 GoTTY 不支持写入确认，请在终端中确认文件。”
It cannot report filesystem errors or clean up legacy partial files remotely.
Existing standalone GoTTY clients continue using the legacy format unchanged.
Accurate saved-file confirmation and atomic cancellation require updating both
Hub and GoTTY. Cancelling after the final file commit does not roll back that
completed write. Transfers are not resumable after a page reload.

## Validation

All builds, tests and disposable Hub/GoTTY processes run on `root@xianyu` under
`/root/gotty-dataflow-review.EcmNjn`. No local application was built, started,
deployed or restarted, and neither production service was replaced.

- All 80 frontend tests (18 files), TypeScript checking and Vite build pass.
  Unit tests include receipt correlation, UTF-8 frame sizing,
  timeouts, aborts, disconnects, disk errors, invalid receipts, old protocol,
  empty files, size/name validation and write permission checks.
- GoTTY tests cover byte-exact completion, preserved destination permissions,
  interrupted upload cleanup, sequence/size/base64 failures, failed rename,
  isolated clients, legacy input and read-only denial; full Go tests and race
  detection pass.
- `WORKSPACE_SUITE=upload` runs actual chooser uploads into real GoTTY shells,
  compares filesystem bytes, pauses disk receipts to inspect intermediate
  progress, verifies named completion, same-name repeat, cancelled chooser,
  empty files, drag-and-drop, server error/retry, cancellation/disconnection,
  mobile dialog bounds and operator/observer behavior. Set `UPLOAD_LEGACY=1`
  with an older GoTTY binary for compatibility coverage.
- Existing terminal dataflow and workspace browser suites verify shared
  history/size behavior and workspace controls remain usable.

Remote artifacts: `hub-workspace-tDENjq` (final acknowledged uploads),
`hub-workspace-Pvs2Ve` (older GoTTY), `hub-workspace-5uuj0Y` (terminal dataflow),
and `hub-workspace-kpDC9e` (complete workspace suite). All browser runs reported
zero page errors. Logs are retained alongside these directories in the isolated
review root.

Review focused on acknowledgment scope and ordering, stale connections, cleanup
of pending callbacks and temporary files, owner/operator separation, truthful
legacy messaging, mobile layout, and preserving preexisting workspace changes.
