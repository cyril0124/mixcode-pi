# Instance Registry & Status

[中文文档](instance-registry.zh.md)

MixCode tracks active terminal processes and their tabs in an instance registry located under the state directory:

```text
~/.pi/agent/mixcode-pi/instances/<hostname>/<pid>.json    # heartbeat snapshot
~/.pi/agent/mixcode-pi/instances/<hostname>/<pid>.sock    # mpi ctl socket
```

The registry is scoped per host (`os.hostname()`): the state dir can live on an NFS home shared by several machines, while pid-keyed file names, `kill(pid, 0)` liveness checks, and Unix sockets are only meaningful on the host that created them. Each host reads and cleans only its own subdirectory.

## CLI Status Command

To inspect all running MixCode instances and active tabs:

```bash
mpi status
mpi status --json
mpi status --workdir /path/to/project
```

- In the table output, `A` indicates the active/focused tab marked with `*`.
- `TAB_TITLE` shows the user-facing title of each tab.
- `started` shows the instance (process) start time as local `YYYY-MM-DD HH:MM`.
- `focus: home` appears in the header when the Home surface holds focus; a focused tab is marked with `*` instead, so a tab titled `home` never triggers the header marker.
- In `--json`, `focus` is `"home"` / `"tab"` (omitted when unknown) and `activeTabTitle` appears only when `focus` is `"tab"`.
- `--workdir <path>` filters to instances whose root workdir equals the resolved path (`~` / relative / absolute).

## Snapshot Schema

Each running instance periodically writes a heartbeat snapshot:

| Field | Type | Description |
|---|---|---|
| `version` | number (`1`) | Instance snapshot schema version. |
| `pid` | number | Host OS process identifier. |
| `workdir` | string | Main workspace working directory of the process. |
| `activeTabId` | string | Currently focused tab identifier. |
| `createdAt` | string (ISO) | Instance (process) start time; fixed for the process lifetime. |
| `updatedAt` | string (ISO) | Heartbeat timestamp (updated every 5,000 ms). |
| `tabs` | array | List of tab snapshots (index, sessionId, title, status, workdir, waitingForInputCount). |

## Tab Status Lifecycle

Individual tabs in a snapshot are derived into one of five operational states:

```text
               ┌──> working (running / thinking)
               │
               ├──> waiting-for-input (extension UI)
Tab Snapshot ──┼──> error (failed turn)
               │
               ├──> finished (completed turn with unread result)
               │
               └──> idle (ready for next prompt)
```

## Dead Process Cleanup

Stale files left behind by abruptly terminated processes or dead PIDs are automatically identified and cleaned up:
- A snapshot is considered stale when `updatedAt` exceeds `15,000 ms`.
- Process existence is verified via `kill(pid, 0)` (authoritative because the registry dir is host-scoped).
- `mpi status` and instance startup purge dead entries automatically.
- Cleanup also removes `<pid>.sock` and `<pid>.json.<pid>.<uuid>.tmp` files whose owning pid is dead (SIGKILLed instances never run their exit cleanup).

## Ctl Socket Self-Healing

The ctl socket is bound at startup and re-checked on every heartbeat: if the socket file is missing (transient NFS bind failure, external deletion), the instance disposes the old server and rebinds within one heartbeat interval. The `mpi ctl server unavailable` notice is shown once per outage.
