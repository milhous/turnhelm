# 可信验收与有限失败证据加固规格

日期：2026-10-10；复核更新：2026-10-11；基线：`e240130a3348642a0f9bcad89f0bc025a8edcb6d`。

> 状态：已按 Astra（`gpt-6-astra/high`）独立复核意见修订，待用户审阅与实施批准。用户授权本轮编写 spec、Astra 复核、修订和执行计划；不等于实施、真实调用或发布授权。

## 1. 目标与证据

基于 [本轮验收报告](../../validation/2026-10-10-node24-capability-acceptance.md)，优先长期可维护性、安全和性能，不考虑向后兼容。把昂贵实测从临时脚本变为一个可离线验证、有限执行、不会因验收断言丢失已观察事实的仓库内入口；在已有分类器边界保留安全、有限的失败信息。

**已证明：** Node 24 工程门槛通过；Laya 一次分类成功 3715ms；私有脚本错误比较 `/var` 与 `/private/var` 导致首个 worker 证据丢失。生产 `resolveProject` 的 `realpathSync` 正确，不修产品路径行为。

**未证明：** 该 worker 成功/失败、六组模型准入、完整双后端、Jev 当前 HTTP 状态/根因、后代环境/有效策略来源、一般路由质量或成本收益。Jev 本轮固定请求错误不能描述为再次 451。不能因“没有向后兼容要求”删除安全门槛或宣称未知问题已解决。

Node 24 已完成，不重做迁移；现行最低版本保持 `>=24.0.0`，必需验收实际 `24.x >=24.5.0`；pnpm `10.12.1` 和现有依赖/锁文件不变。

## 2. 方案比较与推荐

| 方案 | 长期收益/代价 | 决定 |
| --- | --- | --- |
| A：替换旧 live 实测入口，仓库内最小顺序 runner＋先保留事实再判定＋有限类型化失败 | 防止已知重复付费和证据遗失；失败信息复用生产边界；少量 test-only 代码，不加正常 worker 热路径 I/O | **推荐** |
| B：仅修临时脚本的一行路径比较 | 当前别名可通过，但断言/崩溃仍会丢结果、预算和宿主快照；不能稳定复用 | 不采用 |
| C：统一调度/观测平台、原生 shell 隔离改造、并行分类、缓存/自适应预算和自动重试 | 原因未证明，权限与数据面扩大；增加付费、时延归因和维护复杂度 | 不采用 |

只有确定的工程加固现在可实施；原生安全、供应商归因和对照收益是独立、条件性调查，不伪装成同一大重构。

## 3. 范围及非目标

工程只覆盖：
1. `test/live.integration.ts` 改成显式 prepare/execute 入口，替换四轮×六样例×双后端的 48 次旧循环，不保留旧参数/环境变量兼容层。
2. 一个 test-only `test/live-acceptance.ts` 辅助模块及 `test/live-acceptance.test.ts` 离线回归；冻结的少量非敏感任务放在 `test/fixtures/live-acceptance.json`，不支持任意任务/插件/oracle DSL。
3. `src/systemone.ts` 中有限类型化失败，`src/route.ts` 将其投影到失败 attempt；receipt/journal 沿用既有 attempts，不新增 observer 总线。
4. `package.json` 旧 `test:live` 调用方式及 README/shared skill 必要同步；现行生产 `init/doctor/run`、配置 v1、六档、10 秒预算、Laya 75% 分配、Jev 三重门槛和只读默认不变。

不新增数据库、web 面板、SDK、通用 runner、任意项目写入、自动恢复/重试、模型切换、强制档位、全局 shell/HOME/认证/代理修改、环境 dump、账单估算器或永久服务。旧日期证据和封存记录不迁移/重写。跨项目历史元数据不直接编辑数据库；没有正确作用域接口就继续受阻。

## 4. 唯一有限实测入口

保留命令名但不兼容旧行为：

```bash
pnpm run test:live -- --prepare laya
pnpm run test:live -- --execute /absolute/private/run/manifest.json --approve <manifest-sha256>
```

