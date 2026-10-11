# Routing Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复已证实的验收假绿，并提供冻结、有限、独立授权的双语分类校准入口，不猜修生产路由或 Jev。

**Architecture:** 复用现有 test-only prepare/claim/reserve/evidence/routeTask，严格验证完整结果 payload，将 worker 准入与 dev/holdout 分类测量拆开。只有校准策略不匹配可继续已批准 roster；工程失败仍 fail-fast，完成标记与正常退出共同判读。生产热路径不变，供应商/策略调查单独设批准门槛。

**Tech Stack:** TypeScript strict / NodeNext、Node 24、node:test、现有 Node 标准库和 pnpm 10.12.1；零新增依赖。

**Spec:** [修订规格](../specs/2026-10-11-routing-reliability-design.md)（Astra `gpt-6-astra/high` 已复核）；[报告摘要](../../validation/2026-10-11-dynamic-routing-standard.md)。执行者先读这两份文件及 spec §8 复核处理。

## Global Constraints

- 当前只授权文档；以下 checkbox **全部未执行**。用户先审阅 spec/plan、明确实施范围和执行方式，才开始代码修改。建议 native 顺序实施：同一 harness 的接口紧密相连，没有并行改文件收益。
- 基线 `9a484c0f9bb2fcea999ada2c5bb7eb1cff46cc49`；开始先核对 HEAD/工作区及并行工作，不覆盖别人修改。若源码已变化，先重核接口/测试，不能套旧行号。
- 产品 Node `>=24.0.0`；必需验收实际 `24.x >=24.5.0`；pnpm `10.12.1`；Codex CLI `>=0.160.0`。记录实际版本/执行路径，不改全局 Node、shell、认证、代理或 config，不自动安装。
- 现有依赖/锁文件、生产 config v1、六档 model/effort、Jev 三重门槛、总预算/Laya 75%/顺序/no-retry/TLS 边界不变；生产热路径零新增请求/worker/I/O。
- 工程实施/离线验证不含真实 classifier/worker、health/probe 或服务启动；旧轮授权额度为零。新真实轮必须新 prepare、完整任务/权限/接收方/顺序/停止条件/次数及费用口径审阅、新 SHA 批准，不能自动串 suite。
- 放弃 test-only v1 执行兼容；不转换旧 manifest，不改历史 report/seal/evidence，不恢复/重放已 claim run。准备和新输出只写 owned 临时范围，证据0600、目录0700；日志使用 `umask 077`。
- 不创建 worktree；需要分支时沿用现有 checkout，先确认无冲突。commit/push/merge/发布/删除各自需当次明确授权；**不得把分支 commit 合并到 main**。计划不预授权任何 Git 提交。

## Review Focus

1. 完整 stdout 中前缀/后缀、多个对象或额外字段不能因最后一行正确而通过；Task 1 `RR01 whole payload and exact keys`。
2. 合法但改绑 profile、删 trial、跨 split 或 hosted env 不能绕过固定校准 scope；Task 2 `RR02 calibration forgery refuses before calls` / `RR03 calibration is local classifier only`。
3. 最后一例响应/verified 后取消或漂移，以及 completed append/sync/close 故障，不得出现可当作完成的结果；Task 2 `RR05 terminal boundary is fail closed`。
4. 完整12项中合法 band mismatch 应 exit3；协议失败应立即停止、incomplete，二者不可混淆；Task 2 `RR04 protocol and policy are independent`，含真实 entry 退出码检查。
5. README、shared skill、安装/包分发不能留下旧11次额度或悄悄复制 skill；Task 3 的 command/prepare 行为、符号链接与 offline pack 回归。

---

## 文件与边界

