# mpi-batch-skill

[English](README.md)

仅手动调用的 skill，用于编写、验证和启动 MixCode batch 脚本。在 MixCode 中输入 `$mpi-batch <任务>`，或通过 Pi 的 skill 命令输入 `/skill:mpi-batch <任务>`。

`disable-model-invocation: true` 将该 skill 从模型系统提示的技能列表中隐藏，用户仍可显式调用。该设置不限制文件访问。Skill 默认编写并验证脚本，只有用户要求时才启动。

Pi 通过 `pi.skills` 发现 skill。MixCode 将其安装到 `<agentDir>/extensions/mpi-batch-skill/`，由 `index.ts` 通过 `resources_discover` 提供 `skills/` 目录。

[SKILL.md](skills/mpi-batch/SKILL.md) 包含工作流、CLI 命令、示例和执行限制。API 声明位于随包及编译二进制分发的 [TypeScript](skills/mpi-batch/references/mixcode-batch.d.ts) 和 [Lua](skills/mpi-batch/references/mixcode.lua) reference 文件。验证和执行需要 `PATH` 中的 `mpi`。

源码 checkout 中，根目录 `mixcode-batch.d.ts` 和 `mixcode.lua` 是指向这些 reference 的相对软链接。更新声明时编辑 reference 文件。Windows Git checkout 需要启用软链接支持。
