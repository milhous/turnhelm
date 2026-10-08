# Turnhelm task-entry 验证记录

运行基线：合并后的 `main`，`053d42d`（PR #1）。本记录区分离线契约、
真实调用的具体路径证据，以及仍未验证的质量、权限和计费语义。

- 使用说明：[README](../../README.md)。
- 已批准的历史设计：[task-entry spec](../superpowers/specs/2026-10-05-turnhelm-task-entry-design.md)。
- 已完成的执行计划：[七任务计划](../superpowers/plans/2026-10-05-turnhelm-task-entry.md)。
- 打包及 `init` 共用的规范指令：[routing skill](../../.agents/skills/turnhelm-routing/SKILL.md)。

## 已保留的离线验收证据

下表保留此前验收结果，不表示本次文档 worker 重新执行了覆盖率、审计或
独立评审。合并基线的离线 CI 已通过。

| 检查 | 证据及边界 |
| --- | --- |
| 项目配置及任务输入 | 六个 profile ID、v1 配置快照、严格字段校验、8192 UTF-8 byte 输入及取消。 |
| 分类与 direct transport | 有界响应、共享 deadline、Laya 优先、Jev 三重 eligibility gate、取消不 failover；分类失败不启动 worker。 |
| 单 worker 生命周期 | 明确 argv/environment/sandbox、JSONL 事件、粘滞失败、背压、部分 usage、owned group 终止与 sink 清理。 |
| `init` / offline `doctor` | 包相对模板；dry-run、幂等、冲突/竞态保护；独立只读检查；doctor 信号取消后的 inspection/probe 清理。 |
| CLI / receipt | 当前目录或显式 `--project`，无父配置发现；递归拒绝；分类开始后恰好一份回执，之前的拒绝无回执；SIGINT 130 / SIGTERM 143。 |
| 实际打包安装 | 独立、带空格的 Git consumer 中安装真实 tarball；18 个包条目、13 次 installed-bin 调用；双 Node；禁止 checkout 读取和 HTTP 请求，零 worker。 |
| 全量测试 | 2026-10-08 新分支 Node 26.5.0 基线及先前文档修改后各 317/317，失败、取消、跳过均为 0；此前 Node 22.8.0 的 317/317 为历史兼容证据。 |
| 覆盖率 | 2026-10-07：lines 95.82%、branches 89.52%、functions 95.58%；2026-10-08 此前复核：95.82% / 89.41% / 95.58%，各项 >=80%。 |
| 依赖审计 | 2026-10-07 及 2026-10-08 此前 `pnpm audit --audit-level high` 通过，无已知漏洞。 |
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

## 2026-10-08 已授权的真实调用

以下均使用实际服务和生产 CLI，无 mock 或 harness 自动重试；仅证明
列出的路径，不是六档模型资格测试、分类质量基准或收益对照试验。

| 场景 | 实际结果及边界 |
| --- | --- |
| Jev 单后端 | 分类 707ms，选择 `fast / gpt-6-luna / low`；真实只读 worker 47013ms、exit 0、算术答案正确。 |
| Laya 不可用时的备用路径 | Laya 失败 3ms → Jev 成功 921ms，共 924ms < 4000ms；真实只读 worker 36714ms、exit 0、答案正确。这是启动本地服务前的历史场景。 |
| 两个后端的真实 probe | `doctor --probe` 对 Laya/Jev 各请求一次，均返回有效 choice；整个命令 1299ms，未记录单后端延迟，零 worker。 |
| Laya 成功优先路径 | 两个后端 eligible；实际 `run` 在 538ms 内经 Laya 选择 `fast / gpt-6-luna / low`；真实只读 worker 42834ms、exit 0、答案正确。该 run 请求数 Laya 1 / Jev 0。 |

最后两项属于同一次验证范围：合计 Laya 2 / Jev 1 分类请求、一个真实
worker。不是并行双分类，也不是该 worker 经两个后端各执行一次。
临时 consumer 未被只读 worker 改动，随后清理；main 和全局 Codex 配置
保持不变。既有本地 Laya 保持健康、仅监听 `127.0.0.1:8765`。

Laya 0.3.22 使用已安装环境及已缓存 `typed-decisions`、CPU/有界线程，
运行于当前登录会话的 launchd job；未安装登录/重启自启动，未扩大隐私
权限或重新下载模型。离线加载和健康证据不等同于真实任务路由成功。

## 此前真实文档需求的路由失败

此前在新分支 `milhous/docs-routing-validation` 上，将 README、skill 和
过时文档清理需求连同完整执行边界作为一个 6076 UTF-8 byte 任务，
交给实际生产 `turnhelm run --write`；没有预选模型、缩短任务或改变
当时默认六档配置及 4000ms deadline。该次仅允许本地 Laya，未启用 Jev。