| 文件 | 责任 |
| --- | --- |
| `test/live-acceptance.ts` | shared oracle、v2 corpus/manifest、固定 suite、两维 evidence/顺序执行/末尾完成协议 |
| `test/live-acceptance.test.ts` | 复用 owned classifier/fake Codex/prepare trap；新的故障敏感离线回归和必要 test-only fixture helper |
| `test/live.integration.ts` | 两个新 suite 的严格 prepare grammar、退出码说明，仍不进入 offline glob |
| `test/fixtures/live-acceptance.json` | spec §4.3 的准确全文、split/pair/language/band；现有读/写任务及 `[2,3,5,7]` 不变 |
| `README.md`、`.agents/skills/turnhelm-routing/SKILL.md` | 窄同步 live 套件/预算/判定/退出口径；skill 单一来源/元数据不变 |

不新建实现模块。`src/`、`assets/config.json`、package scripts/lockfile、skill YAML、本期历史文档不改。条件调查的未来修改只有定位根因并获批准后才确定，不能预先改生产文件。

### Task 1: 修复完整 payload 的共同 oracle（RR-01）

**Files:** Modify `test/live-acceptance.ts:979–988,1258–1263`；Test `test/live-acceptance.test.ts:580–656,958–1055`（基线定位）。

**Interfaces:** 保持私有 `jsonEquals(raw:string|null, expected:Readonly<{count:number;sum:number}>):boolean`；调用者同时为 stdout 和 summary-file。复用 `startClassifierFixture(t)`、`writeFakeCodex(t)`、`workerEnv(fakeBin,mode)`、`buildRun(t,suite,url,cases)`、`readEvidence(runRoot)`；不导出生产 API。

- [ ] **Step 1 — RED 测试。** 新建 `RR01 whole payload and exact keys`，扩充已有 FAKE_CODEX 的少量 mode，让一个 agent_message 包含完整测试 payload（不是工具 progress）。对 readonly 和 write 分别检查 preamble/suffix/code fence、两个 JSON、额外字段、缺字段、数组/null、错误数值拒绝；合法 JSON 空白/缩进/字段倒序通过。核心断言：

  ```ts
  assert.equal(codeWithPreamble, 1);
  assert.equal(codeWithExtraKeyReadonly, 1);
  assert.equal(codeWithExtraKeyWrite, 1);
  assert.equal(codeWithWhitespaceAndReorderedKeys, 0);
  assert.equal(classifier.state.requests, 1); // 首例失败，第二例不调用
  assert.ok(evidence.findIndex(x => x.phase === "observed") < evidence.findIndex(x => x.phase === "verified"));
  assert.equal(evidence.at(-1)?.reason, "verdict");
  ```

- [ ] **Step 2 — 验证 RED。** `pnpm run build && node --test --test-name-pattern='RR01 whole payload and exact keys' dist/test/live-acceptance.test.js`；应至少 preamble/extra-key 断言失败，不能以编译错误或测试名零匹配代替 RED。
- [ ] **Step 3 — 最小修复。** readonly 把完整 `stdoutText` 传入 jsonEquals，删除最后一行提取；共同函数只一次 JSON.parse，Object.keys 恰为 count/sum、own fields、safe integer 和独立4/17事实比较。保留输出限制、安全路径/树检查和 observed-before-verdict，不加 parser/regex/canonical serializer。
- [ ] **Step 4 — GREEN 与独立交付。** 重跑 Step 2 和 `node --test dist/test/live-acceptance.test.js`；新的非空匹配集与整个文件均通过，原 write/readonly/secret/树边界不退化。查看 scoped diff，仅上述两文件。若无额外 Git 授权，停在已验证未提交状态。

### Task 2: v2 固定校准与可靠完成协议（RR-02…05）

**Files:** Modify `test/live-acceptance.ts` 的 types/parser/prepare/claim/sanitize/execute、`test/live.integration.ts:1–33`、`test/fixtures/live-acceptance.json`；Test `test/live-acceptance.test.ts`。这些紧密耦合更改为一个可独立验收单元，不先发布缺 terminal checks 的半成品。

