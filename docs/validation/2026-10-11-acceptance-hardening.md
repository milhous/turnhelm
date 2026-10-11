# 验收加固（AH-01…08）工程验收

日期：2026-10-11（UTC+8）；代码快照：基于 `e240130a3348642a0f9bcad89f0bc025a8edcb6d` 的未提交工作区；分支：`feat/paid-chain-validation`；计划：`docs/superpowers/plans/2026-10-10-acceptance-hardening.md`。

## 结论

- **PASS：AH-01…08 工程项。** 有限顺序执行 harness（prepare/claim/evidence/execute）、严格 live 入口、类型化失败契约、pack/文档/离线门全部落地并有故障敏感离线回归。
- **EXECUTED：AH-09 付费 dual 轮（2026-10-11 09:18，另行授权后执行）。** 首例真实链路 PASS，第二例按设计失败止损（FAIL）；该轮同时暴露并已定位修复一个 harness 缺陷（fail-stop 出口码丢失，见 §5）。
- 本记录不改写 [Node 24 工程验收](2026-10-10-node24-capability-acceptance.md)及更早历史证据。

## 1. 交付面

- `src/systemone.ts`：`ClassifierRequestError`/`classifierFailure` 类型化有界失败契约（AH-07），模块面 pin 于 `systemone.test.ts`。
- `test/fixtures/live-acceptance.json`：冻结 corpus（四条中英 classifier-only 任务、只读/写入 worker 任务、`{"values":[2,3,5,7]}` 输入，期望 `{"count":4,"sum":17}` 由父 oracle 独立计算）。
- `test/live-acceptance.ts`（test-only）：`prepareAcceptance`（离线、零请求、仅 git/init）、`claimAcceptance`（批准 hash、严格 manifest 解析、corpus/baseline/每例字节与 dev/ino 身份校验、caps 不得超冻结套件上限、每例任务 hash 与 oracle 期望必须来自冻结 corpus、worker root 必须位于冻结 runRoot 的 `consumers/` 之下、`O_EXCL` 0600 evidence）、`appendEvidence`（固定 v1 字段重建、append+sync 串行）、`superviseCli`（输出/行/时间预算，SIGINT→宽限→SIGTERM 仅指向 owned 子进程，TERM 后仍不 close 则有界落定为 `cliClosed:false`）、`executeAcceptance`（claim 前套件完整 eligible 门槛、逐例冻结重验、预留先 durable、journal 行为 receipt 权威、EOF/close 判定、首失败停止、dual 首例 `laya-first` 检查、dual 第二例冻结高位 loopback 端口绑定 503 且该例 env 删除 `LAYA_API_KEY`、全树 hash 对比判 git-clean、子进程不 close 时以 `cleanup-unverified` 停整轮）。
- `test/live.integration.ts`：严格入口。`--prepare laya|jev|dual` / `--execute <manifest> --approve <sha256>`；非法输入 exit 2、失败/不完整 exit 1、完整通过 exit 0、信号 130/143；仅容忍命令转发形成的一个 `--`。
- `package.json`：`test:live` = `pnpm run build && node dist/test/live.integration.js`；默认 `test` glob 含 `live-acceptance.test.js`、不含 live 入口。

## 2. 新执行的离线门槛

实际工具链：Node `24.11.0`（逐命令 `~/.nvm/versions/node/v24.11.0/bin`）、pnpm `10.12.1`。默认并行，未串行化隐藏失败；未启动 live、服务或 worker。

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | exit 0；393/393；失败/取消/跳过 0 |
| `pnpm run test:coverage` | exit 0；386/386；行/分支/函数 95.11% / 90.08% / 94.82%（各 ≥80%） |
| `pnpm audit --audit-level high` | exit 0；`No known vulnerabilities found` |

## 3. AH-01…08 的故障敏感负例（全部离线，31 个 live-acceptance 测试 + 既有套件，末项为 AH-09 轮后补回的 teardown 回归与 §6 的 5 个 deferred-minors 回归）