- 结果：**失败**。Laya 请求尝试 1 次，4002ms 超时；routing 总计
  4003ms，CLI exit 1，恰好一份 receipt。
- `worker.status: "not-started"`、worker usage `"unreported"`；没有选择
  profile，没有启动付费 Codex worker，也没有由该 run 写入文档。
- 临时项目配置按内容校验后移除；现有 Laya 仍健康，无服务重启。
- 未自动延长预算、启用 hosted gate、替换模型或重试。健康检查及此前
  短任务成功不能保证实际需求在默认期限内成功；当次记录未确定超时
  原因，不能归因于模型权限或据此声称分类质量不佳。

文档维护由父会话接续；不能把后续文档检查通过记作此次路由成功。
任何追加 hosted 请求/重试都需要本次授权，不能借用旧试验的许可。

## 后续授权的根因修复与真实需求复验

- 同一完整请求的受控诊断：上传约 4ms，Laya 服务端推理
  5473.54ms，超过旧的 4000ms 预算；另一次同请求仅 653ms。
  延迟确有波动，尚未证明具体的冷启动、负载或缓存原因。
- 更重要的是，未指定 token 窗口时，checkpoint 的 1024-token
  默认值丢掉了 1543 个 state tokens 中的 668 个，`truncated: true`。
  仅延长超时不能修复基于不完整需求作判断的问题。
- 先写回归测试，观察旧实现的预算、窗口及截断校验失败，再修复共享
  分类边界：Laya 显式带 `max_len: 8192`；若声明 usage，其截断标记
  必须是自身字段 `truncated: false`、`state_tokens_dropped: 0`。
  Jev envelope、eligibility、failover share 和取消规则未改。
  模板预算改为 10000ms；既有项目配置不自动改写，预算也不是延迟保证。
- 修复后的生产路由边界使用原始 6076-byte 任务和实际 direct transport：
  1646ms 选择 `frontier / gpt-6-astra / high`；后端报告 input 1692
  tokens、state 1543、dropped 0、`truncated: false`。没有 worker 或 mock。
- 随后实际生产 CLI 使用同一原始任务及当前默认配置：Laya 尝试 1602ms，
  routing 1603ms，自动选择上述 profile；一个 `workspace-write` Codex
  worker 完成 README/验证记录对齐，276592ms、exit 0；CLI exit 0、
  恰好一份 receipt，run 请求数 Laya 1 / Jev 0。
- 本次排查及复验合计 6 次真实本地分类请求（4 次诊断、1 次路由边界
  复验、1 次 CLI run）、一个真实 Codex worker；没有 hosted 请求、
  自动重试、预选模型、服务重启或全局配置修改。临时配置校验后移除。

worker 内全量测试未通过：其报告 250 通过、23 失败，包括 21 项 loopback
`EPERM`、CLI 测试 Node 原生断言崩溃及一个权限竞态用例；相关离线测试
102/102 通过。父会话独立复现 `mode edit between inspection and apply is
refused as a race` 在继承 `umask 077` 时的失败：fixture 初始已为 0600，
再 chmod 0600 没有产生模式变化。未扩大 worker 权限、修改无关用例或
为此追加付费 worker；这不等于 worker 内全量测试通过。

worker 退出后，父会话在普通 shell 环境重新执行全量测试及全量覆盖率，
均为 321/321、零失败/取消/跳过；最新覆盖率 lines 95.84%、branches
89.63%、functions 95.58%，均 >=80%。依赖审计无已知漏洞；skill 结构校验、
9 个 Bash/zsh 代码块、8 个本地链接及 README/配置模板一致性检查通过。
现有 skill 已含所需启动指引，worker 的 `.agents` 写入受只读策略限制，
没有为此扩大权限或覆盖已通过场景验收的 skill。

本次产品修复仅涉及 `src/systemone.ts`、`assets/config.json` 和
`test/task-routing.test.ts`，并对齐 README/本记录；保留此前文档清理，
当前 10-05 plan/spec、skill/UI 元数据、六档绑定、全局配置及 Laya job 未变。

receipt 仍报告 `classifierUsage: "unreported"` 和
`wholeRunUsageScope: "unverified"`；上面的 classifier token 数据来自
独立的真实路由边界复验，不是 CLI receipt 的 usage 或 whole-run 费用。

## 本轮动态路由验收：真实路径与剩余缺口

用户授权按正常使用完整验证，意外失败最多追加三次重试。本轮只在独立
临时 Git consumer 中使用当前生产 `init`、`doctor`、`run`、实际 Laya/Jev
及已安装 Codex 0.160.1；没有强制 profile、伪造分类答案或用内部 worker
接口冒充动态路由。预期拒绝、超时及取消按正确行为计为通过，不付费重试。