`--prepare` 的 suite 只允许 `laya|jev|dual`，无参数/未知参数拒绝。prepare 仅创建归属明确的全新私有临时消费者、Git/init 文件和冻结 manifest，做离线预检；零分类、零 worker、零健康探针、零安装/服务启动。输出仅 manifest 路径与 hash。**每个 CLI 案例独立 consumer root、配置、指令和 journal，execute 不改冻结配置，不轮换同一项目配置。** manifest/evidence 在所有 consumer root 外，不在 worker 的批准写范围。

execute 要求显式 manifest 和完全相同的批准 hash；这只是内容完整性检查，**不是替代用户的付费/托管/写入授权**。仍要求冻结合成配置及 Jev 三重门槛；suite 所需 eligible 集合必须在第一笔付费前完整满足：laya=[laya]、jev=[jev]、dual=[laya,jev]，否则零调用拒绝，不把 dual 静默降级。Jev enabled=true 是拟配置中明示、由操作者批准的该次选择，不另要求宿主业务配置启用；prepare 不等于托管授权。不从用户业务项目读取任务，不自行设置 hosted opt-in，不自动启动 Laya。操作者批准前必须读取生成的 manifest，审阅完整任务、写路径、配置、数据接收方、scope、顺序与最大调用次数；示例命令的 hash 不能替代这一步人工审阅。

manifest 固定 v1、严格已知键、任务来自固定 corpus、UTF-8 全文不超过 8192 字节；保存 HEAD＋实际源/编译入口及 corpus 内容 hash、实际工具链、各任务 hash/字节数、配置、案例顺序、允许变化、oracle、预算、canonical root 与目录身份、宿主配置存在及 hash-only 起始快照。不得包含密钥值、完整环境或认证/启动文件内容。

只执行 prepare 创建的合成消费者；execute 复查目录身份、无 symlink/FIFO 的关键路径、冻结输入/配置/指令 hash。拒绝修改既有 evidence、外部/不一致项目和修改过的 manifest/corpus；同一 run 不支持第二次 execute 或 resume。prepare 只写 manifest，execute 才对固定 `evidence.jsonl` 以 `O_WRONLY|O_CREAT|O_EXCL|O_APPEND|O_NOFOLLOW|O_NONBLOCK`（0600）独占创建并同 FD fstat，该文件本身是一次性 claim；不另建锁服务/文件。并发执行只能一方取得 claim；已有空文件、失败、incomplete 或损坏尾记录都拒绝再次执行。父目录和同 UID 宿主仍属信任边界，不宣称对抗所有宿主篡改。

### 固定套件和作用域

| suite | 冻结用例 | 上限 |
| --- | --- | --- |
| laya | 六组合法组合统一绑定的准入 worker（其中一项仅写合成 `out/summary.json`）；一次默认绑定自然只读 worker；四项中英自然 classifier-only | worker 7，Laya 11，Jev 0 |
| jev | Jev 单后端默认绑定只读真实 CLI 链路，不先做付费 probe | worker 1，Jev 1，Laya 0 |
| dual | 一次真实 Laya 优先、Jev 未被调用的条件性链路；一次归属明确的本地 HTTP503 fixture→真实 Jev 的限定合成写链路 | worker 2，Laya 2，Jev 2（保守预留） |

控制绑定通过已有 schema 将六个 ID 绑定同一合法组合，仍走生产 CLI；不声称观察了六档自然选择。dual 的 HTTP503 是故障注入，不是实际 Laya 故障；仅此 fixture 案例的 CLI env 使用副本并删除 `LAYA_API_KEY`，因为生产请求会自动添加该 key；不改全局 env，Jev 三重门槛不变。fixture 不存请求头/体。prepare 不开 server：离线选定高位 loopback port 并冻结第二例配置；execute 在取得 claim 后、第一笔付费前绑定准确 `127.0.0.1:port`，冲突零付费停止，不重选端口/改配置；结束关闭此 owned fixture。Laya 成功未调用 Jev 只依据该案例 actual attempts，不能把自然失败后回退到 Jev 算成 Laya 优先成功。

三个套件是独立人工授权范围，合计最大 10 个 worker，不是一次原 8 个 worker 的补验，也不串行自动运行三套。套件预算是客户端上限，不是账单或服务端上限；此前授权额度不自动延续。当前补验如另行批准，只能用剩余原总量 7 worker/11 Laya、Jev 0；其他套件需要新授权。

## 5. 安全持久化先于判定