- **AH-01**：无参/缺 hash/未知 suite/多余参数/双分隔符 → exit 2；套件所需 eligible 集缺失 → 零调用且 evidence ENOENT；已 claim 的 manifest 二次执行拒绝；空/截断/带 stopped 尾的 evidence 不重放；crafted manifest 内部自洽但 caps 超冻结套件上限、任务 hash 不在冻结 corpus、oracle 期望非 corpus 事实、worker root 位于冻结 consumers 目录之外 → claim 拒绝。
- **AH-02**：canonical 同目录别名（同 dev/ino）通过；manifest 自身 symlink、跨 runRoot、消费者 root 替换（新 inode）、config symlink/FIFO、输入/配置字节漂移全部拒绝；生产 projectPath 语义未改。
- **AH-03**：prepare 声明零 HTTP/fetch/inference（进程内陷阱计数 0，仅 git spawn）；每例预留 append+sync 完成先于调用；注入 `FileHandle.sync` 失败 → 返回 1 且零分类请求，无 reservation 落盘。
- **AH-04**：缺失/重复（同 taskHash 种子）/畸形 journal → observed 降级为 `invalid`/`unknown` 并 fail `receipt-unique`；wrong-output/no-output/oversize(>64KiB)/坏 UTF-8 输出 → 有限类别停止或 fail，evidence <8192B；unknown 字段/canary/`LAYA_API_KEY` 等任意值经 sanitize 后不落盘。
- **AH-05**：每套件计数 ≤ 冻结 caps（laya 11 分类/7 worker、jev 1/1、dual 每后端 2/2）；首失败后其余案例无预留无 journal；entry 子进程 SIGINT → exit 130 + `stopped(signal)` 且仅一例预留；owned 子进程忽略 SIGINT 时宽限后 TERM 才 close（`termSent`/`cliClosed` 为 owned 子进程事实）；owned 子进程 SIGINT+TERM 均忽略或被后代占住管道时，TERM 后有界落定 `cliClosed:false` 并以 `cleanup-unverified` 停整轮（exit 130 保持操作者意图，后续案例不再预留）；entry 第二次信号按默认处置重抛；不扫杀未知进程；240s 预算经监督层共享停止分支覆盖；dual 固定端口被占用 → 绑定失败零付费停止（对该路径做跳过绑定变异，测试转 RED 证明其敏感）。
- **AH-06**：只读例越权写与未跟踪文件（含 `AGENTS.md`）的原地篡改、未跟踪文件删除均被前后全树 hash 对比抓住（git status 对此不可见）；写入例仅 `out/summary.json` 且父 oracle 独立读取核对；输入原地篡改同时被 hash 检查与全树对比抓住；dual 首例 `laya-first` 检查要求单次 laya 尝试且选中 laya（自然失败回退 Jev 不算目标成功）；将 oracle 改为总 true 的变异使 oracle 依赖负例错误通过（对应测试转 RED），独立事实负例仍失败——证明各检查独立承重；复原后全 PASS。
- **AH-07**：Task 1 契约（HTTP status/null、有限 code、deadline/cancel、8KiB、无重试）由 route/systemone/direct-transport 既有回归覆盖；receipt/journal 不携带 raw error。
- **AH-08**：pack 合成负例证明 live 入口/harness/corpus 路径被点名拒绝（`package/dist/test/live.integration.js`、`package/dist/test/live-acceptance.js`、`package/test/fixtures/live-acceptance.json`），真实 pack 正例通过且配置/skill/元数据仍在；README 与共享 skill 改为两步 prepare/approve 语法并删除旧 48 次循环描述；历史日期记录未改；`run` 生产用法未改。

## 4. 未验证与边界

- 未执行任何真实 Laya/Jev/Codex 调用；分类质量、六档行为、NAT/JEV/CAL/META 场景仍按原规格证据门槛，不以本报告关闭。
- dual 第二例的 503→Jev 回退腿与该例 `LAYA_API_KEY` 删除的效果离线不可证（Jev 端点硬编码为真实 hosted 地址，任何真实拨号都违反离线约束）；离线覆盖止于端口冲突零付费停止与首例 laya-first，回退腿已于 AH-09 付费轮 live 观测（见 §5）。
- 取消清理仅证明 owned CLI 子进程的 SIGINT/TERM 归属；其后代进程的清理性质为 unknown，未做进程组外扫描；全树 hash 对比排除 `.git`（git 自身会在快照间改写 index），worker 篡改 `.git` 内部为已知未覆盖上限。
- evidence 只含有限固定字段；金额无法从 usage 推断，报告不含原始 stdout/stderr/env。
- Task 1 新导出使 `systemone.test.ts` 模块面 pin 过期（Task 1 门未含该文件），本轮已更新为含 `ClassifierRequestError`/`classifierFailure` 的准确面并全绿。

## 5. AH-09 付费 dual 轮记录（2026-10-11 09:18–09:20）

授权链：用户 "commit, push, 授权跑流程" → 套件选择 dual → `--prepare dual` 冻结 manifest（sha256 `b60907f2…a49b56`，人工批准后 `--execute`）。baseline head `9b7915c`；caps `{worker:2, laya:2, jev:2}`，每例先预留后调用。

