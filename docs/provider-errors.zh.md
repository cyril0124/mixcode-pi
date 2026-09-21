# 模型请求错误诊断

[English documentation](provider-errors.md)

## 查看失败请求

模型请求失败后打开 `/console-history`。`[provider-error]` 记录包含 provider、
请求的模型、API 和异常字段。例如：

```json
{"provider":"custom","model":"example","api":"openai-completions","errors":[{"name":"APIConnectionError"},{"name":"Error","code":"ENOTFOUND"}]}
```

记录保存在进程内 console 历史中。原始异常不会加入会话消息或写入单独的日志文件。
调用方取消请求时不产生诊断警告。对话错误和重试沿用 provider 的常规行为。

## 原始异常回调

打过补丁的 `pi-ai` 文本适配器在 `StreamOptions` 和 `SimpleStreamOptions`
中接受以下可选回调：

```ts
onProviderError?: (error: unknown, model: Model<Api>) => void;
```

适配器在格式化最终错误前传入捕获的异常。`error` 和 `model` 是借用引用，
必须按只读值处理。回调同步调用，不等待返回的 Promise。观察者抛错或 Promise
拒绝会被忽略，让流仍能以原来的错误结束。

每次最终 catch 通知一次，包括捕获到的取消异常。适配器重试只有耗尽后才通知；
重试或传输回退成功恢复请求时不通知。宿主重试会启动另一个请求，可能再次通知。
异常保留 SDK 提供的 `cause`。

覆盖 Anthropic Messages、OpenAI Chat Completions 和 Responses、Azure Responses、
Codex Responses、Google Generative AI 和 Vertex、Bedrock Converse、
Mistral Conversations、Pi Messages，以及普通 faux 流执行时抛出的异常。
图片生成、deferred 操作、进入适配器前的认证或懒加载准备失败，以及未抛出异常的
错误结果不在回调范围内。自定义 provider 需要在捕获异常时主动调用它。

## mpi 接入

[`src/core/pi-models.ts`](../src/core/pi-models.ts) 为它创建的每个共享
`ModelRuntime` 安装
[`configureProviderErrorDiagnostics`](../src/core/provider-error-diagnostics.ts)。
它包装 `stream` 和 `streamSimple`；`complete` 与 `completeSimple` 委托给这两个方法。
通过该运行时发出的 agent 回合和压缩请求均可记录诊断。独立创建的运行时需要自行安装。

每个运行时安装一次。并发请求保留各自的调用方观察者，其异常与 mpi 诊断隔离。
Provider 注册和取消语义保持不变。

日志沿 `cause` 和 `AggregateError.errors` 最多检查五个异常节点，并防止循环引用。
只记录以下字段：

- 匹配 `[a-zA-Z][a-zA-Z0-9_.-]{0,79}` 的 `name` 和 `code`。
- 100 至 599 的整数 HTTP `status`；缺少 `status` 时使用 AWS 的
  `$metadata.httpStatusCode`。

没有有效字段的节点会被省略。异常消息、堆栈、请求头、响应体和凭证字段不进入日志。
自行提供观察者的调用方负责原始对象的脱敏和存储。