**Interfaces（名称/签名与 Task 1 对齐）:**

- `LiveSuite = "laya"|"jev"|"dual"|"calibration-dev"|"calibration-holdout"`；`AcceptanceManifest.version:2`。
- `AcceptanceOracle` 保留两个 worker 分支，替换 classifier-valid 为 `Readonly<{kind:"classifier-band";pairId:string;language:"en"|"zh";split:"dev"|"holdout";trial:1|2|3;allowedProfiles:readonly ProfileId[]}>`。
- 私有 `parseCorpus(value:unknown):FrozenCorpus`，输出 spec §4.2 的 readonly v2 字段；仅 test-only 数据类型，不导出 package API。
- 私有 `readHostSnapshot():Promise<AcceptanceManifest["hostSnapshot"]>`、`verifyHostSnapshot(manifest:AcceptanceManifest):Promise<void>`；前者调用已有 `readProjectFile(root,relative,max):Promise<Buffer|undefined>`，root=REPO_ROOT、relative=`.turnhelm/config.json`、max=65536；不保存原内容。
- 保持现有 `prepareAcceptance(suite:LiveSuite):Promise<{manifestPath:string;sha256:string}>`、`claimAcceptance(path:string,approved:string):Promise<ClaimedRun>`、`appendEvidence(run:ClaimedRun,record:SafeEvidence):Promise<void>`；`executeAcceptance(path:string,approved:string,options?:Readonly<{env?:NodeJS.ProcessEnv;signal?:AbortSignal;termGraceMs?:number;postTermMs?:number}>):Promise<number>`。
- `SafeEvidence.verified` 必填 `policy:"match"|"mismatch"|"not-applicable"`；新增 spec §5 固定 completed 分支，cases=12、safe counters、正确 outcome。`executeAcceptance` 正常 pass=0、完整 policy mismatch=3、failure/incomplete=1、内部取消=130；entry 映射 SIGINT/SIGTERM=130/143，usage=2。
- 新 test-only `buildCalibrationRun(t:TestContext,suite:"calibration-dev"|"calibration-holdout",layaUrl:string):Promise<{manifestPath:string;sha256:string;runRoot:string}>`：调用 prepare 后只把 owned manifest 的 Laya URL 改到 owned fixture，重算 SHA；不得改 profiles、roster、band。普通 buildRun 保留 worker 子集并升级v2。

- [ ] **Step 1 — RED 格式/范围回归。** 添加 `RR02 calibration forgery refuses before calls`、`RR03 calibration is local classifier only`，先在测试中冻结 spec §4.3 的预期数据，corpus 实际升级留到 Step 3。prepare trap 扩展至五 suite，断言零网络、只允许既有 Git 子进程、两个校准各12项且空消费者/零worker/Jev、laya7worker7Laya、default profiles、每trial四项顺序。伪造 v1、未知键、错误enum/重复band、跨split、错ID/task/oracle、删/重复/调序trial、rebind、修改timeout、启用Jev/worker、少报caps均在第一请求前拒绝，即使重新计算批准SHA。关键断言：

  ```ts
  assert.deepEqual(dev.caps, {worker:0,laya:12,jev:0});
  assert.equal(dev.cases.length, 12);
  assert.deepEqual(dev.cases.map(x => x.id), [1,2,3].flatMap(n =>
    ["heading-en","heading-zh","race-en","race-zh"].map(id => `${id}-trial-${n}`)));
  assert.deepEqual(holdout.cases.map(x => x.id), [1,2,3].flatMap(n =>
    ["decoy-en","decoy-zh","auth-en","auth-zh"].map(id => `${id}-trial-${n}`)));
  assert.equal(await executeAcceptance(forged.manifestPath, forged.sha256, {env:fixtureEnv}), 1);
  assert.equal(classifier.state.requests, 0);
  ```

  malformed corpus/宿主异常在隔离 child preload 内把**精确 corpus/host 路径读取**重定向至 owned fixture，其他路径委托原 reader；不改真实仓库/宿主/global 文件，不加 production injection option。校准执行测试用虚构 hosted gate/key canary并将任何 HTTPS attempt 设为拒绝计数、Codex shim 记录调用；12次 Laya 后 HTTPS/Codex 次数均0。不能拿 canary 访问真实 endpoint。

