# 动态路由可靠性与校准规格

日期：2026-10-11；代码基线：`9a484c0f9bb2fcea999ada2c5bb7eb1cff46cc49`。

> 状态：已按 `gpt-6-astra/high` 独立只读复核意见修订，待用户审阅与实施批准。用户授权本轮写 spec、Astra 复核、更新 spec 和执行计划；不等于代码实施、新真实调用或发布授权。

## 1. 决策与证据边界

基于 [标准链路 PARTIAL 报告](../../validation/2026-10-11-dynamic-routing-standard.md)，只考虑长期收益、安全和性能，不维护向后兼容层。**先让验收准确揭示缺陷，再决定是否改路由；不凭一次选档或一次 ETIMEDOUT 猜修生产行为。**

确定的缺口：只读 oracle 只看最后一行、读/写 JSON 比较允许多余字段、合法选档被工程 PASS 掩盖了策略 band 不匹配。有限数据：英文仅改标题选 frontier，中文等价任务选 balanced；各一次。未知：Jev 的失败根因、一般路由质量、最轻充分模型、后代隔离、金额和节省。

本期工程交付仅为 **test-only 严格 oracle + 独立、冻结、双语的分类校准入口**。Jev 因果诊断与 prompt 候选是两个条件性后续调查，不把未知问题伪装成必须重构。写完文档或离线测试通过都不能关闭这两个实际 findings。

### 方案比较

| 方案 | 长期收益 / 安全 / 性能 | 决定 |
| --- | --- | --- |
| A：复用现有 prepare/claim/reserve/routeTask；严格结果 oracle；校准与准入分离 | 纠正绿灯含义，避免反复付费；生产热路径零新增开销 | **采用** |
| B：标题/中文关键词规则、强制降档、低 confidence 升级或重试 | 样本拟合，可能降低真实质量；增加隐式策略和请求 | 拒绝 |
| C：统一评测平台、observer 总线、缓存/并行/自适应预算、代理自动切换 | 根因未证实，扩大权限、数据面与维护成本 | 拒绝 |

不考虑向后兼容意味着替换 test-only 旧格式/旧判定，不意味着降低安全门槛、删历史证据或迁移生产 config。

## 2. 范围、继承与不变项

主要修改：`test/live-acceptance.ts`、`test/live-acceptance.test.ts`、`test/live.integration.ts`、`test/fixtures/live-acceptance.json`、README 与共享 `.agents/skills/turnhelm-routing/SKILL.md` 的 live 说明段落。skill 只同步当前套件/预算/退出语义；按 skill-creator 做窄修改与验证，现有 `.claude/skills/turnhelm-routing` 符号链接继续指向同一来源，不复制实现、不改 YAML 元数据。不新增运行依赖、独立服务、任意任务/插件/oracle DSL 或收费平台；不修改 package script、生产配置模板或六档 model/effort 映射。

继承 [可信验收加固规格](2026-10-10-acceptance-hardening-design.md) 已实现的安全契约：私有 owned run、人工读 manifest + SHA 批准、严格格式、冻结源/dist/任务/配置/输入/指令/工具、claim 时的宿主快照比较、canonical/dev/ino、一次性 O_EXCL claim、预留先 durable、observed 先于判定、证据写入失败停止、归属取消与未知清理状态。**当前 runner 没有末尾宿主复查，也没有 evidence 文件大小硬上限**；本期明确新增 §5 的末尾完成协议，不把未实现的历史设计当作已有保证，不重做 runner。

版本与性能约束：产品 Node `>=24.0.0`，必需验收实际 `24.x >=24.5.0`；pnpm `10.12.1`；Codex CLI `>=0.160.0`；现有依赖/锁文件不变。正常路由仍最多每 eligible 后端一次、顺序 Laya→Jev、总体预算不变、dual 中 Laya 75%、失败不启动 worker；Jev 三重门槛、TLS 校验、无代理继承/redirect/retry 保持。

不增加生产热路径的 I/O、fsync、计数接口、探针、分类请求或 worker。初始子进程环境安全和供应商侧 model/effort 实际解析仍只保留已有承诺，不从本期测试推导新保证。

## 3. 严格任务结果 oracle

复用现有私有 `jsonEquals(raw, expected)`，对**完整且已受字节/UTF-8 限制的 payload**一次 `JSON.parse`，不提取最后一行、不用正则寻找 JSON：

