# Node 24 工程验收与有限真实能力验证

日期：2026-10-10（UTC）；代码快照：`e240130a3348642a0f9bcad89f0bc025a8edcb6d`；分支：`feat/paid-chain-validation`。

## 结论

- **PASS：Node 24 工程迁移 N24-01…05。** 本轮使用实际 Node 24 重新执行离线门槛；当前提交 CI 也已成功。
- **PARTIAL：真实能力验收未完成。** Jev 首次调用失败后停止；Laya 分类成功，但首个 worker 的观测脚本出错，完成/退出/输出证据不足。未执行的案例不计通过。
- 原生后代环境/marker、Jev 可用性归因、一般路由质量/成本、跨项目历史状态同步仍未解决。离线通过不等于整体架构或全部真实场景验收。

本记录是新验收，不改写 [原 Node 24 实施记录](2026-10-10-node24-baseline.md)、A8/A9/A10 历史证据或旧 Node 22.8 成绩。

## 1. 新执行的离线门槛

实际工具链：Node `24.11.0`（逐命令指定 `~/.nvm/versions/node/v24.11.0/bin/node`）、pnpm `10.12.1`、Codex CLI `0.162.0`。未改全局 Node 默认值，未安装依赖。

| 命令 | 新执行结果 |
| --- | --- |
| `pnpm test` | exit 0；364/364；失败、取消、跳过、todo 均 0 |
| `pnpm run test:coverage` | exit 0；364/364；失败、取消、跳过、todo 均 0 |
| 总覆盖率（行/分支/函数） | 94.99% / 89.66% / 94.12%，各不少于 80% |
| `pnpm audit --audit-level high` | exit 0；`No known vulnerabilities found` |
| `git diff --check` | exit 0；离线前后 HEAD/已跟踪文件哈希不变，工作区干净 |

默认并行运行，没有用串行测试或选择性子集替代。构建和严格 TypeScript 编译包含在测试命令中；项目没有单独 lint 脚本。

已执行的 364 个测试名另外保存。覆盖的离线场景包括：初始化幂等/归属冲突、本地 pack/安装、doctor 版本边界、精确项目配置、六档绑定、完整 UTF-8 输入/8192 字节/NUL/输入冲突、Laya 单后端和 75% 双后端预算、Jev 三重准入/回退/取消、真实激活环境代理的正向对照与生产 direct 零增量、TLS 验证、初始环境剥离/marker、worker 参数/只读与写模式/协议/背压/EOF/信号/进程组、receipt 与 journal 哈希/安全打开/不泄露任务。

这些是合成/受控契约测试，不能证明真实模型授权、全部宿主安全策略、真实 Jev 恢复或成本节省。Node 22.8 专属运行用例已按用户决定退役，不算修复或新通过。