复用 `resolveProject` 得到 canonical root；同目录 `/var` 与 `/private/var` 等别名接受，真正不同项目拒绝；不放宽生产 `projectPath` 的 symlink 边界。

evidence 放在新建 0700 私有目录、0600 文件。一个 append-only `evidence.jsonl` 使用独占、安全打开、同 FD 常规文件检查；只在有限阶段 append＋`FileHandle.sync()`，不逐 token/工具事件同步。启动记录和每次调用的**保守预留**必须先成功 append/sync，随后才启动真实请求/CLI。只承诺已成功同步的进程级证据；不承诺断电/设备故障/同 UID 篡改后的完整目录持久性。无此能力时拒绝付费执行。

阶段固定：`prepared → reserved → observed → verified`；失败时尽力记录 `stopped`，退出/无完整记录保留 `incomplete`。写盘失败时不保证还能写 stopped，先取消并停止花费。它是单次实验日志，不实现工作流引擎。首个完整 receipt 经类型/有限值投影即写 observed；唯一性仅在流收尾确认，随后才判定 PASS。后来发现重复/畸形 receipt 就追加有限失败事实，绝不删除 observed 或判通过。root、journal、质量及文件变化不匹配也只追加判定，不丢事实。若 receipt 缺失/无效，保存固定类别、退出观测、字节计数和 unknown 字段，不保存原始内容。

预算将 reserved 与 observed 次数分开：每个 CLI 预留至多一 worker 和所有 eligible backend；用有效 receipt 确认 actual attempts，但缺失 receipt 保留预留、绝不当作零消费。进程崩溃和没有终端证据的记录只能标为 incomplete，不自动补跑。

stdout 只在内存保留最多 64KiB，stderr 总量最多 1MiB、单行最多 64KiB；UTF-8 fatal 解码。超过边界则取消本次 owned CLI、记录固定 output-limit、停止本实验。安全 evidence 只存冻结值、有限枚举、受界数字及 unknown；未匹配的 receipt.root/model/profile/错误不能复制。root 只记录冻结 canonical root 与 `rootMatches` 布尔/unknown，selection 只记录已匹配冻结配置的值或 selection-invalid。另可存允许名单下的 attempt/usage 数字、oracle 布尔值、已批准相对路径的文件 hash/变化、退出与信号/close 事实；未知新路径只记录 unexpected-path，不存任意原始名称。不落盘 stdout/原始 stderr、模型自然语言、命令输出、任务之外的任意字段、原始错误/堆栈/headers/body/env。

任一观察/质量/worker/真实后端失败停止对应套件，保留失败和全部未执行案例；注入的 HTTP503 是 dual 声明的预期故障，不触发同套件的误停止。两组相邻案例之间不启动并行 worker。

超时固定 240 秒；向归属明确 CLI 发 SIGTERM，沿用生产 CLI 的 owned-worker 清理，等待最多额外 5 秒。记录 `termSent`、`cliClosed`、exitCode 等实际事实。现有 receipt/WorkerResult 没有 cleanup proof，CLI close 只证明 CLI/stdio 关闭，不能当作所有后代消失；超时取消、stdio/close 异常的全组清理保守 unknown，不扫描/杀未知进程，也不为 runner 扩生产清理 API。收不到 close 则停止整轮并报 cleanup-unverified。外部 SIGKILL/系统崩溃不承诺零孤儿，未确认清理不得继续花费。evidence I/O 运行中失败亦停止并取消 owned CLI，不把验证失败冒充业务失败。

## 6. 有限分类器失败投影

保持 `directChoiceRequest(spec): Promise<unknown>` 和 `ChoiceRequest` 参数不变。在 `src/systemone.ts` 内定义 `ClassifierRequestError`，携带冻结的 `ClassifierFailure`；消息仍固定，不保留 native error 的 cause/message/stack。

`ClassifierFailure` 只含：
- `kind`: `request|response|http|invalid-response|aborted|timeout|invalid-choice|unknown`。
- `httpStatus`: 已从 `IncomingMessage.statusCode` 观察到的合法 100…599，其他为 `null`；status 0 不算 HTTP 响应。
- `code`: 仅允许 `ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID|UNABLE_TO_VERIFY_LEAF_SIGNATURE`，其他 `null`。