| 案例 | 判定 | 预留/实际 | 耗时 | 关键事实 |
| --- | --- | --- | --- | --- |
| dual-laya-first（readonly） | **PASS**（13/13 检查全真，含 laya-first） | worker 1 / laya 1 次 | 72114 ms | 真实 Laya 分类（8765，balanced/gpt-6.1-sol/medium，confidence 0.095，单次尝试选中 laya）+ 真实 codex 只读 worker，exitCode 0，stdout oracle 命中 |
| dual-jev-write（write） | **FAIL**（receipt-selected/pair、exit-zero、worker-completed、oracle 为假）→ 整轮止损 | worker 1 / laya 1 次 + jev 1 次客户端尝试 | 341 ms | 冻结端口 fixture 返回 503 → 回退托管 Jev：客户端尝试 264 ms 后 `ETIMEDOUT`（AH-07 类型化契约 `{kind:"request",httpStatus:null,code:"ETIMEDOUT"}` 首次在 live 观测）；CLI exitCode 1，无 worker、无 out/summary.json，fail-closed |

- 首次 live 证明离线不可证的 503→Jev 回退腿与该例删除 `LAYA_API_KEY` 的效果；Jev 失败按 Task 5 仅作观察记录（不做归因探测）。
- 消耗：1 次真实 Laya 分类 + 1 次本地 503 + 1 次托管 Jev 客户端尝试（ETIMEDOUT，计客户端尝试、非服务端已接收证明）+ 1 次 codex 只读 worker。caps 全程未超。
- **轮次异常（已定位修复）**：该轮进程 exit 0，而失败止损语法规定 exit 1。根因：dual fixture 的 `net.Server` 连接处理只写 503 + `end()` 不读；真实 CLI 发送带 body 的请求，未读字节把服务端 socket 永久停在 paused 态，`closeAllConnections?.()` 在 `net.Server` 上是 no-op（v24.11.0 验证为 undefined），裸 `server.close(cb)` 的回调永不触发 → `executeAcceptance` 的 promise 永不 settle → 入口 `.then` 不执行 → `process.exitCode` 未设置，事件循环排空后静默 exit 0（另一时序则表现为挂起）。已离线确定性复现（对 fixture 端口 POST body 的 peer 子进程），修复为：追踪 fixture 连接并在 close 前逐一 destroy（Task 1 对 direct-transport fixture 的同一惯例），回归测试 "a dead-peer fixture client cannot wedge the fail-stop exit" RED（exit 0，与付费轮同签名）→ GREEN（exit 1），全套件 394/394。该 manifest 已消费，不复放；重验需新 prepare + 新批准。
- 证据：runRoot `…/turnhelm-live-dual-EbeJJk/`（evidence.jsonl 9 条、两例 routes.jsonl journal），0600，不含原始 stdout/stderr/env。

## 6. Deferred minors 收口（2026-10-11，用户全权授权后逐条 TDD）

复审遗留的 6 条 minor（第 7 条 closeAllConnections 已由 §5 的修复关闭）全部收口，每条先 RED 后 GREEN；`pnpm test` 399/399，`pnpm run test:coverage` exit 0（行/分支/函数 95.11% / 90.14% / 94.82%）。

| Minor | 回归测试 | 语义 |
| --- | --- | --- |
| 畸形 manifest 经 gate 泄漏 parse 错误文本 | "a malformed manifest fails bounded without leaking manifest bytes" | 畸形/非法 manifest 以 exit 1 有界失败，stderr 为空（canary 不落 stderr）；入口 `main().catch` 兜底 exit 1 |
| classifier-only 不转发 abort | "aborting a classifier-only route stops the round as a signal" | 信号直达路由：观察记录落盘后以 `stopped(signal)` exit 130 停轮，绝不给被取消的路由打分 |
| routes.jsonl 无界读取 | "an oversized journal is not a usable receipt" | 读取前 stat 限 1 MiB；超限 journal 视为不可用 receipt（`receipt-unique` false），杜绝无界载入 |
| claim 后 caps/case 对象可变 | "claimed manifests are immutable in memory" | 解析后的整个 manifest 图 deepFreeze |
| baseline 漏 dist/test/live.integration.js、tools 不复验 | "tool drift between prepare and claim rejects" + prepare 形状断言 | prepare 基线钉住被执行的 live 入口；claim 时 node 版本或 execPath 漂移即拒（先于任何 evidence claim）；git 字段仅记录——prepare 之后无任何 git spawn，复验无意义 |
| README 表头误导 | —（文档） | "Actual Turnhelm worker" → "Worker invocations" |