- 解析结果必须为非 null、非数组对象；恰好两个 own enumerable keys：`count`、`sum`。
- 两值必须为 safe integer，且分别等于独立合成输入事实 4、17。保留输入/输出路径、receipt/journal、Git/文件树和沙箱边界的独立检查。
- stdout 和 `out/summary.json` 使用同一判断。JSON 允许的前后空白、格式缩进和字段顺序可不同；前缀/后缀说明、code fence、多个对象、额外字段、缺失字段、错误数值均失败。
- 采用标准 `JSON.parse` 的对象语义，不新增自定义 parser、重复成员扫描器或要求字节级 canonical JSON。仍不保存 raw 输出；失败前保存已有有限 observation，立即停止 worker suite。

## 4. 校准与准入拆开

### 4.1 唯一入口和固定预算

保留既有两步命令，新增两个有限 suite 字面量，无通用 partition 参数：

```bash
pnpm run test:live -- --prepare calibration-dev
pnpm run test:live -- --prepare calibration-holdout
# execute 仍要求独立新 manifest 和操作者审阅后批准的完整 SHA
```

prepare 永远零分类、零 worker、零健康探针、零服务启动；execute 不自动串联 suite。

| suite | roster | 最大预留 |
| --- | --- | --- |
| laya | 六项 pair rebind 准入 + 一项默认未 rebind worker；删除旧四项合法-only 分类 | worker 7 / Laya 7 / Jev 0 |
| jev | 原单后端默认只读 worker | worker 1 / Laya 0 / Jev 1 |
| dual | 原 Laya 优先 + owned HTTP503→Jev 写例 | worker 2 / Laya 2 / Jev 2 |
| calibration-dev | 两对等价双语 × 三次预声明 trial | worker 0 / Laya 12 / Jev 0 |
| calibration-holdout | 两对等价双语 × 三次预声明 trial | worker 0 / Laya 12 / Jev 0 |

旧轮的 9 worker / 14 后端授权已结束；本表是设计上限，不是新执行授权。local Laya 也须任务/算力授权。六档准入不证明自然选档，校准不为覆盖六档而改绑 profiles。

classifier-only 沿用现有空 root、dev/ino=0、无 inputHashes/allowedChanges、worker reservation=0 的 case 形态，不创建消费者、不启动生产 CLI/Codex、不做 Codex 版本/help probe；必要的既有 Git 工具身份核对保留。只通过 `routeTask(task, config, {env,signal})`，不能直接调用不负责全部资格/任务验证的 `requestTaskChoice` 绕过边界。校准配置为默认模板 profiles、不 rebind；仅 Laya enabled，Jev disabled。即使 env 有 hosted gate/key，Jev 请求也必须为零。

### 4.2 冻结 corpus 和 manifest v2

将 corpus、AcceptanceManifest 升为 v2，执行拒绝 v1；不加兼容 parser、转换器或自动恢复。生产 `.turnhelm/config.json` 保持 v1，因为它没有本期变更。原报告、seal、已 claim run 和旧日期验证文档不可重写。

corpus 严格已知键：`version`、`calibrationTasks`、`workerReadonlyTask`、`workerWriteTask`、`workerFixtureInput`。八项 calibrationTasks 的键为 `id`、`pairId`、`language`（en/zh）、`split`（dev/holdout）、`task`、`allowedProfiles`（非空且无重复的 ProfileId[]）。复用同一个 test-only parser 校验 prepare 与 claim，不仅 TypeScript cast；任务通过现有 validateTask，全文 UTF-8 ≤8192 字节，不缩短；worker input 的 values 为 safe integer，和为 safe integer。

每个 pair 恰有一条 en、一条 zh，同 split/同 allowedProfiles；ID 唯一。两份校准 manifest 只允许各自完整四任务 × 三 trial 的 roster，按下表条目顺序执行 trial 1 四项、trial 2 四项、trial 3 四项。固定 case ID 为 `<task-id>-trial-<1|2|3>`；不能删不匹配例、替换文本、重复 trial、调序或改标签来通过。

新 oracle 替换 `classifier-valid`：`{kind:"classifier-band", pairId, language, split, trial, allowedProfiles}`。claim 将 case ID/任务 hash/完整 oracle 元数据逐项与被冻结的 corpus 和 suite roster 核对，而非仅允许某个任务 hash。校准 profiles 必须等于默认模板、routingTimeoutMs 等于模板值；后端必须只启用 Laya，URL 仍用现行 production parser 的合法 loopback 约束并冻结，允许离线测试使用 owned loopback fixture。预算必须等于 roster 的 reservation 总和且不超套件上限。