当前提交的 [CI 38060368062](https://github.com/milhous/turnhelm/actions/runs/38060368062) 已读取实际 job 和日志：`completed/success`，Node `24.21.0`，364/364、0 跳过/失败/取消；总覆盖率 94.87% / 89.54% / 94.12%；依赖审计无已知漏洞。与本地补丁版本及覆盖率分开记录，不沿用旧提交的 CI。

## 2. 执行前冻结的有限实测

用户接受：最多 **8 个 worker、每后端最多 12 次分类、0 自动补跑**；只读和仅归属明确的临时合成项目写入；不改全局配置或业务项目；Jev 首次失败停止。金额无法强制封顶、usage 不代表账单。缺少可信观测的场景保留未验证。

私有 `live-plan.json` 在任何实测前冻结：SHA-256 `df1297bb27dba4c31999afd6f5bbbc991a66291cc71e1533beb35af6c9730829`。完整非敏感中英任务、task hash/字节数、配置、顺序、oracle、240 秒 worker 外层截止和停止规则均保存；配置通过生产解析器校验。

| 案例 | 预先声明的用途 | 本轮结果 |
| --- | --- | --- |
| J0 | 生产 API 的 Jev 分类一次 | **FAIL**：273ms；固定类别 `request-failed-stage-unknown`；没有观察到 HTTP 状态 |
| W1 | 六个 ID 统一绑定 `gpt-6-luna/low`，正常路由后只读 worker | Laya 分类 **PASS**（3715ms、fast）；worker **UNVERIFIED**：观测脚本失败 |
| W2 | `gpt-6.1-sol/medium` 准入 | 未执行 |
| W3 | `gpt-6.1-sol/high` 准入及仅合成项目写入 | 未执行 |
| W4 | `gpt-6-astra/high` 准入 | 未执行 |
| W5 | `gpt-6-astra/xhigh` 准入 | 未执行 |
| W6 | `gpt-6-astra/max` 准入 | 未执行 |
| W7 | 默认绑定自然路由，只读；Jev 可用时双后端 | 未执行；Jev 已停止 |
| W8 | 受控本地 HTTP503 fixture 后回退到真实 Jev，合成项目写入 | 未执行；Jev 已停止；没有启动该 fixture |
| C1…C4 | 中英自然分类的合法六档输出、时延 | 未执行 |

统一绑定实验只检查 model/effort 组合准入，不等于六档自然选择；分类-only 的 oracle 是合法六档输出，不用于宣称语义准确率。本轮不是配对基线/候选质量成本实验，没有留出集或账单结论。

实际仅 **Laya 1 次、Jev 1 次、worker 启动尝试/预留 1 次，自动补跑 0 次**。worker 的 OS exec、完成状态、退出码和输出质量没有可保存的证据；不把启动尝试当成成功准入。客户端次数不证明服务器接收、推理或计费。没有运行 48 次分类的 `test:live`。

## 3. 失败与证据边界

### Jev

调用的是既有 `requestTaskChoice` / `directChoiceRequest`。固定请求失败没有可信阶段信息，HTTP 状态为 `null`；不能说再次返回 451，也不能归因地域、账号、DNS、代理或 TLS。没有改 endpoint、认证或代理，未自动重试；未证明分类恢复，更未证明完整 Jev worker 链路恢复。

### Worker 观测脚本

生产 `resolveProject` 使用 `realpathSync`，macOS 将本轮临时目录的 `/var/...` 规范化为 `/private/var/...`。私有验收脚本错误地比较 lexical 路径，在读取唯一 receipt 后触发断言。两个路径经 `samefile` 验证是同一目录：这是**验收脚本根因，不是产品路由故障证据**。

唯一的归属明确 W1 journal 已验证 task SHA-256、403 字节、Laya success、fast、`gpt-6-luna/low`、3715ms。journal 在 worker 前写入，不能证明 worker 成功。receipt 和输出只在已退出脚本的内存中，无法安全恢复；未补造完成结果。

仅离线将私有脚本的比较改为 canonical root；同目录正向/不同项目负向、生产 `resolveProject`、四项输出 oracle 正负检查通过。无产品代码变更、无新增分类/worker、冻结任务不变；停止后未为补齐矩阵重跑。

全局配置未被本轮代码写入，但实测开始时的 hash 只留在脚本内存，结束比较证据丢失，因此**全局 hash 未变的断言未验证**。实际工具/shell/有效策略来源也未观察；不凭模型自述关闭原生环境/marker 问题。过去环境 capture 的暴露或擦除风险不由本轮消除。

## 4. 后续与保留证据

- Node 24 工程迁移可独立验收；六组真实 worker 完成、读/写 oracle、默认自然 worker 和双后端完整链路不能验收。
- 补验须新冻结并显式人工批准，保留本轮失败/未验证；剩余原授权总量至多 7 个 worker、11 次 Laya 分类。Jev 本轮继续停止，不用余额自动重试。
- 原生安全机制、Jev 归因、一般质量/费用收益、四项跨项目状态同步继续开放；不猜设置、不直接编辑数据库、不新增观测框架。
- 本轮没有 commit、push、合并、清理 Git 分支、改全局配置、启停真实服务或业务项目写入。

私有证据目录：`$TMPDIR/turnhelm-node24-acceptance-20261010-b6crjh22`，归属私有、非仓库提交内容。包含离线阶段日志/receipt、364 个执行名、冻结计划、脱敏 live-results、CI 摘要、观测脚本离线修正记录和归属明确合成消费者。没有保存原始 worker/传输输出、密钥值、任意环境 dump 或原始响应体。