- [ ] **Step 2 — 验证 RED。** `pnpm run build && node --test --test-name-pattern='RR02|RR03' dist/test/live-acceptance.test.js`；记录具体拒绝/roster断言失败。类型变更尚未实施时可先用 entry prepare 新suite 的行为测试取得真实 RED，不能只记录类型不存在。
- [ ] **Step 3 — 格式/prepare/claim 的最小实现。** corpus 按 spec §4.2/4.3 原样升级为v2，worker任务/input不变。严格 parseCorpus 取代两处 cast，核对八任务、两split各两pair、同band的en/zh、合法全文/输入数字；三个trial在prepare展开。删除laya四项旧分类，classifier-only只进校准。parseManifest严格v2/grammar/预算，claim逐项绑定完整roster/oracle/corpus、default profiles/timeout/合法Laya-only配置；保留worker合法子集、所有原claim/冻结门槛。更新 buildRun 及旧 classifier-only 测试到完整校准 roster；取消/协议失败仍验证后续0调用，不能删掉这些安全断言。其他 dual scope 回归改用 worker 子集，仍测试 declared reservation 限制。
- [ ] **Step 4 — RED 判定/完成回归。** 添加 `RR04 protocol and policy are independent`、`RR05 terminal boundary is fail closed`。scripted classifier 对dev使用每trial `[fast,balanced,deep,frontier]`；一项改为合法但不在band的profile=继续12次，invalid response=立即停。复用已有 FileHandle prototype appendFile/sync mock，在**最后 verified、completed append、completed sync**分别触发 abort、冻结 bytes drift 或 host hash变化；close失败单独注入。隔离 mock/preload，不用sleep竞态、不写真实src/dist/config。断言：

  ```ts
  assert.equal(allMatchCode, 0);
  assert.equal(oneMismatchCode, 3);
  assert.equal(classifier.state.requests, 12); // 完整 mismatch，非失败重试
  assert.deepEqual(completed, {phase:"completed",outcome:"policy-mismatch",cases:12,policyMatches:11,policyMismatches:1});
  assert.equal(protocolFailureCode, 1); // 在第2项注入失败，requests=2，无completed
  assert.equal(terminalIoFailureCode, 1); // 即便 completed 行已可见也不是正常完成
  assert.equal(terminalAbortCode, 130);
  assert.equal(terminalDriftCode, 1);
  ```

  宿主 ENOENT=absent，其余 EACCES/symlink/FIFO/>65536 拒绝；prepare/claim/final共用同一契约。测试真实 entry 0/3/1/130/143（均只owned fixture/fake worker），completed+exit组合才可当作完成；closed FD 不重新打开。对非法 policy/outcome/非safe计数/不等于12/错误计数和以及raw canary字段，appendEvidence拒绝或白名单剥离，原始内容不落盘；worker policy为not-applicable且oracle失败仍首例停止。
- [ ] **Step 5 — 验证第二组 RED。** `pnpm run build && node --test --test-name-pattern='RR04|RR05' dist/test/live-acceptance.test.js`；应在mismatch退出/terminal注入断言失败，不因错误mock触发更早的prepared/reserved故障而“测绿”。确认注入确实命中最后一例的目标phase。
- [ ] **Step 6 — 实现两维判定与有限终端协议。** routeTask正常一次Laya后先observed；工程pass才判band。只合法mismatch继续，routing/资格/取消/冻结/I/O异常都停。按spec §5.1复用readHostSnapshot完成末尾pre/post检查、durable completed、close结果和最后abort检查，再返回0/3；failed-close不吞成成功。不添加新observer、自动重试、第二claim或公共运行时选项。所有worker正常返回同样做末尾检查与close，不新增worker completed。
- [ ] **Step 7 — GREEN 与交付检查。** 重跑两组focused命令及 `node --test dist/test/live-acceptance.test.js`；新的非空匹配集、全部旧安全回归通过。明确两校准12项request上限；故障后无额外调用、claim不可重放；source/dist/corpus/host晚期drift不算完成。只对本Task文件做diff审阅，不提交/发live调用。