普通 worker suite 保留既有合法子集能力，但禁止 classifier-only case；校准 suite 禁止任何 worker case。所有配置继续通过 production parseProjectConfig；case/manifest/oracle 未知键或错误 enum 拒绝。保留 1MiB manifest 与现有 stdout/stderr/行/文件读取限制；evidence 靠固定 roster、有限记录和白名单字段约束，不新增文件计数或日志设施。

### 4.3 首版语料（全文，不给分类器 profile 提示）

表中的顺序即各 split 每 trial 的顺序。它是固定回归策略，不是所有生产任务的客观真值。

| id / pairId / split / language | allowedProfiles | 完整 task |
| --- | --- | --- |
| heading-en / heading / dev / en | fast, balanced | Rename the README heading to Turnhelm; change only that line. |
| heading-zh / heading / dev / zh | fast, balanced | 把 README 的标题改成 Turnhelm，只改这一行。 |
| race-en / race / dev / en | deep, frontier, frontier_xhigh | Investigate a worker/database race: an enqueued job sometimes runs before the creating transaction commits and reads missing data. Trace the transaction, enqueue, and worker-read ordering; fix the cause and add a deterministic regression test. Limit changes to this flow; preserve successful-job behavior. |
| race-zh / race / dev / zh | deep, frontier, frontier_xhigh | 排查 worker 与数据库的竞态：入队任务有时在创建它的事务提交前执行，读不到数据。追踪事务、入队和 worker 读取的顺序，修复根因并添加确定性回归测试。只改这一条流程，保持成功任务的行为不变。 |
| decoy-en / decoy / holdout / en | fast, balanced | In README, rename the heading "Security architecture" to "Security"; change only that heading line, with no code or behavior changes. |
| decoy-zh / decoy / holdout / zh | fast, balanced | 在 README 中把标题“Security architecture”改成“Security”；只改这行标题，不修改代码或行为。 |
| auth-en / auth / holdout / en | frontier, frontier_xhigh, frontier_max | Review tenant isolation and token revocation across an API gateway, session store, and asynchronous workers. Analyze concurrent token rotation, revocation during store outages, and sensitive data leakage in telemetry; provide evidence, attack timelines, trade-offs, and a minimal remediation and regression-test plan. Do not change files. |
| auth-zh / auth / holdout / zh | frontier, frontier_xhigh, frontier_max | 审查 API 网关、会话存储和异步 worker 之间的租户隔离与令牌撤销。分析并发令牌轮换、存储故障期间撤销以及遥测中的敏感数据泄漏，给出证据、攻击时序、权衡和最小修复与回归测试计划。不要修改文件。 |

三个 trial 是预先授权的不同观测，不是失败后的重试。记录逐例 profile、band 判定和既有 duration；同一文本得到不同合法 profile 并非必然错误，只判是否在预声明 band。band 过宽不能用来事后掩盖不匹配；变更语料/标签须新版本、新设计理由和批准。

holdout 在候选冻结前不得执行或用于调 prompt。文本在仓库内公开，且都是人工小样本，所以这里只称**未用于调参的留出参考集**，不宣称盲测、无污染或统计泛化。已查看结果后不能改候选反复测同一集却仍称独立留出验收。

## 5. 两维判定和有限完成事实

沿用 SafeEvidence 和 appendEvidence，不增加 observer/report framework：

1. `observed` 的已观测事实仍先 durable。
2. `verified` 新增必填 `policy:"match"|"mismatch"|"not-applicable"`。工程 verdict/checks 只表达合法选档、eligible、准确一次 Laya attempt 和冻结边界；worker 为 not-applicable。校准在工程 pass 后依据 frozen band 得出 match/mismatch，工程失败为 not-applicable，不能报策略正确。
3. **只有校准**的合法、eligible、边界完整但 band mismatch 继续下一项已批准观测；worker oracle 失败、routing/response/资格错误、drift、signal、timeout、evidence I/O 失败仍立即停止，未执行项不算通过。这是新 suite 预声明的测量策略，不静默削弱旧 fail-fast。
4. 仅完整校准 roster 后进入 §5.1 的完成提交：追加 `completed`：`{phase:"completed", outcome:"pass"|"policy-mismatch", cases:number, policyMatches:number, policyMismatches:number}`。计数为非负 safe integer，matches+mismatches=cases=12；mismatches=0 才能 outcome=pass，否则必须 policy-mismatch。完整且全部 band 匹配 exit 0；**完整但有 mismatch exit 3**；工程/边界/写盘失败或 incomplete exit 1，signal 保持 130/143、用法错误保持 2。
5. completed 的 append 或 sync 失败仍 exit 1，不报完整；同 run 不可 replay/resume。sanitizeEvidence 拒绝非法 policy/outcome/计数，只白名单投影固定字段，不透传任意新增字段、错误文本、confidence 当概率或 raw 响应。