共记录 **38 个验收结果：34 通过、4 失败**；六个有用任务加三次授权重试，
共 **9 个实际 Codex worker**，均 completed、worker/CLI exit 0。
worker 完成不等于全部验收条件通过：四个失败结果均保留，未被后续成功覆盖。

| 真实场景 | 结果及证据边界 |
| --- | --- |
| 安装、离线检查及分类前拒绝 | 26 项通过：dry-run/幂等/保留 owner 文本及有效自定义配置、offline doctor、UTF-8/字节边界/非法参数、无父配置发现、递归拒绝、Jev gates、Git 前置及 stdin SIGINT/SIGTERM。零分类、零 worker。 |
| 实际 Laya 超时及取消 | 100ms 本地预算产生 timeout；已建立实际 Laya TCP 连接后 SIGINT 产生 cancelled/exit 130。各一份 receipt、零 worker、零 Jev；客户端取消不证明服务端推理已经结束。 |
| 双后端本地成功优先、只读 stdin | Laya 340ms → `balanced / gpt-6.1-sol / medium`；worker 69534ms，答案正确、文件字节未变，Jev 请求数为 0。 |
| Jev 单后端区间合并实现、写权限 | 同一完整任务初次及三次重试，自然选择依次 fast/balanced/fast/balanced；父级不可变测试每次均 12/12 通过，仅允许的产物变化。但额外 shell 环境检查全部失败，详见下文。 |
| Laya 单后端异步账本实现、写权限 | routing 1657ms → `frontier / gpt-6-astra / high`；worker 120767ms；父级不可变测试 8/8 通过，仅 queue/ledger 两个实现文件变化。 |
| 连接失败后的 hosted fallback、只读审计 | 临时配置指向确认未监听的 loopback 端口；Laya failed 3ms → Jev success 677ms，routing 680ms；`frontier_xhigh / gpt-6-astra / xhigh`，worker 345705ms、独立契约核对通过、零文件变化。未停止用户 Laya。 |
| 实际本地 worker 控制边界审计 | Laya 984ms → frontier/high，worker 369819ms；独立契约核对通过、零文件变化，发现下述两处真实收尾缺陷。 |
| 完整当前验收需求、双后端只读报告 | 8014 UTF-8 bytes，未缩短任务；Laya timeout 1002ms → Jev success 693ms，routing 1695ms；frontier_xhigh/xhigh，worker 676588ms。报告及文件不变由父级核对；该源码快照在下述 worker 修复之前，不是修复后 live 证明。 |
| 实际双后端 doctor probe | Laya/Jev 各一个合成请求，均通过，零 worker；不作为有用任务或模型访问证明。 |

本轮合计 Jev **7 次实际请求**（run 6、probe 1）；Laya **8 次客户端尝试**
（run 7、probe 1），其中一次为上述未监听端口连接失败，不能计作服务
实际接收了请求。健康 GET 不计分类。没有为补齐档位而重试有效选择。
实际 completed 回执自然覆盖 fast、balanced、frontier、frontier_xhigh；
**deep 和 frontier_max 的实际访问仍未验证**。

### 环境检查失败与定向清理

- 区间任务首次未生成环境验证产物；三次重试改用始终输出布尔观测的
  helper，均发现正常 worker shell 中 `TYPESAFE_API_KEY` 存在，故仍失败。
  完整分类任务字节未变；helper 的可观测性修正及首次失败均保留。
- 实际 Codex **进程环境**观测证明四个敏感变量已删除、managed 标记为 1；
  无模型调用的独立对照证明 `zsh -lc` 会重新引入 Jev key，而不读取
  启动文件的 zsh/bash 对照不会。宿主 `.zshenv` 含该变量名。
  所有观测只保存布尔值，不打印密钥；没有修改启动文件、认证或 shell
  默认设置。进程环境剥离不等于宿主文件系统秘密隔离，不能将此风险写成通过。
- 实际 workspace-write 执行期间，全局 Codex 配置新增五个本轮临时项目
  trust 条目。获得用户单独授权后，仅移除这五个条目；复核其余 TOML
  配置值完全一致、权限仍为 0600、五条均不存在。文件原始字节哈希未恢复
  到本轮起始值；不声称整个文件字节还原，也未扩大清理范围。
- 现有 Laya 保持 PID 55374、launchd runs 1、健康且仅监听 loopback；
  未重启服务、下载模型或改变隐私权限。临时项目与脱敏证据留在私有归档。

### 验收发现的 worker 缺陷及回归

`src/codex.ts` 的两个缺陷均先复现再实现：已有协议失败、child close 和
进程组清理完成后，若输出仍有未回调的 accepted write，迟到取消没有
重新驱动 settle；shutdown 后 stdout handler 仍拼接已弃用帧，TERM grace
期间可保留无界缓冲。回归证明消息/诊断两个迟到取消均挂起，以及实际
TERM-resistant fixture 洪泛保留 2621440 bytes。