### Task 3: 同步使用契约并完成离线工程验收（RR-06；保持RR-01…05）

**Files:** Modify `README.md:299–333`、`.agents/skills/turnhelm-routing/SKILL.md:121–141`；Test `test/live-acceptance.test.ts` 的 entry/prepare 行为；Run existing `test/package.test.ts`、`test/init.test.ts`，不复制 fixture。

**Interfaces:** 消费 Task 2 五suite和退出0/3/1/2/130/143；skill单一来源，`.claude/skills/turnhelm-routing` 指向 `../../.agents/skills/turnhelm-routing`；`agents/openai.yaml` 不变，package test已覆盖离线pack/install/init/doctor且禁止live harness打包。

- [ ] **Step 1 — 行为与分发检查。** 新 entry prepare 两个校准suite各只打印 manifest/SHA 两行；无参数/错误suite/缺批准hash/重复`--`仍拒绝；offline glob不含live.integration。沿用prepare网络/subprocess trap证明输出对应真实roster，而非仅匹配文档字串；核验skill符号链接单一来源。`pnpm run build && node --test dist/test/live-acceptance.test.js dist/test/package.test.js dist/test/init.test.js` 应全部pass，关键安全无skip。
- [ ] **Step 2 — 窄文档修改。** 按skill-creator更新live段落和README：laya7次/7worker，jev1/1，dual每后端2/2worker，dev/holdout各12Laya/0worker/Jev；mismatch继续仅校准、完整exit3、incomplete exit1、completed不能独立证完成；人工批准/不串suite/次数不是账单。保留归属取消、后代清理unknown、不恢复和不准确率/金额声明。
- [ ] **Step 3 — skill验证与pack回归。** `python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" .agents/skills/turnhelm-routing`；路径/依赖缺失就记录并停止该项，不安装替代工具。随后重跑Step 1；符号链接/元数据未变、包内唯一skill与安装内容一致，旧消费者冲突继续拒绝自动覆盖，不改现有消费者安装。
- [ ] **Step 4 — 完整工程验证。** 用实际Node `24.x >=24.5.0` 和pnpm10.12.1，在 `umask 077` 的owned证据目录记录版本/执行路径、HEAD/diff、`pnpm test`、`pnpm run test:coverage`、`pnpm audit` 结果。零失败/取消，关键安全不skip，src行/分支/函数各≥80%；coverage不固定旧406分母，test-only新逻辑以focused断言覆盖。审计高/严重阻止验收，其余明确处理，无结果/超时不能报无漏洞。项目无独立lint脚本，不虚构lint成功。
- [ ] **Step 5 — 完成工程交付而非线上finding。** `git diff --check`，逐文件diff；确认无未声明production/API/dependency/config/旧evidence改动。汇总实际测试数量、退役旧合法-only任务/重定向安全回归、未执行真实场景和仍open的Jev/语义问题；RR-01…06满足即可独立交付，但不得称一般路由质量或双后端恢复。Git集成继续等待单独授权。

## 条件性后续调查（不属于本轮代码实施授权）

### Investigation J: Jev 因果诊断与恢复（RR-07）

**Files/read boundary:** 既有密封report/results、`src/systemone.ts` 的固定endpoint/typed failure、`src/route.ts`、原jev/dual suite；输出只到新owned0600有限事实文件。没有预定源码修改或新诊断模块。