报告要同时列工程状态、策略状态、已执行/计划数量和终止原因；不因 legality 通过而写“路由准确”，不因 incomplete 少数匹配而写“全套通过”。提供有限逐例表即可，不添加 p95、排行榜、confidence 阈值或费用计算。

### 5.1 最后一例之后的完成协议

最后 observation/verified durable 后，所有 suite 在正常返回前重新检查取消、冻结 corpus/source/dist 和宿主 config 存在/hash；校准才追加 completed。取消优先于正常完成，drift 不回滚。把宿主快照读取复用为一个 test-only helper，prepare/claim/末尾使用已有 `readProjectFile(REPO_ROOT,".turnhelm/config.json",65536)`：仅 ENOENT 为 absent；不可读、symlink、FIFO、超限都拒绝，不把异常当作不存在。生产读取函数不改。

校准 completed append+sync 后再复查取消和相同冻结/宿主边界，成功关闭 evidence FD，再做最终同步 abort 检查，才到正常完成提交点（返回 0/3）；worker suite 不新增 completed，但同样需要末尾核验、关闭成功、最终取消检查才能返回 0。无需通用状态机或第二个 commit 文件。

在提交点之前发现取消/drift/I/O/close 失败，尽力追加既有固定 stopped（已关闭 FD 则不重新打开），返回 signal code 或 1；**可能已经可见的 completed 行不独立证明完成**。报告必须同时核对调用方记录的实际进程退出码（0/pass 或 3/policy-mismatch）、完整 12 条工程 pass verified、匹配的计数以及没有 stopped。正常退出证据缺失、崩溃/kill、退出1/2/130/143或字段矛盾一律 incomplete/unknown；不从 partial append 或 sync 失败的行恢复。提交点后的宿主变化超出该次冻结快照保证，不宣称防御同 UID 宿主的一切并发篡改。

## 6. 两条条件性调查（独立，不扩大工程范围）

### 6.1 Jev 根因与恢复

现有失败事实只有 request / HTTP null / ETIMEDOUT。先读既有有限记录与官方受支持接口；必要时另行批准有次数/时间界的非认证 DNS/连接/TLS 诊断，固定官方 endpoint、验证证书，不读/复制 key、完整环境或 auth 文件，不用 curl 带 key 代替实际生产链路。只保存白名单类别/耗时/状态；没有可靠证据就保持 unknown。

证据定位到可修根因后，才提交独立最小修复设计和测试；本计划没有预定 proxy/region/TLS/auth/endpoint 修复，没有自动 retry 或 fail-open。认证真实请求须单独新冻结批准，仍走 routeTask/原 CLI gate；不继承上轮额度。Jev 关闭条件是新批准的 Jev-only 默认映射和受控 fallback 都成功选择并完成 worker/独立 oracle，同时失败场景仍不启动 worker。外部无法解决时有界停止，不以诊断“做过”关闭 finding。

### 6.2 路由策略候选与真实质量

先批准并完成 calibration-dev 基线。只有可重复的有界证据支持机制性改进时，允许提出**一个** `src/systemone.ts` criteria/instructions 的最小候选；不改 model map、预算、gates、任务正文，不加关键词分流/强制降档/自动重试。若只是外部分类器能力限制且无可证改进，记录局限、不发布虚构修复。

dev 基线完整记录 12 次，无论策略是否匹配；发生工程失败则先停止调查。只有基线证据支持时才提出一个候选。候选冻结后，新独立 source/dist SHA 的 manifest 重新批准，并先完成相同 dev roster 的 12 次：必须工程完整、12/12 匹配 band、正常 exit 0，才允许另行批准 holdout 12 次。候选 dev 失败/不匹配则停止，不消耗 holdout；不强制制造候选。最后才执行未用于调参的 holdout；失败保留，停止该候选推进，不继续拟合同一 holdout。基线/候选有不同源码必须各自 prepare/批准，不重用旧 manifest，不后改 band。