生产修复仅三处：shutdown 清空 frame；后续 stdout chunks 直接丢弃但
继续排空 pipe；onAbort 重新 settle。未改变 API、argv、profile、失败优先级、
后端策略或客户端配置。新增三项回归使用真实受控子进程/进程组；迟到
取消由 child close 与 group ESRCH 共同触发，不靠固定睡眠猜测时序。
私有基线诊断允许冷启动后仍证明两个生命周期阶段的挂起；tracked 防挂起
限制未改。初版洪泛背压及私有 observer 转义错误的失败日志保留，不计作
有效 RED。最终 focused 3/3 通过，独立评审无 Critical/Important/Minor。

最新完整**串行**覆盖率验证为 **324/324、零失败/取消/跳过**；lines 95.67%、
branches 89.74%、functions 95.58%，全部满足 80% 全局阈值。依赖审计零已知漏洞，
skill 结构校验通过。使用原有 build 和覆盖率选项，另加 `--test-concurrency=1`，
没有删测试或放宽断言。默认并行及早期串行覆盖率失败日志均保留。
默认 `pnpm test` 初次及三次重试分别为 319/324、320/324、323/324、321/324；
最终仍有三项原有 fixture 检查失败，不能冒充默认命令已通过。本机临时
shebang 脚本曾在成功 spawn 后 3139ms 才有首个 stdout，超过原 2500ms
fixture watchdog；独立对照复现启动阶段延迟，底层 OS 原因尚未证明。
另外出现原有 2000ms preflight inspection 的 fixture 超时；没有增加生产
预算或改动无关测试。不能从一次串行通过推断默认并行测试在此宿主稳定。

私有归档 `turnhelm-dynamic-acceptance-9po9nun9` 保存 manifest、完整任务及
hash、results、每次 stdout/stderr/receipt、父级产物/测试、RED/GREEN、覆盖率、
环境布尔观测及定向清理记录。只增加必要的 `src/codex.ts`、现有 worker
测试及本记录；此前 README/skill/路由修复与文档清理保留，main 未改、未发布。
本轮结论是**代表性真实路径与所列修复已验证，不能签署“所有真实场景全部通过”**。

## 文档与 skill 维护边界

- 更新 README、共享 skill 和本记录；移除已被任务入口替代的
  2026-10-02/03/04 旧方案及旧接口验证文档，历史可从 Git 追溯。
- 本文档 worker 不修改 2026-10-05 task-entry plan/spec、产品源码、测试、
  依赖、UI 元数据、模板标记及自动发现政策；保留他人的既有修改。
- 先完成 317/317 离线基线及独立 reference 场景：旧 skill 无法给出
  已安装 Laya 的 loopback/cache-only 启动指引，再按 `skill-creator`
  补充该指引及真实需求验收方法。结构校验不替代实际应用场景验证。

此前文档维护的离线复核：`skill-creator` 结构校验通过；独立场景可从新 skill
正确提出既有 venv 的离线/loopback 启动、当前需求单次执行、分开的
write/hosted 授权以及 receipt/费用边界。独立源码及证据复核无实质问题。
9 个 shell 代码块通过 Bash/zsh 语法检查，8 个本地 Markdown 链接有效，
README 配置与资产模板一致。实际 README source-checkout shell function
在临时带空格 Git consumer 中完成 6 次 init/doctor 调用，验证 dry-run、
幂等、用户 AGENTS 保留、skill/metadata 精确复制及无父配置发现；使用
实际 Codex 0.160.1 version/help，fetch 拒绝 guard 记录零请求、零 worker。
这些检查仍不代表当前需求的成功路由。

## 仍未验证

- 本轮未自然选择的 `deep / gpt-6.1-sol / high` 与
  `frontier_max / gpt-6-astra / max` 的实际访问。
- `agents.enabled` 等 Codex 配置键的运行时语义；help/传参证据不足。
- Laya/Jev 对一般真实需求的分类质量；本次文档任务成功路径不代表质量基准。
- whole-run usage 聚合及真实费用/收益。Codex 使用 ChatGPT 登录，
  不是按 API key 计费的证明；worker 快照不代表发票金额。
- worker 无 usage 时为 `"unreported"`，`classifierUsage` 为
  `"unreported"`，`wholeRunUsageScope` 为 `"unverified"`；不能补零
  或换算节省比例。固定模型付费对照仍需 owner 单独批准。
- launchd 注入崩溃后的自动重启行为；本轮未做破坏性测试。
- 宿主 shell 重读 Jev key 后的秘密隔离，以及默认并行测试的冷启动稳定性。