- [ ] J1：只读核对 request/HTTP null/ETIMEDOUT 与时间，保留unknown；需要官方API行为资料时按documentation-lookup核验primary docs，不读key/auth/完整env。
- [ ] J2：如现有证据不足，先另拟并请求批准固定官方host的非认证DNS/连接/TLS命令、每项次数/超时、敏感信息白名单和停止条件；批准前零probe。未获批准或外部不可解即交付有界unknown/受阻报告，不猜修代理/账号/TLS。
- [ ] J3：有明确可修因果才补独立最小修复spec、RED/GREEN安全fixture与授权。若无本地缺陷不为提交而造patch。
- [ ] J4：另行批准新jev与dual manifests和费用/数据scope；真实请求走原gate/routeTask/CLI，无自动probe/retry。只有两项相关worker与独立oracle真实成功、负向仍不启动worker，才能关闭Jevfinding。任何工程失败即停；旧余额不延续。

### Investigation C: 开发校准与候选推进（RR-08）

**Files/read boundary:** Task 2 fixed corpus/runner、新owned manifest/evidence/逐例表；仅有证据支持且另获实施批准时，最小候选才可改 `src/systemone.ts` 的criteria/instructions和 `test/systemone.test.ts` 对应契约，不改route/config/预算/model map。

- [ ] C1：先独立批准calibration-dev基线12次Laya/0worker/Jev；记录所有工程/策略结果、source/dist/corpus SHA与实际exit。工程失败停止；完整策略不匹配可成为调查证据，不改band或重放。
- [ ] C2：按dev机制证据决定“不改/记录局限”或提出一个最小候选，说明为何不是关键词拟合。没有可证改进就不消耗调优/holdout轮次。
- [ ] C3：候选源码与任务/band固定后重新prepare/批准dev12次；只有完整、12/12band匹配、exit0才可另行批准holdout12次。候选dev失败/exit3即停止，不消耗holdout，不自动造第二候选。
- [ ] C4：holdout失败保留并停止推进，不调参重测同一留出集；通过只能称冻结参考回归通过，公开小样本不称盲测/一般准确率。两个suite各自批准，候选只走上述一条链，不能扩次数。
- [ ] C5：若要声称真实质量/性能或最轻充分模型，先写另一个具体成对worker协议（完整任务/客观结果oracle/权限/映射/失败/顺序/开发留出/独立run/上限）；核验当次费用授权的受支持控制，不能核验就不启动。ChatGPT次数口径需用户明确接受无金额硬界，不宣称API账单/节省；没有该协议和批准，本计划到C4即停，不制造泛化benchmark平台。

## 自检与交接

| Spec criterion | 实施/测试落点 |
| --- | --- |
| RR-01 | Task1 shared oracle、前后说明/extra-key、observation先保存、失败后零第二请求 |
| RR-02 | Task2 v2严格parser、完整roster/metadata/config/caps伪造前置拒绝 |
| RR-03 | Task2 prepare trap、两个12项、默认映射、零Codex/HTTPS、旧suite范围 |
| RR-04 | Task2 policy独立、exit0/3/1、完整/不完整、负向fail-fast/不可重放 |
| RR-05 | Task2终端取消/漂移/append/sync/close/host读取故障、白名单canary；原安全回归保留 |
| RR-06 | Task3 docs/skill/grammar/链接与离线pack、实际Node24完整test/coverage/audit |
| RR-07 | Investigation J；未批准/unknown不关闭finding |
| RR-08 | Investigation C；候选dev通过才进入holdout；质量/费用门槛另冻结 |

root 自检范围：spec coverage、精确文件/接口/固定值、RED/GREEN与非零匹配、五项Review Focus、实现与条件调查分离、文档比例和权限边界。交付后请用户审阅并确认执行方式；在确认前，全部代码/live/服务/Git动作继续为零。
