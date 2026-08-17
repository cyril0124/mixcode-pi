# Instance Registry & Status

[中文文档](instance-registry.zh.md)

MixCode tracks active terminal processes and their tabs in an instance registry located under the state directory:

```text
~/.pi/agent/mixcode-pi/instances/<pid>.json
```

## CLI Status Command

To inspect all running MixCode instances and active tabs:

```bash
mpi status
mpi status --json
mpi status --workdir /path/to/project
```

- In the table output, `A` indicates the active/focused tab marked with `*`.
- `TAB_TITLE` shows the user-facing title of each tab.
- `--workdir <path>` filters to instances whose root workdir equals the resolved path (`~` / relative / absolute).

## Snapshot Schema

Each running instance periodically writes a heartbeat snapshot:

| Field | Type | Description |
|---|---|---|
| `version` | number (`1`) | Instance snapshot schema version. |
| `pid` | number | Host OS process identifier. |
| `workdir` | string | Main workspace working directory of the process. |
| `activeTabId` | string | Currently focused tab identifier. |
| `updatedAt` | string (ISO) | Heartbeat timestamp (updated every 5,000 ms). |
| `tabs` | array | List of tab snapshots (index, sessionId, title, status, workdir, dialogs). |

## Tab Status Lifecycle

Individual tabs in a snapshot are derived into one of five operational states:

```text
               ┌──> working (running / thinking)
               │
               ├──> waiting-for-input (pending questions / dialogs)
Tab Snapshot ──┼──> error (failed turn)
               │
               ├──> finished (completed turn with unread result)
               │
               └──> idle (ready for next prompt)
```

## Dead Process Cleanup

Stale snapshots left behind by abruptly terminated processes or dead PIDs are automatically identified and cleaned up:
- A snapshot is considered stale when `updatedAt` exceeds `15,000 ms`.
- Process existence is verified via `kill(pid, 0)`.
- `mpi status` and instance startup purge dead entries automatically.
