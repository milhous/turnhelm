# Acceptance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用可离线回归的有限实测入口防止重复付费、证据丢失和敏感输出落盘，同时保留有限生产分类失败信息。

**Architecture:** 先加固现有 systemone→route 的失败契约，再在 test-only 模块实现冻结 prepare、一次性 evidence claim 和顺序 execute。沿用生产 CLI、配置、journal 和 worker；不加通用调度/观测框架，也不为未知根因重写认证、沙箱或路由。

**Tech Stack:** TypeScript strict/NodeNext，实际 Node 24，pnpm 10.12.1，node:test，现有 Node fs/http/child_process API；不新增依赖。

**Spec:** [可信验收与有限失败证据加固规格](../specs/2026-10-10-acceptance-hardening-design.md)

**Review:** 2026-10-11，Astra `gpt-6-astra/high`；只读复核，待用户审阅与实施批准。

## Global Constraints

- 基线 `e240130a3348642a0f9bcad89f0bc025a8edcb6d`，当前 `feat/paid-chain-validation`；复用当前 checkout，不建工作树。不自动实施、commit/push/合并。
- 最低 Node `>=24.0.0`；工程验收用实际 `24.x >=24.5.0`；pnpm `10.12.1`，依赖/锁文件不变。测试每次显式选 Node 24 PATH，不改全局配置。
- 保持配置 v1、六档、默认 10000ms、双后端 Laya 75% 预算、Jev 三重门槛、只读默认；不保留旧 live 参数或 48 次循环。
- 固定上限：laya=`worker 7/Laya 11/Jev 0`；jev=`1/0/1`；dual=`2/2/2`。三套不能自动串跑；每次执行都须另外得到付费/数据接收/合成写授权。
- stdout 64KiB；stderr 总量 1MiB/单行 64KiB；任务≤8192 UTF-8 字节；worker 外层 240 秒，SIGTERM 后最多再等 5 秒；无重试、无并行 worker。
- evidence 目录 0700/文件 0600，manifest/evidence 不在任何 worker root 内。起始快照、保守预留成功 append＋sync 后才能调用；已有 evidence 一律拒绝重跑。
- 不保存 raw stdout/stderr/error/stack/env/headers/body；不读取或修改全局认证/启动内容。宿主配置只记录存在与 hash，不回滚 drift。
- 只交付 AH-01…08 工程；AH-09、NAT/JEV/CAL/META 条件调查不伪造完成。既有 [验收报告](../../validation/2026-10-10-node24-capability-acceptance.md) 保持原文。

## Review Focus

1. 两个 execute 竞争、空 claim 或截断尾记录：最多一个付费执行者，后续拒绝重跑。（Task 2）
2. `/var` 别名、目录替换/symlink/FIFO、源码或输入漂移：同目录通过，其余付费前拒绝。（Task 2/3）
3. 首 receipt 后重复/畸形/超量/secret 字段及失败断言：先保存有限事实，收尾才判唯一；不落盘任意值。（Task 2/3）
4. evidence I/O 失败、信号、240s 或 stdio 不关闭：停止花费，清理仅记录事实、未知仍 unknown。（Task 3）
5. HTTP 收到后解析失败、native code、响应成功后取消/超时：有限 metadata 不丢失、不泄露，优先语义不变。（Task 1）

---

## Phase 0 — 已完成的发现与可用接口

父代理已通过 CodeGraph 读取当前源码；独立 Astra `gpt-6-astra/high` 已提交 API/模式来源、复制位置和已知缺口。下面是本计划允许复用的契约，不是要求增加新产品 API。