该小语料全 band 匹配仅允许称“冻结策略回归通过”。要声称质量/性能收益或更轻模型充分，另行冻结有真实任务结果 oracle 的 baseline/candidate 成对 worker 试验，包括失败、同输入/沙箱/模型映射、开发/留出集、执行顺序、独立 run 和次数上限；所有结果与逐例时延保留，禁止仅挑成功例。本期不编造复杂业务 fixture、不建立通用 benchmark；具体任务/权限未冻结就不执行。ChatGPT 登录仍不证明 API 金额或节省；worker 内部请求无硬账单界，单次有限 worker 上限不是金额保证。继承旧 Node24 spec §11 的执行前费用门槛：须核验受支持控制足以满足当次支出授权，不能核验就不启动相关真实实验；若用户明确仅授权 ChatGPT 登录的次数口径，披露无金额硬界并按该口径批准，仍不改称 API 预算验证，不新增预算产品。

## 7. 验收与阶段完成定义

| ID | 必需证据 |
| --- | --- |
| RR-01 | stdout 全 payload + 读/写共用严格 JSON oracle；多余说明/对象/字段、错值失败，合法 JSON 空白/顺序通过；先保 observation 后 fail-fast |
| RR-02 | corpus/manifest v2 严格 parser；旧 v1/未知键/错误 band/split/language/trial、任务/roster/config/预算伪造均在调用前拒绝；历史不可重写 |
| RR-03 | dev/holdout 各 12 次 Laya 上限、零 worker/零 Jev、准确默认映射/routeTask 边界；prepare 零网络；旧 laya 去除四合法-only例，worker suite 不接纳校准例 |
| RR-04 | engineering/policy 分离；mismatch 只在校准继续，完整 mismatch exit3+completed；运营/边界/写盘失败立即停，incomplete 不伪造完成、失败不重放 |
| RR-05 | 白名单有限证据、canary/raw 输出不落盘，预留/observation 的 durable 顺序、取消/漂移/claim/输出限制等已有回归保持；末尾/提交中取消或drift、completed append/sync/close 失败不算完整，宿主异常fail-closed；无生产热路径改动 |
| RR-06 | README/共享 skill/命令 grammar/预算/退出码一致且符号链接分发不变；实际 Node24 test+coverage 零失败/取消且关键安全用例不跳过，src 行/分支/函数各≥80%；当前代码审计/本地 pack 回归与准确结果 |
| RR-07 | Jev 因果诊断有独立批准、有限安全事实和 unknown 停止条件；恢复关闭必须新实测 Jev-only+fallback worker 证据，否则保持 open |
| RR-08 | dev 基线→证据支持的一个冻结候选→候选 dev 12/12匹配且工程完整→未调参 holdout 的独立批准顺序；策略通过不冒充质量/成本收益，质量/性能结论另需客观成对 worker 试验及执行前费用门槛 |

RR-01…06 是可独立交付的离线工程增量。RR-07/08 是带停止条件的后续调查，未获授权/证据不足不阻止工程交付，但不能据此称 Jev 或路由质量已修好。真正线上校准/恢复与发布均为后续独立批准事项。

## 8. Astra 复核记录

独立 reviewer：`/root/astra_routing_spec_review`，default review-only、fresh context，`gpt-6-astra/high`；初稿 SHA-256 `bd566ccab3b01ce382ff784dff669b562d2f52e9661c38f9eaa89522326e2fe8`。总评：方向正确，1 项 P1 与 3 项 P2 需修订，不需要扩大生产改造。root 已逐项核对源码后处理：

| 复核项 | 处理 |
| --- | --- |
| P1：末尾冻结/宿主检查与取消提交竞态 | 接受；新增 §5.1，completed+实际正常退出共同判读；exit3 分离完整策略不匹配与 exit1 不完整。静态核对另外发现 host read catch-all 会把异常视为 absent，复用已有有界安全 reader 修一次，不建状态机 |
| P2：不存在的 evidence 1MiB 保证 | 接受；删除错误保证，保持固定记录/白名单，无新增日志计数设施 |
| P2：共享 skill 旧预算 | 接受；只同步 live 段落，保留单一来源/符号链接/元数据 |
| P2：候选缺 dev 推进门槛 | 接受；明确候选 dev 12/12 + 工程完整后才能独立批准 holdout |
| 额外：费用控制必须执行前成立 | 接受；明确费用授权控制门槛与 ChatGPT 次数口径的非账单性质，不造预算平台 |

保留最小 whole-payload JSON.parse、v2 无兼容、固定 corpus/两 suite、有限 completed、生产 routeTask 不动和条件性 Jev 调查；拒绝关键词硬规则/重试/强行补档/观测或实验平台。reviewer 未编辑、测试、启动服务或发网络/模型调用；该静态 review 不证明运行时竞态、Jev 恢复或真实校准通过。
