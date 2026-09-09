# Loop UI manual demo

[中文操作步骤](README.zh.md)

Run from the `loop-ui` worktree:

```bash
./tmp/loop-ui-manual/run.sh
```

This starts MixCode with the local, offline `loop-ui-demo/alpha` model, displayed as `Loop UI Offline`. The demo uses a temporary runtime directory for settings and sessions, and removes it when you exit. Start with a terminal around 120 columns by 40 rows. Allow about 5 seconds for extensions to load on Home, then press Right on `Agent-01` to attach.

## Observe the real timer

1. Enter `/loop 10s --max-runs 3 checkpoint`. The bottom widget shows `Loops (1)` and `1/3`.
2. Wait 10 seconds. The first local model response takes 25 seconds, so the real deferred timer changes the widget to yellow `waiting` while the count remains `1/3`.
3. By about 31 seconds, `Local reply 3` appears. The loop reaches its total and its widget disappears.

## Create the layout fixtures

Paste this entire block into the editor, then press Enter once:

```text
/loop 2h --max-runs 3 DEPLOY-CHECK 检查发布与服务健康
检查项 01：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 02：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 03：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 04：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 05：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 06：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 07：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 08：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 09：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 10：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 11：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 12：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 13：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 14：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 15：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 16：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 17：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 18：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 19：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 20：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 21：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 22：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 23：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
检查项 24：确认服务健康、错误率、数据库连接与任务队列，记录当前版本和回滚步骤。
END-CHECKLIST
```

After `Local reply 4`, enter `/loop 10m Run tests`. The widget uses the original table layout with `ON`, `ID`, `M`, `NAME`, `INTERVAL`, `PROMPT`, `NEXT`, and `RUNS` columns. The finite task shows `1/3`; the unlimited task shows `1`. The manager uses the roomier two-line task layout.

## Inspect layout and controls

1. Enter `/loop`. Each task uses two rows. Press Down to select `#3`, then Up and Enter to inspect `#2`.
2. Press `G` to reach `END-CHECKLIST`, then `g` to return to `DEPLOY-CHECK`. Resize the terminal to 60, then 40 columns with 28 rows; wait for the redraw and press `G` after each resize. The last prompt line and `q close` remain visible. Restore the wider terminal.
3. Press `g`, then `c`. Enter `0` and press Enter: `Error: Max runs` appears without changing the limit. Press Escape, then `c`, enter `5`, and press Enter. Details show `Runs: 1/5`. Press `m` to see `When busy: skip`, then `m` again to restore `defer`.
4. Press `x`: removal confirmation appears in the footer while the prompt stays visible. Press `q`: confirmation cancels and details stay open. Press Left to return to the list; after `Search: _` appears, type `deploy` to filter to `#2`, then press Ctrl+U to restore both tasks.
5. Press `c` in the list: `Remove all 2 loops?` appears beside the still-visible task list. Press `q` to cancel. Press `c`, then `y` to clear. The manager shows `No matching loops`.

Press `q` to close the manager, then enter `/quit`. The demo exits and removes its temporary runtime directory. Starting the launcher again creates a fresh demo with IDs starting at `1`.