code 是观察到的有限 Node 代码，不是法律/地域/账号/有效策略或完整失败阶段归因；可缺失。非类型化任意异常、非 Error、带 secret 的字符串全部投影 unknown/null；原生 error 的不在白名单 code 记 null，不解析旧错误消息、host/address/path/syscall、URL 或 headers。transport 内 HTTP 接收后解析/读取失败可保留实际已观察 status，不因失败变 null，也不宣称推理/计费完成。成功 direct 返回只含解码后的 unknown，不携带 HTTP metadata，因此后续 `validateChoice` 的 invalid-choice 允许 `httpStatus:null`；不为补此值新增 wrapper/WeakMap/observer。null 表示未报告，不证明没有响应。

`TaskAttempt` outcome=success 不含 failure；failed/timeout/cancelled 含固定 failure。caller cancel 对应 aborted，deadline 对应 timeout，优先于同时到达的传输错误；请求成功后才发现超时/取消的分支也生成对应 failure、status/code 可为 null。其他失败从 typed error 得有限投影，非类型化异常为 unknown。`routeTask` 保持 deadline/cancel 优先语义；不借 native code 猜测。无 observer、无网络 timing hook、无额外请求。doctor 继续已有固定 probe 输出，本期不增医生诊断 schema。

边界相关依据：[Node 24.11 Error.code](https://nodejs.org/download/release/v24.11.0/docs/api/errors.html#errorcode)、[系统错误](https://nodejs.org/download/release/v24.11.0/docs/api/errors.html#common-system-errors)、[FileHandle.sync](https://nodejs.org/download/release/v24.11.0/docs/api/fs.html#filehandlesync)。白名单不是所有错误的穷举，未覆盖代码仍 unknown。

## 7. 判定、安全及性能验证

**worker PASS** 必须同时具有：唯一匹配的 production receipt、CLI exit 0、worker completed、冻结 model/effort 与项目匹配、独立机器 oracle 全通过、journal 恰有该独立项目的一条新记录且 task hash/字节数/attempt 与 receipt 一致、仅允许路径变化；CLI routing selected/journal 成功不能代替 worker 成功。

**classifier-only PASS**：一次生产 `routeTask` 返回 selected、合法六档及冻结 backend/attempts/任务/config 匹配、有限 observed/判定证据成功保存。worker、CLI exit、receipt、journal 不适用，不伪造生产 receipt。这里只验证合法输出，不声明分类语义准确率。

只读允许父进程 journal，不允许 worker 改 fixture。写入仅允许声明的合成输出，按现有安全文件读取边界校验；外部/全局任意写入不在授权内。起始宿主存在/hash-only 快照要在调用前持久化；execute 及每例调用前复查冻结源/工具/输入/配置，drift 停止并要求新 prepare/批准。结束宿主 hash 再比；drift 记为宿主变化，不回滚、不猜谁写。缺少结束证据仍 unknown。

各案例保存 routingMs、workerMs、wholeRunMs，分清生产 receipt 耗时和外层准备/观测开销；用 monotonic 时间测时。小样本只给逐例时延，不发表 4 个样例的 p95/SLO 或吞吐结论。不因 3715ms 单样本调整 Laya 预算，不添加缓存、并行分类或预热探针。正常 CLI 不增加 evidence fsync 热路径，失败 metadata 大小恒定。

成本/一般质量：固定样本准入和 oracle 不等于最轻充分档位、准确率或节省。对照收益单列后续调查：冻结 baseline/candidate、同输入 oracle、独立 run、开发/留出分割、完整失败样本、可归属账单。没有可信金额或内部重试证据时，只有调用上限，不报实际金额/降本比例。本工程不内置账单估算或泛化 benchmark。

原生安全：继续初始剥离/marker 契约。后代 key presence/marker discrepancy 只有可信工具、shell、有效策略来源和因果验证才能关闭；本期不凭完成 worker 推导 shell 安全。先做可支持接口的 read-only 发现，找不到就受阻，不建通用 native observer 或修改全局认证以“修绿”。

## 8. 验收门槛与独立交付

| ID | 证据 |
| --- | --- |
| AH-01 | 新入口默认/非法参数/无批准 hash、suite 所需完整后端门槛缺失、已执行 run、manifest/corpus/目录身份 drift 全部在真实调用前拒绝；prepare 零请求/worker |
| AH-02 | canonical 同目录别名通过、不同项目失败；业务 root/symlink/FIFO/变化输入拒绝；不改变生产路径语义 |
| AH-03 | 启动快照与保守预留先 durable；receipt 安全 observed 先于失败断言；损坏尾记录/写盘故障/incomplete 不被算零或自动恢复 |
| AH-04 | 缺失/重复/畸形/oversized/UTF-8/secret canary 输出和原始 transport 异常只留下有限类别；stdout/stderr/任意值不落盘 |
| AH-05 | 计数不超 fixed suite；无重复执行/自动重试/并行 worker；失败保留并停止，后续未执行；SIGINT/SIGTERM/240s/不关闭/证据 I/O 失败的归属取消和清理 unknown 均有离线敏感回归 |
| AH-06 | 同一 oracle 独立检查读/写、限定路径/差异、精确 receipt/journal/task/config；被改为总成功的错误实现能触发回归 |
| AH-07 | 原生失败投影类型、HTTP status/null、有限 code/unknown、deadline/cancel、direct/TLS/8KiB/无重试敏感回归通过；receipt/journal 不泄露 raw error |
| AH-08 | 文档/共享 skill/pack/默认离线 suite 与新 live 入口一致；旧 48 次循环及兼容分支删除；实际 Node 24 默认并行 test/coverage、各总覆盖率≥80%、audit 成功；不执行真实链路代替离线门槛 |
| AH-09 | 另行授权后才执行固定套件，失败停止；按逐案例 PASS/FAIL/BLOCKED/UNVERIFIED/未执行报告，真实/注入/离线分开；缺乏证据不关闭六档/dual/NAT/JEV/CAL/META |

AH-01…08 是工程完成定义；AH-09 是另行批准的有限能力验证，不阻止工程独立交付，也不能免除当前未验证场景。native 原因、Jev 恢复和质量/成本仍依原 [Node 24 规格](2026-10-10-node24-unresolved-remediation-design.md) 的 NAT/JEV/CAL/META 证据门槛，不以写报告关闭。

## 9. 执行次序及可回滚边界

1. 有限生产失败契约及已有传输/路由/receipt/journal回归先落定；不改 deadline 和后台顺序。
2. test-only canonical/每例独立冻结 manifest/先保留事实/独占 claim 回归与 helper。
3. runner 顺序/计数/stream bounds/取消与离线整链路 fixtures，替换旧 live 行为。
4. skill-creator 更新必要 skill/docs、pack/默认 Node24/offline/audit 验收和独立 review。
5. 用户审阅实施结果、授权新的有限套件；先 Laya，Jev/dual 仍按外部证据和新授权门槛。

每步必须有故障敏感 RED/GREEN，不新建工作树；不自动 commit/push/合并。工程回滚用恢复本次局部代码的普通提交（另行批准），不改旧证据、宿主环境或历史数据。没有向后兼容，不代表需要升级所有依赖/改变现行 profiles/配置版本。

## 10. Astra 复核处置

独立只读 agent：`/root/astra_acceptance_spec_review`，`gpt-6-astra/high`。父代理核对 source 后采纳四项阻塞修订：区分两种 PASS、每 CLI 例独立 root、execute 独占 evidence claim、有限 observed-first 与终端唯一性。

同步采纳：sync 的进程级保证；unknown root/model/path 不落盘；invalid-choice status 可 null；取消后成功分支的 failure；cleanup 仅记录信号/close 事实；dual 合成写的案例 env 删除 Laya key；批准前实际读 manifest；三套总量不混进原授权；生产 failure 先于 runner。最终计划复核另补齐 evidence 完整创建 flags、dual 完整 eligible 集合的零调用拒绝、fixture 付费前绑定与合成 Jev 配置的批准语义。

未扩大范围：旧 `test/cli.test.ts` 的 env recorder 当前仅接收最小合成 env，不列为新生产漏洞；其打印完整 stderr 的 `parseReceipt` 仅供结构参考，禁止复用到真实 observer。原生安全/供应商/账单/META 未新增证据，继续条件门槛。没有引入恢复器、锁服务、worker cleanup API、transport wrapper 或原生 observer。