| 接口/模式 | 来源与用途 |
| --- | --- |
| `resolveProject(project?: string, cwd?: string): string`；`projectPath(root, relative): string`；`readProjectFile(root, relative, max): Promise<Buffer \| undefined>` | `src/project.ts`；canonical、路径安全和有界常规文件读取；参照 `test/project.test.ts:49–97` 的别名/不同 root/symlink/FIFO 回归 |
| `parseProjectConfig(value: unknown): ProjectConfig`；`readProjectConfig(root): Promise<ProjectConfig>` | `src/config.ts`；严格 schema。生产模板 `assets/config.json`，不发明强制档位参数 |
| `directChoiceRequest(spec: RequestSpec): Promise<unknown>`；`ChoiceRequest=(spec: RequestSpec)=>Promise<unknown>` | `src/systemone.ts`；不改成 Fetch Response/wrapper；传输 fixture 参照 `test/direct-transport.test.ts:103–122,201–292` |
| `routeTask(task, config, {env, signal?, request?}): Promise<RoutingResult>`；`eligibleBackends(config, env): readonly TaskBackend[]` | `src/route.ts`、`src/systemone.ts`；classifier-only 与保守后端预留，复用 `test/fixtures.ts:4–15` 合成 config/reply/env |
| production CLI `run [--project root] [--write] -- task`，stderr `turnhelm.receipt` | `src/cli.ts:134–251`、`test/cli.test.ts:158–232,639–659,676–698`；通过真实 CLI 路径，离线用 `test/executable-fixture.ts:44–54` 的假 executable |
| `appendRouteJournal(root, task, routing, diagnostic?): Promise<void>` | `src/journal.ts`；runner 只核对 CLI 产生的 journal，不替 worker 伪造记录；写失败/路径切换模式 `test/route-journal.test.ts:201–240` |
| `FileHandle.sync(): Promise<void>`；`ChildProcess` 的 `close` | [Node 24.11 fs](https://nodejs.org/download/release/v24.11.0/docs/api/fs.html#filehandlesync)、[child_process](https://nodejs.org/download/release/v24.11.0/docs/api/child_process.html#event-close)；进程级同步与 CLI/stdio 收尾，不是断电或全后代清理证明 |

禁止照搬 `test/cli.test.ts:235–238` 打印完整 stderr 的断言，或将合成 env recorder 改为真实环境 dump。原 `WorkerResult`/receipt 没有 cleanup proof；不新增 cleanup API、原生 observer、恢复服务或测试专用产品 flags。

## Task 1 — 有限生产失败契约（AH-07）

**Files:** Modify `src/systemone.ts`、`src/route.ts`；Test `test/direct-transport.test.ts`、`test/task-routing.test.ts`、`test/cli.test.ts`、`test/route-journal.test.ts`；Regression `test/doctor.test.ts`。

**Interfaces:** 保持 Phase 0 的 request/route 签名。`src/systemone.ts` 导出下述契约，route 与 test-only observer 消费；不新增模块。

```ts
export type ClassifierFailure = Readonly<{
  kind: "request" | "response" | "http" | "invalid-response" | "aborted" | "timeout" | "invalid-choice" | "unknown";
  httpStatus: number | null; // runtime 只接受整数 100…599
  code: "ENOTFOUND" | "EAI_AGAIN" | "ECONNREFUSED" | "ECONNRESET" | "ETIMEDOUT" | "CERT_HAS_EXPIRED" |
    "DEPTH_ZERO_SELF_SIGNED_CERT" | "ERR_TLS_CERT_ALTNAME_INVALID" | "UNABLE_TO_VERIFY_LEAF_SIGNATURE" | null;
}>;
export class ClassifierRequestError extends Error {
  readonly failure: ClassifierFailure;
  constructor(failure: ClassifierFailure);
}
export function classifierFailure(error: unknown): ClassifierFailure;
```

`TaskAttempt` 改为 discriminated union：success 不带 failure；failed/timeout/cancelled 必须带 failure。`classifierFailure` 仅从本地 typed error 重建白名单冻结投影；其他异常返回 unknown/null/null。native code 仅在传输捕获边界提取，不解析 message/cause/URL。

- [ ] **1. RED：** 增加 `retains bounded classifier failure without secrets`（HTTP451→kind=http/status451；HTTP200 后坏 JSON/UTF-8/截断→invalid-response/status200；请求 ENOTFOUND→request/null/ENOTFOUND；未知 code→null），及 `late cancellation and deadline override a successful reply`（cancel→aborted、deadline→timeout；success 无 failure）。断言冻结投影不包含 synthetic secret/cause/native stack；invalid-choice 允许 status=null。
- [ ] **2. 确认 RED：** `pnpm run build && node --test dist/test/direct-transport.test.js dist/test/task-routing.test.js`；应因缺少 typed failure 或正确 priority 断言 FAIL，不接受测试 guard 假造 timeout 或 skipped。
- [ ] **3. GREEN：** 在现有 direct 的所有 fail 分支生成固定消息 typed error；HTTP 已观察 status 保留，request/response error 仅提取有限 code。`requestTaskChoice` 的选择校验失败用 invalid-choice；route catch 和成功后 cancel/deadline 分支同步 failure，不改总预算/顺序/取消无回退。
- [ ] **4. 端到端回归：** 在 CLI/journal fixtures 增加 `receipt and journal retain only finite failure fields`；assert receipt 与 journal attempts 一致，canary 不出现；doctor schema/probe 行为原样。运行 `pnpm run build && node --test dist/test/direct-transport.test.js dist/test/task-routing.test.js dist/test/cli.test.js dist/test/route-journal.test.js dist/test/doctor.test.js`，全 PASS，TLS/代理/8KiB/零重试旧断言不放宽。
- [ ] **5. Review gate：** 审查所有 TaskAttempt 创建/消费和错误出口；不因 status=null 猜网络阶段/账号/地域，不扩医生 schema。确认本任务可独立交付再进 Task 2。

## Task 2 — 固定 corpus、冻结 manifest 与一次性证据（AH-01…04）

**Files:** Create `test/fixtures/live-acceptance.json`、`test/live-acceptance.ts`、`test/live-acceptance.test.ts`。不修改生产配置、worker 或 project 安全实现。

**Interfaces:** 在 test-only 模块导出以下接口；Task 3 同模块实现 execute，入口只消费 prepare/execute。类型只表示固定 v1，不构造任意任务/oracle DSL。

```ts
export type LiveSuite = "laya" | "jev" | "dual";
export function prepareAcceptance(suite: LiveSuite): Promise<{manifestPath: string; sha256: string}>;
export function claimAcceptance(manifestPath: string, approvedSha256: string): Promise<ClaimedRun>;
export function appendEvidence(run: ClaimedRun, record: SafeEvidence): Promise<void>;
```

`ClaimedRun` 是固定 manifest 和已独占打开的 `FileHandle`，不注入 scheduler/writer/plugin。`SafeEvidence` 是 spec 的 prepared/reserved/observed/verified/stopped 有限记录 union；关闭由持有 handle 的 execute `finally` 负责。未知 run 以 incomplete 阅读，不提供 resume API。

manifest 固定键组：`version=1`、`suite`、`baseline`（HEAD/source/dist/corpus hashes、工具版本/可执行身份）、`runRoot`（canonical/dev/ino）、`hostSnapshot`（exists/hash）、`caps`、`cases`。每例固定 `id/kind/root/identity/task/taskHash/taskBytes/config/inputHashes/allowedChanges/oracle/reservation`；关键路径和记录类型均严格已知键。不保存 env/密钥，不允许自定义 oracle/task。source/dist 只哈希受 scope 管理的实际执行文件，不建仓库通用扫描平台。固定 worker fixture 为 `input.json={"values":[2,3,5,7]}`，只读任务仅输出 `{"count":4,"sum":17}`，写任务仅向 `out/summary.json` 写同一 JSON；父 oracle 独立读取输入计算并核对。四 classifier-only 固定为中英各一项局部修改与一项多步调查，只验合法 profile，不预设标签。

- [ ] **1. RED：** 新测试 `prepare is offline and freezes independent consumers`；assert laya 7 CLI root 不同、四 classifier-only 无 worker、六组合来自现行模板、每任务≤8192B、manifest/corpus/hash 完整；拦截 classifier/spawn inference，计数均 0。prepare 可做 Git/init 和非推理工具版本检查，不运行 doctor probe/安装/服务。
- [ ] **2. 确认 RED：** 先创建最小可编译的接口声明/测试 fixture，`pnpm run build && node --test dist/test/live-acceptance.test.js` 因上述断言 FAIL；接口声明不能预先实现行为。
- [ ] **3. GREEN prepare：** 直接复制现有模板/init 合成消费者模式，每 CLI 例独立配置/AGENTS/Git/fixture/journal；六绑定用 `parseProjectConfig` 把六 ID 均设为该合法 pair。默认/双后端例保留原六绑定。suite 只配置该套件的后端；Jev enabled=true 是人工审阅批准 manifest 中明示的合成配置选择，不另要求宿主业务项目启用，prepare 不构成托管授权。Jev opt-in/key 仍由现有 env 提供，不自行设置；不读业务任务。所有文件在新建私有 owned run 下，manifest/evidence 与消费者隔离。
- [ ] **4. RED→GREEN claim：** 增加 `aliases match but replaced or unsafe roots fail`、`only one concurrent execute can claim`、`empty or truncated evidence is never replayed`、`drift rejects before requests`。assert canonical 别名同 dev/ino 通过，不同/业务/替换/symlink/FIFO/hash漂移失败；两个 claim 恰一成功；已有空/失败/坏尾均零调用。实现 approved hash/严格 manifest/corpus验证、目录身份/有限读取以及固定 evidence `O_WRONLY|O_CREAT|O_EXCL|O_APPEND|O_NOFOLLOW|O_NONBLOCK`（0600）＋同 FD fstat 常规文件检查。
- [ ] **5. RED→GREEN evidence：** 增加 `reservation sync precedes a call`、`safe observation survives a failing oracle`、`unknown receipt fields never reach evidence`；assert 起始 host 快照和 reservation sync 的完成先于 call，失败判定后 observed 仍在；未知 root/model/path/canary 只留有限 invalid/unknown 标记。用 fs 错误注入证明 append/sync 失败不进入调用，不新增生产 test seam；所有阶段 append 后 sync，stdout 不落盘；append 串行且 stream 暂停/恢复等待持久化，不开无界写队列。
- [ ] **6. Gate：** 重跑 `pnpm run build && node --test dist/test/live-acceptance.test.js dist/test/project.test.js` 全 PASS。审查权限与 record keys、并发单次 claim、prepare 0 inference；保留现行 projectPath 安全边界。

## Task 3 — 有限顺序执行与新 live 入口（AH-01、03…06）

**Files:** Modify `test/live-acceptance.ts`、`test/live.integration.ts`、`package.json`；Test `test/live-acceptance.test.ts`。共享 Task 2 文件由同一串行 owner 交接，禁止并发改写。

**Interfaces:** 消费 Task 2 的 prepare/claim/append 与 Task 1 failure；新增 `executeAcceptance(manifestPath: string, approvedSha256: string): Promise<number>`。entry 只做严格参数解析、有限错误/路径/hash输出和 exitCode；非法输入 exit2，执行失败/incomplete exit1，完整通过 exit0，信号按 130/143。

- [ ] **1. RED：** `entry refuses absent approval and unknown args`、`suite counts are reserved before each attempt`、`first real failure stops remaining cases`。用仅 synthetic env 的 fake executable 和本地 HTTP fixture，assert 无参/缺 hash/未知 suite/hash/参数零调用；reservation 分开于 actual，缺 receipt 仍保留预留；suite完整门槛缺失零调用（laya=[laya]、jev=[jev]、dual=[laya,jev]）；单 worker、计数≤固定 caps，第一失败后其余未执行。每个案例前重新核对 source/tool/input/config/identity/expected eligible set，drift 停止，不静默降级。
- [ ] **2. 确认 RED：** `pnpm run build && node --test dist/test/live-acceptance.test.js`；必须由缺 execute/计数/止损行为 FAIL，不能使用真实 Codex/Laya/Jev。假工具走现有 PATH/executable fixture，classifier-only 的离线 reply 使用生产 request seam 或 owned 本地 fixture，不新增产品接口。
- [ ] **3. GREEN 执行：** 先验证 suite 完整 expected eligible set，再 claim 和 synced 起始快照；dual 先完成第4步准确端口绑定，随后逐例 reserve/sync。CLI 例用当前 Node＋`dist/src/cli.js run --project <frozen-root> [--write] -- <frozen-task>`；classifier-only 一次生产 routeTask，无 CLI/worker/journal/receipt。不先额外调用 classifier/health。保守每 CLI 预留一 worker 和全部 eligible backend；实际从合法 receipt/route result 得到，绝不从退出码猜零消费。
- [ ] **4. 冻结 dual fixture：** prepare 离线选一个高位 loopback port 并冻结仅第二例 config；execute 在 claim 后、第一笔付费调用前绑定准确 `127.0.0.1:port`；冲突零付费停止，不重选/改 config。fixture 固定返回503，不保存 request 头/体；只用该例 env 副本删除 `LAYA_API_KEY`，不改全局 env/Jev 三门槛，finally 关闭 owned fixture。真实 Laya 成功的第一例若 Jev 被调用不算目标成功。
- [ ] **5. RED→GREEN 观察：** `duplicate receipt after observation cannot pass`、`malformed missing oversized and invalid UTF8 outputs are finite`、`worker and classifier-only have different pass criteria`；assert 首 safe receipt 立即 synced observed，随后 duplicate/坏帧追加失败、EOF 才唯一；stdout64KiB/stderr1MiB/line64KiB 外立即取消。严格白名单投影 rootMatches、冻结 selection、有限 attempts/usage/numbers；原文只在有界内存，fs/console/error assertions 无 canary。classifier-only 只检合法 profile/backend/attempt，无假 receipt或准确率断言。
- [ ] **6. RED→GREEN 独立 oracle：** `read and synthetic write require independent facts`；只读 fixture/hash/git差异不变，仅允许父 journal；写只允许 `out/summary.json`，用安全读取校验固定 JSON 的数字/内容。receipt unique/exit0/completed/pair/root/task/新 journal 恰一条均独立核对；stdout oracle 用固定 JSON，不信任 worker 自称 success。把单个 oracle 暂改为总 true，负例必须失败，复原后全 PASS；陌生路径只存 unexpected-path，不记录原名。
- [ ] **7. RED→GREEN 取消与 I/O：** `signal timeout or evidence failure stops spending`、`CLI close does not prove descendant cleanup`；用 node:test mock timer/owned child fixture 离线触发240s、SIGINT/TERM、5s不close、sync中途失败。assert TERM仅到owned CLI、记录实际 termSent/cliClosed/exit，异常清理unknown、无下一例/重试；I/O失效的 stopped 可缺失但已同步 reservation 保留。不能扫杀未知进程、把 CLI close 写成全组 proof，或加入产品 timeout/test flag。
- [ ] **8. Entry cutover：** `test:live` 精确改为 `pnpm run build && node dist/test/live.integration.js`；支持 spec 两种 grammar，不兼容旧环境/循环。用 spawn argv 测 pnpm 的 `--` 是否保留，entry 只容许命令转发形成的一个分隔符，不松绑未知参数。`*.test.js` 默认仍排除真正 live entry、包含新增离线测试。聚焦测试全 PASS，prepare 通过假 env/inference trap 自证 0 paid。
- [ ] **9. Review gate：** 核对 mixed-case PASS、按 EOF/close 判定、snapshot终点、逐例 monotonic 时间和 no-replay/stop。禁止小样本 p95/SLO/实际金额推断，禁止出现新的生产 fsync 热路径。

## Task 4 — 文档/skill、打包及工程验收（AH-08）

**Files:** Modify `README.md`、`.agents/skills/turnhelm-routing/SKILL.md`；仅确有元数据字段变化才改 `.agents/skills/turnhelm-routing/agents/openai.yaml`；Test `test/package.test.ts`。Create 实施日 `docs/validation/YYYY-MM-DD-acceptance-hardening.md`，不得改旧验收报告。

**Interfaces:** 文档沿用新 `test:live` grammar、固定 caps、failure/null 字段和现有 routing/worker 契约；不增加启动器/配置入口。

- [ ] **1. Pack 回归：** 在 `test/package.test.ts` 的既有 forbidden-prefix 断言补齐新 runner/corpus/evidence 的明确断言：pack 不含这些路径，既有配置/skill/元数据仍在。此处当前 allowlist 已正确，新增负例用合成错误 entries 证明断言会拒绝，真实 pack 正例通过；不为制造 RED 修改发布配置，不新增 pack 工具/重复测试。
- [ ] **2. 文档：** 实施时读 skill-creator，更新 README/shared skill：prepare零付费、人工读完整 manifest/授权后 execute、不可重放、分套额度、原文不落盘、unknown/有限失败、取消清理限制。删除当前旧48次/p95验收说明；历史日期记录不改、不改 production run 使用方法。
- [ ] **3. 新证据与最终离线门：** 先审 diff/命令范围。实际 Node24 PATH 下依次 `pnpm test`、`pnpm run test:coverage`、`pnpm audit`，记录真实版本/exit/总数/失败取消跳过/coverage；默认并行，line/branch/function 每项≥80%，audit成功。这些命令不启动 live、服务、worker；失败先定位，不把并行改为串行来隐藏失败。
- [ ] **4. 独立 review：** 检查 TaskAttempt全部创建者/消费者、claim与观测投影、reservation顺序、fixture key删除、strict manifest、取消归属和 pack。用故障敏感离线负例证明 AH-01…08，原始日志不进报告；本轮无需真实调用来判工程合格。只在另行批准时 commit/push；没有授权就交付未提交 diff。

## Task 5 — 条件性有限能力验证（AH-09，不自动执行）

**Files:** 仅更新新工程验收记录；不改冻结旧报告、全局配置或业务项目。

- [ ] 工程门槛通过后，请用户审阅 manifest 全文并重新授权单一 suite 的 worker/backend/托管数据/合成写范围。当前旧 round 的剩余原总量最多7 worker/11 Laya、Jev0，不自动延续；独立新 suite 额度不得与旧8worker混算。
- [ ] 若只批准 Laya，执行一次 laya suite；停止后绝不重用 manifest、自动重跑或执行 Jev/dual。新需求要新 prepare/hash/人工授权；失败 reservation 仍入总量。Jev 首个失败停止其链路，不为获取诊断多加 probe。
- [ ] 逐例记录 PASS/FAIL/BLOCKED/UNVERIFIED/未执行、reserved/actual和逐例耗时，区分真实后端与注入503。worker准入不等于自然六档能力，四 classifier-only 不等于准确率；usage不是账单，外层close不是原生策略/全后代 proof。
- [ ] NAT：仅在获得可信工具/shell/有效策略来源的可支持只读接口及单独诊断授权后做因果调查；没有就 BLOCKED，不先写 native observer 或全局 auth 修复。
- [ ] JEV：新授权的一次有限失败/status/code 是观测，不足以归因 DNS/TLS/地域/账号；有供应商证据和独立成功链才讨论恢复。固定 request error 或 null status 不算451。
- [ ] CAL：另行设计同输入 baseline/candidate、独立 run/机器oracle、开发/留出与完整失败样本，取得可归属账单后才给成本结论；本计划不建 benchmark/估算器。META：只用已支持的项目作用域接口，无接口保持BLOCKED，禁止直接改数据库。

## 验收追踪与实施交接

| Criterion | Owner / check |
| --- | --- |
| AH-01 | Task2 freeze/claim + Task3 strict entry/drift/prepare零付费 |
| AH-02 | Task2 canonical/identity/安全文件 + Task3 每例复核；原生产路径回归 |
| AH-03 | Task2 sync/reservation/safe facts + Task3 I/O/incomplete/无重试 |
| AH-04 | Task2有限schema + Task3 stream/duplicate/secret负例 |
| AH-05 | Task3固定caps/顺序/失败止损/信号超时归属与unknown |
| AH-06 | Task3独立读写oracle/receipt/journal/config/hash/总true负例 |
| AH-07 | Task1 typed failure/direct/TLS/预算取消/receipt/journal回归 |
| AH-08 | Task4 skill-creator/docs/pack/实际Node24并行tests/coverage/audit |
| AH-09 | Task5另外授权的单套有限实测；未授权仍未验证 |

父代理自检：所有 spec 条件有 owning task；四工程任务串行，每项先故障敏感 RED 再 GREEN，再 review。没有额外库、永久服务、锁文件、任意任务/恢复/批量实测或新的生产测试 flags。推荐实施采用 subagent-driven，四个任务分别交付并独立复核安全与并发边界；执行前仍须用户审阅并选择/确认实施方式。
