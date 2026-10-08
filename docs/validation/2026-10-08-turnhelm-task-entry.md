# Turnhelm task-entry 验证记录

实现基线：`milhous/feat-task-entry`，`d9dee5c`。七项实现任务已于
2026-10-07 完成功能验收；本记录区分离线契约证据与尚未验证的在线语义。

- 使用说明：[README](../../README.md)。
- 已批准的历史设计：[task-entry spec](../superpowers/specs/2026-10-05-turnhelm-task-entry-design.md)。
- 已完成的执行计划：[七任务计划](../superpowers/plans/2026-10-05-turnhelm-task-entry.md)。
- 打包及 `init` 共用的规范指令：[routing skill](../../.agents/skills/turnhelm-routing/SKILL.md)。

## 已完成的离线验收

| 检查 | 证据及边界 |
| --- | --- |
| 项目配置及任务输入 | 六个 profile ID、v1 配置快照、严格字段校验、8192 UTF-8 byte 输入及取消。 |
| 分类与 direct transport | 有界响应、共享 deadline、Laya 优先、Jev 三重 eligibility gate、取消不 failover；分类失败不启动 worker。 |
| 单 worker 生命周期 | 明确 argv/environment/sandbox、JSONL 事件、粘滞失败、背压、部分 usage、owned group 终止与 sink 清理。 |
| `init` / offline `doctor` | 包相对模板；dry-run、幂等、冲突/竞态保护；独立只读检查；doctor 信号取消后的 inspection/probe 清理。 |
| CLI / receipt | 当前目录或显式 `--project`，无父配置发现；递归拒绝；分类开始后恰好一份回执，之前的拒绝无回执；SIGINT 130 / SIGTERM 143。 |
| 实际打包安装 | 独立、带空格的 Git consumer 中安装真实 tarball；18 个包条目、13 次 installed-bin 调用；双 Node；禁止 checkout 读取和 HTTP 请求，零 worker。 |
| 全量测试 | 实际 Node 26.5.0、22.8.0 各 317/317，失败、取消、跳过均为 0。 |
| 覆盖率（2026-10-07） | lines 95.82%、branches 89.52%、functions 95.58%，各项 >=80%。 |
| 依赖审计（2026-10-07） | `pnpm audit --audit-level high` 通过，无已知漏洞。 |
| 最低 CLI 兼容性 | 实际官方 Codex 0.160.0 原生二进制的完整性、version/help 及本地 inspect 通过；本机 0.160.1 同样通过。只证明版本/flag 证据。 |

Node 22.8.0 是最低支持版本，26.5.0 是验收环境；不是要求切换用户的
默认 Node。打包检查不是 npm registry 发布（`package.json` 仍为 private）。
不保留旧的全局配置、route bypass 或兼容 adapter。

## 可重复的离线验证

从 source checkout 运行，不能把 `pnpm build` 误认为安装了全局 bin：

```bash
pnpm install --frozen-lockfile --ignore-scripts
env -u TYPESAFE_API_KEY -u LAYA_API_KEY -u TURNHELM_ALLOW_HOSTED_JEV pnpm test
env -u TYPESAFE_API_KEY -u LAYA_API_KEY -u TURNHELM_ALLOW_HOSTED_JEV pnpm run test:coverage
pnpm audit --audit-level high
```

`test/live.integration.ts` 只参与编译，不在上述离线测试中执行。
不要为了重现本记录擅自执行 `pnpm run test:live`、真实 worker、backend
probe 或付费收益试验。`doctor --probe` 也会向每个 eligible backend 各发
一次合成分类请求；它不等同于普通离线 doctor。

## 仍未验证

- `agents.enabled` 等 Codex 配置键的运行时语义：`exec --help` 不能证明。
- 真实模型权限、在线 Laya/Jev 分类准确性及实际 worker 推理效果。
- whole-run usage 聚合及真实费用/收益；worker 没有 usage 时必须报告
  `"unreported"`，`classifierUsage` 为 `"unreported"`，
  `wholeRunUsageScope` 为 `"unverified"`，不能补零或换算节省比例。
- 与固定模型基线的付费对照试验，需要 owner 单独批准。

[Phase A 验证](2026-10-03-jev-laya-phase-a.md)属于历史接口及历史试验，
不能代替本任务入口的兼容性、分类质量或收益证据。

## 2026-10-08 文档与 skill 复核

- README 由独立 subagent 更新；共享 skill 按 `skill-creator` 校验通过，
  模板标记、自动发现政策和历史设计文件保持不变。
- 独立应用场景从旧 skill 的 setup/root/receipt 资料缺失，转为正确规划
  init、offline doctor、指定嵌套根及选项形任务；没有推理或写入授权扩张。
- 5 个 shell 代码块通过 Bash/zsh 语法检查，10 个本地文档链接有效。
- 实际执行 README 的 source-checkout shell function：临时带空格 Git
  项目中 6 次 init/doctor 调用验证 dry-run、幂等、用户 AGENTS 保留、
  skill/metadata 精确复制及无父配置发现。使用 fake Codex version/help
  与 HTTP 拒绝 guard，零 worker、零 HTTP；不据此推断真实模型权限。
- 初次全量测试捕获 skill 的具体 v1 配置键遗漏；保留原测试，仅修正
  skill 参考文本，focused RED 0/1 → GREEN 1/1。最终 Node 26.5.0
  完整测试 317/317，失败、取消、跳过均为 0；独立最终 delta 复核通过。
- 本轮只改 README、共享 skill、UI 元数据和本记录，不改产品源码、
  测试、依赖或历史 spec/plan，不运行在线推理、probe 或付费试验。
