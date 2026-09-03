# mpi-stuck-guard

`mpi-stuck-guard` 保护 Provider 流活性：监控 Provider 的首个事件和事件间空闲时间，中止卡住的请求，并返回可交给宿主 retry 机制的错误。

## Provider 流 watchdog

watchdog 包装公共 `Provider.stream` 和 `Provider.streamSimple` API。正常事件原样转发。每个请求独立维护首事件、空闲、abort 和完成状态。

### Provider 流状态

| 状态 | 含义 | 是否终态 |
|---|---|---|
| `idle` | 请求已开始，尚未收到 Provider 事件 | 否 |
| `streaming` | 已收到至少一个事件，空闲计时器已启动 | 否 |
| `timed_out` | 首事件或 idle watchdog 触发，原请求已中止 | 本次请求是 |
| `user_aborted` | 父 signal 取消请求 | 是 |
| `completed` | Provider 发出 `done` | 是 |
| `provider_error` | Provider 发出非 watchdog 错误或抛错 | 是 |
| `cooldown_short_window` | 此 Provider/model 最近超时；下一次请求使用 retry 首事件窗口 | 否 |

### Provider 流状态转移

```text
idle
  ├─ 收到首个事件 ─────────────────> streaming
  ├─ streamStartTimeoutSeconds 到期 ─> timed_out
  └─ 父 AbortSignal 触发 ──────────> user_aborted

streaming
  ├─ 收到新事件 ───────────────────> streaming
  ├─ Provider 发出 done ───────────> completed
  ├─ Provider 发出 error/抛错 ─────> provider_error
  ├─ streamIdleTimeoutSeconds 到期 ─> timed_out
  └─ 父 AbortSignal 触发 ──────────> user_aborted

timed_out
  ├─ 中止原 Provider 请求
  ├─ 记录 provider/model cooldown
  └─ 发出 error(stopReason="error")
          │
          ▼
      宿主 retry
       ├─ 请求成功 ─────────────────> streaming / completed
       └─ retry 次数耗尽 ───────────> 宿主报告 `Error: Retry failed`

cooldown_short_window
  ├─ 下一次请求使用 streamRetryStartTimeoutSeconds
  └─ knownTimeoutCooldownSeconds 到期 ─> 普通首事件窗口
```

timeout 会调用请求级 `AbortController`，并在发出错误前调用 `iterator.return()`。遵守公共 `signal` contract 的 Provider 会停止底层请求；同时忽略 signal 和 iterator cleanup 的 Provider，扩展无法强制杀死。用户 abort 保持 `stopReason: "aborted"`。watchdog 不实现第二套 retry 计数或退避策略。

## 场景

| 场景 | 触发方式 | 结果 |
|---|---|---|
| Stream 首事件 timeout | Provider 始终不发出第一个事件 | 请求被中止并发出可 retry 的错误 |
| Stream idle timeout | Provider 发过事件后停止继续输出 | 事件间隔超时后请求被中止，并进入宿主 retry 路径 |
| Thinking 停滞 | Provider 输出 thinking 后停止 | thinking 保持可见，随后 idle watchdog 报告 timeout |
| Retry 耗尽 | 每次 Provider 请求都超时 | 宿主 retry 达到配置上限并报告 `Retry failed`，不会无限重试 |
| 用户 abort | 用户取消父请求 | stream 以 `aborted` 结束，不伪装成 watchdog `error` |
| Retry cooldown | timeout 是否记录 provider/model cooldown | 下一次请求使用 `streamRetryStartTimeoutSeconds`；cooldown 到期后恢复普通首事件 timeout |
| 关闭 timeout | 首事件、idle、retry 首事件 timeout 都设为 `0` | 放慢的 stream 正常完成，不触发 watchdog timeout |
| Provider 过滤 | `providerIds` 是否只包装选中的 Provider | 选中的 Provider 被监控；未知 ID 报告 `Error: Unknown provider` |
| 非法配置 | 配置含有未知键、错误类型或非法值 | 出现 `Error:` 通知；watchdog 报错并继续使用明确的默认配置 |
| 配置页面 | 输入 `/stuck-guard config` | Editor 区域打开带边框的配置页面，并保存合法修改 |
| Provider picker | 在配置页面编辑 Provider ID | 输入文字过滤列表，Enter 切换 ID，Esc 保存；`j`/`k` 输入搜索文本，方向键导航 |
| 统计页面 | 输入 `/stuck-guard stats` | Editor 区域打开只读页面，显示当前 session 的 watchdog 统计 |

## 配置

配置文件位于 `<agentDir>/mpi-stuck-guard.json`。缺失键使用默认值。未知键、非法类型和非法值会显式报错；watchdog 继续使用明确的默认值，不会静默关闭。

```json
{
  "$schema": "./mpi-stuck-guard.schema.json",
  "streamWatchdogEnabled": true,
  "providerIds": [],
  "streamStartTimeoutSeconds": 300,
  "streamIdleTimeoutSeconds": 300,
  "streamRetryStartTimeoutSeconds": 300,
  "knownTimeoutCooldownSeconds": 60
}
```

| 键 | 类型 | 默认 | 含义 |
|---|---|---:|---|
| `streamWatchdogEnabled` | boolean | `true` | 启用 Provider 流首事件和 idle timeout |
| `providerIds` | string[] | `[]` | 要包装的 Provider；空数组表示所有已配置 Provider |
| `streamStartTimeoutSeconds` | 整数 >= 0 | `300` | 首个 Provider 事件最大等待秒数；`0` 关闭 |
| `streamIdleTimeoutSeconds` | 整数 >= 0 | `300` | Provider 事件之间最大间隔秒数；`0` 关闭 |
| `streamRetryStartTimeoutSeconds` | 整数 >= 0 | `300` | 本 session 内已知超时后的首事件窗口；`0` 关闭 |
| `knownTimeoutCooldownSeconds` | 整数 >= 0 | `60` | 本 session 保持 retry 首事件窗口的时间；`0` 在本 session 内持续。不跨 tab 共享 |

宿主仍负责 `settings.json` 中的 retry：

| 设置 | 归属 |
|---|---|
| `retry.enabled` | 启用宿主 retry |
| `retry.maxRetries` | agent-level retry 次数 |
| `retry.baseDelayMs` | agent-level 退避 |
| `retry.provider.maxRetries` | Provider SDK retry 次数 |
| `retry.provider.maxRetryDelayMs` | Provider retry-after 最大等待时间 |

这些设置不会被 `mpi-stuck-guard` 复制或覆盖。

## 命令

支持以下形式：

```text
/stuck-guard          # config 的快捷方式
/stuck-guard config   # 打开配置页面
/stuck-guard stats    # 打开当前 session 统计
```

`/stuck-guard config` 会在 Editor 区域打开配置页面。除 `config` 和 `stats` 外的参数都会被拒绝。页面可以编辑所有 watchdog 设置，并通过可搜索的多选列表选择 Provider ID。

`/stuck-guard stats` 会在 Editor 区域打开只读页面，显示当前 session 的 Provider 请求、完成、start timeout、idle timeout、Provider 错误、用户 abort 和 retry cooldown 事件次数。统计保存在内存中，session 启动时清零，不写入 `mpi-stuck-guard.json`。

非法值不会写入配置文件。例如 `streamIdleTimeoutSeconds` 必须是大于等于 `0` 的整数；非法值会显示 `Error:` 通知，并保留原来的值。
