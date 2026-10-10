# Node 24 Baseline Implementation Plan and Conditional Investigations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 独立完成 Node 24 支持范围收敛，并为其余未解决问题安排最小、有停止条件的调查。

**Architecture:** 只修改现有版本声明、doctor 门槛、测试证据和说明；复用现有 CLI、传输、worker 与包安装夹具，不增加运行时依赖或公开 API。Node 工程项有自己的交付门槛；NAT/JEV/CAL/META 属于条件调查，不是迁移的合并前置条件，也不预设计未知根因的修复。

**Tech Stack:** TypeScript、Node.js built-ins/test runner、pnpm `10.12.1`、现有 Codex CLI。

**Spec:** [Node 24 收敛规格](../specs/2026-10-10-node24-unresolved-remediation-design.md)。

**Status:** 2026-10-10 文档草案；基于 `891abdd3658c49a63c94500ea502bbf70f2b5efa` 和 `gpt-6-astra/high` 只读复核。用户授权写计划，不是授权实施、真实调用、commit/push 或发布。

## Global Constraints

- 产品门槛 `>=24.0.0`；必需激活代理验收使用实际 `24.x >=24.5.0`，记录补丁版本和执行文件；不以 Node 26 替代，不安装/执行 Node 22.8 补证。
- 保留 pnpm `10.12.1`、锁文件、依赖、ES2022/NodeNext 和现有 CLI/config/export 结构；不顺带升级工具链。
- 保留 v1、六个 profile、完整任务 `8192` UTF-8 字节、默认期限 `10000ms`、双后端 Laya 约 `75%` 剩余预算、单后端完整期限。
- 默认只读、每次 run 至多一个 worker、三项 Jev 门槛、无自动重试/替代模型；TLS、凭据/coverage 剥离、marker、receipt/journal、取消和清理均不削弱。
- 不改全局 Node/Codex、HOME、shell 启动、认证、代理或服务；不读真实密钥值/旧 dump，不恢复或改写封存证据。
- 计划阶段分类器/worker/health/probe 调用均为 `0`。执行阶段任何真实调用仍受规格 §11 的当轮数据、调用、支出和停止授权约束；客户端次数不是金额上限。
- canonical 待办只用 `work_state_write` 的 `todo/doing/done/dropped`；未验证/受阻另写证据字段，子任务完成不关闭证据不足的核心问题。

## Review Focus

1. `23.99.99` 与 `24.0.0` 的边界：前者失败、后者通过，失败提示为准确新门槛；Task 1。
2. 版本模拟污染后续 doctor：完整 descriptor 必须在异常路径也恢复，实际版本检查仍成立；Task 1。
3. 只设置代理变量却未激活：默认 agent 正向对照须命中 sentinel，direct 请求不能增加代理计数；Task 2。
4. 已安装旧 skill/用户改写文件：维持 conflict/refuse 及文件保留，不能新增自动覆盖；Task 3 的现有 init/doctor 回归。
5. 已安装 tarball/bin 找回错误 Node 或旧模板：Node check 明确 pass，打包门槛/skill 一致，带空格路径仍成立；Task 3 的 package 断言。

## Phase 0: Documentation discovery and allowed APIs

已完成本轮只读发现；下列是当前源码依据，执行时若 HEAD/文件变化，应通过 CodeGraph 重新确认，不使用旧行号盲改。

| 来源 | 可复用接口/模式；禁止事项 |
| --- | --- |
| `src/doctor.ts:20–55,198–214` | `doctorProject(root: string, options: DoctorOptions): Promise<DoctorResult>`；options 只有 probe/env/signal/request；Node 直接来自 `process.versions.node`。不新增版本注入 API。 |
| `test/doctor.test.ts:39–98,100–114,478–527` | preparedProject/fakeBin/doctorEnv/countingRequest；顺序测试中 save/try/finally restore 模式。所有 Codex/分类器均为 fixture。 |
| `test/direct-transport.test.ts:86–105,298–355` | startServer、proxyChild、独立子进程；现有 NO_PROXY 情形为不存在/空字符串；删除的是旧 Node22 专属 leg，不是 TLS 断言。 |
| [Node 24.11 Agent](https://nodejs.org/download/release/v24.11.0/docs/api/http.html#new-agentoptions)、[built-in proxy](https://nodejs.org/download/release/v24.11.0/docs/api/http.html#built-in-proxy-support) | proxyEnv/内置代理从24.5加入；`NODE_USE_ENV_PROXY=1` 作用于启动时默认 agent。普通 `http.get` 可作对照；不使用后续版本新 API 或修改全局代理。 |
| `test/package.test.ts:57–159` | pnpm pack → 临时 Git consumer → pnpm add `--offline --ignore-scripts` → installed bin；已有路径/资产/fake Codex 验收，不建第二套 harness。 |
| `src/assets.ts:58–64`、`.claude/skills/turnhelm-routing` | 打包和 init 使用 `.agents/skills/turnhelm-routing` 同一模板；Claude 路径是符号链接，不改为复制。 |
| `src/config.ts:68–104` | `parseProjectConfig(value: unknown): ProjectConfig`；六个 profile 可以绑定同一合法组合，实际授权/可用性不由 schema 保证。 |
| `src/systemone.ts:7–22,27–123,185–212` | `ChoiceRequest=(spec: RequestSpec)=>Promise<unknown>`；`requestTaskChoice(config,task,backend,env,signal,request?)`。没有 observer/阶段字段，不虚构 DNS/TLS 诊断能力。 |
| `src/codex.ts:20–34,48–72`、`test/worker.test.ts:425–532` | 初始环境与执行参数由既有代码/合成回归保证；不能扩大为 shell 后代秘密隔离。 |
| `package.json`、`.github/workflows/ci.yml` | test/coverage 都先 build；offline runner 不执行 live.integration；CI 已是 Node24，无需新矩阵。 |
| 当前 work_state 工具元数据 | read({list?,includeClosed?}) / write({list,fields})，**没有 project 参数**。无法选择旧项目时不能写裸列表或猜隐藏参数。 |

## Execution boundary and ownership

仅 Tasks 1–3 是可实施的软件计划，按顺序执行，避免多个 agent 同时构建或改共享文件。实现者拥有该任务列出的文件；复核者只读。所有 agent 都不是工作区唯一操作者，不回滚别人改动。

- [ ] 先获得用户对修订 spec/plan、实施范围和执行方式的确认。需要 worktree/分支时遵循 using-git-worktrees，但不得擅自移动、提交或清理当前两份未提交文档。
- [ ] 核对当前 HEAD/diff；保留用户工作。使用既有 Node24，不改全局默认值。当前发现有 `v24.11.0`、`v24.2.0` 路径，未在本轮运行；选24.11作为本地激活验收候选，缺失/不符时停止，不自动安装。
- [ ] 在每个校验命令作用域选择同一 Node24，并核对 pnpm10.12.1。例如：

```sh
NODE24_BIN="$HOME/.nvm/versions/node/v24.11.0/bin"
test -x "$NODE24_BIN/node"
PATH="$NODE24_BIN:$PATH" node -p 'JSON.stringify({node:process.versions.node,execPath:process.execPath})'
PATH="$NODE24_BIN:$PATH" pnpm --version
```

期望 Node major=24、minor>=5、execPath 为选定路径，pnpm=10.12.1。该路径只属于执行记录，不写入测试/产品。依赖已存在才继续；缺少依赖时先取得安装授权，不能以自动下载完成前置条件。

### Task 1: Node floor and diagnostic boundary

**Files:** Modify `package.json`、`src/doctor.ts:27,210–214`；Test `test/doctor.test.ts`。

**Interfaces:** 消费既有 doctorProject/DoctorOptions；产出同一 DoctorResult.node check，floor `[24,0,0]`。不新增导出、options、CLI/config 字段。

- [ ] **Step 1: 添加单个 `test("doctor node floor is 24.0.0", { concurrency: false }, async t => ...)` 测试。**复用 preparedProject/fakeBin/doctorEnv/countingRequest，先准备 fixture/env，再保存 Node descriptor；以下是断言模式，不把版本模拟扩散到其他测试：

```ts
const root = await preparedProject(t);
const bin = await fakeBin(t);
const env = await doctorEnv(t, bin);
const { request, count } = countingRequest();
const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
assert.ok(descriptor?.configurable);
try {
  for (const [version, status] of [
    ["22.8.0", "fail"], ["23.99.99", "fail"],
    ["24.0.0", "pass"], ["24.0.1", "pass"], ["25.0.0", "pass"]
  ] as const) {
    Object.defineProperty(process.versions, "node", { ...descriptor, value: version });
    const result = await doctorProject(root, { probe: false, env, request });
    const node = result.checks.find(check => check.id === "node");
    assert.equal(node?.status, status, version);
    if (status === "fail") assert.equal(node?.next, "upgrade node to 24.0.0 or newer");
  }
} finally {
  Object.defineProperty(process.versions, "node", descriptor);
}
assert.deepEqual(Object.getOwnPropertyDescriptor(process.versions, "node"), descriptor);
assert.equal(count(), 0);
```

同一测试追加 package engine 精确等于 `>=24.0.0` 的断言，复用现有 readFileSync，编译后的 `new URL("../../package.json", import.meta.url)` 指向包根。已有未模拟 offline doctor 测试追加 node status=pass。模拟23/25是边界单测，不是实跑这些版本。

- [ ] **Step 2: RED。** `PATH="$NODE24_BIN:$PATH" pnpm run build && "$NODE24_BIN/node" --test --test-name-pattern='doctor node floor is 24.0.0' dist/test/doctor.test.js`。应因旧22.8被判pass而失败，非编译/fixture/权限错误；记录匹配且执行了一项，finally仍恢复。
- [ ] **Step 3: 最小 GREEN。** engines改为`>=24.0.0`；NODE_FLOOR改为`[24,0,0]`；提示精确为`upgrade node to 24.0.0 or newer`，其余诊断/解析/顺序不变。
- [ ] **Step 4: 同一 focused命令通过，再用选定Node执行 `node --test dist/test/doctor.test.js`。**0失败/取消、实际未mock的node项pass、零真实请求；descriptor若不可配置，停止报告，不为单测添加产品API。
- [ ] **Step 5: 复核 diff 并在 canonical 登记结果。**工程提交统一留到Task3审计/全量验收和提交授权后，不提交破坏中间态。

### Task 2: Retire Node22 leg and make proxy evidence non-vacuous

**Files:** Modify/Test `test/direct-transport.test.ts:66,298–355`；默认不改 `src/systemone.ts`。

**Interfaces:** 消费现有 startServer/proxyChild 和 `directChoiceRequest(spec: RequestSpec): Promise<unknown>`；产出同一公开行为的更强证据，不添加生产 observer/代理配置。

- [ ] **Step 1: 删除 NODE_22 个人路径、独立旧测试和失去用途的 existsSync 导入。**保留 TLS、响应、取消和当前runtime用例；登记“退役”，不计作原用例通过。
- [ ] **Step 2: 在 proxyChild 的既有两种 NO_PROXY 情形内增加普通默认agent对照。**在启动时设好 `NODE_USE_ENV_PROXY=1` 和指向 loopback sentinel 的四项代理变量；清除该受控子进程继承的 NODE_OPTIONS，避免其他代理开关扰动。对照用普通 `http.get`、不传agent，消费响应并有界结束；响应应为sentinel的`proxied`，目标请求数不增加。
- [ ] **Step 3: 正向对照后运行原生产请求子进程，分别断言增量。**每种情形默认代理请求增量=1；随后direct的代理增量=0、目标增量=1，且choice仍为fast。不能沿用整段sentinel总数=0，因为对照本来应命中它。所有子进程/fixture继续使用既有超时和t.after清理。
- [ ] **Step 4: 区分测试能力。**仅在测试内按`major > 24 || (major === 24 && minor >= 5)`选择对照；24.0…24.4仅保留direct断言并明确不是激活代理证据，不引入24.5产品门槛或个人二进制fallback。必需验收在实际24.5+执行，不能通过跳过消除失败。
- [ ] **Step 5: 构建后用选定Node执行 `node --test dist/test/direct-transport.test.js`。**期望代理对照、direct和TLS全部执行/通过。仅在自己拥有的测试fixture做一次故障敏感检查：对照子进程把NODE_USE_ENV_PROXY设为0，应使“proxied/命中sentinel”断言失败；还原自己的fixture再通过，不改生产agent或用户代码。
- [ ] **Step 6: 只读复核 + canonical结果。**不因新断言通过声称已实跑24.0或证明所有未来Node版本；若暴露真实生产差异，停止该任务，先定位再提出最小修复。

### Task 3: Shared docs, installed-package proof and independent Node gate

**Files:** Modify `README.md:32`、`.agents/skills/turnhelm-routing/SKILL.md:18`、`test/package.test.ts`；Create `docs/validation/2026-10-10-node24-baseline.md`（记录实际执行时间，不预填成功）。历史验证/旧spec/旧plan只在现行承诺处加supersession说明；CI/YAML仅必要时改。

**Interfaces:** 消费Tasks1–2同一版本契约和`readTemplates(): Promise<Templates>`；产出同一共享模板及installed-bin证据，不新增安装器/升级器。

- [ ] **Step 1: 同步当前版本说明。**README/skill明确Node>=24.0.0、验收24.x>=24.5.0、停止22.8支持。更新skill前读取并遵循skill-creator；保持template v1和Claude符号链接，openai.yaml未受影响不改。
- [ ] **Step 2: 在现有package测试追加installed package engines=`>=24.0.0`、packed README/skill新版本文字，以及doctor的node status=`pass`断言。**保留包白名单、空格路径、offline/ignore-scripts、fake Codex、init幂等和冲突保护。不再建pack/安装harness，不连接registry或真实backend。
- [ ] **Step 3: 用选定Node构建并运行focused集合：**`node --test dist/test/doctor.test.js dist/test/direct-transport.test.js dist/test/init.test.js dist/test/package.test.js dist/test/worker.test.js dist/test/preflight.test.js`。期望0失败/取消；旧skill冲突仍fail/refuse且不覆盖用户文件；环境/marker断言仍成立。
- [ ] **Step 4: 默认并行全量验收，两个命令串行执行，不能同时重建dist。**以下只在实施获准后运行；不执行test:live或doctor --probe：

```sh
env -u TYPESAFE_API_KEY -u LAYA_API_KEY -u TURNHELM_ALLOW_HOSTED_JEV \
  PATH="$NODE24_BIN:$PATH" pnpm test
env -u TYPESAFE_API_KEY -u LAYA_API_KEY -u TURNHELM_ALLOW_HOSTED_JEV \
  PATH="$NODE24_BIN:$PATH" pnpm run test:coverage
PATH="$NODE24_BIN:$PATH" pnpm audit --audit-level high
git diff --check
```

期望0失败/取消，行/分支/函数覆盖率各>=80%，必需代理/TLS用例无跳过；分母由实际结果决定。审计必须有完整成功结果：高/严重发现阻止验收，低等级明确报告/处置，超时不是零漏洞。审计是授权的registry查询，不是离线分类器/服务测试，也不是Jev诊断。

- [ ] **Step 5: 新验证记录写入精确HEAD/工作区快照、Node/pnpm路径版本、命令/退出码、用例分母、退役/新增/跳过说明、coverage、audit和未验证边界。**旧结果保留；检查当前README/skill/doctor/engine一致，不对旧日期结果做全局替换。
- [ ] **Step 6: 按当前reviewer风险策略独立复核，更新N24-01…05状态。**证据全部成立即可独立交付；后续调查受阻不阻止这项完成。只有另行授权才提交包含本任务归属文件的Conventional Commit（建议`chore: require Node 24 for Turnhelm`），先审git diff和audit；push/PR/merge/分支清理不在本计划默认动作内。

## Conditional investigation schedule — not speculative implementation

下列工作流是独立调查任务，不预排生产补丁，也不需要同时成功。它们在Node基线建立后执行；不共享构建产物时可按用户确认的方式独立推进。每项开工先登记canonical任务；新私有证据只用另行批准的新位置和受控归属，不写原sealed namespace或把原始秘密带进repo。

### S1: Native environment/marker provenance（NAT-01…03）

**Files/API:** 只读 `src/codex.ts:20–34,48–72`、`src/preflight.ts`、既有worker/preflight测试；先不改生产文件或新增harness。消费初始spawn契约，产出安全来源记录或接口限制报告。

- [ ] 查当前实际Codex版本与官方/受支持的执行器、工具调用元数据接口，区分初始spawn、工具边界、目标shell。版本/help及模型自然语言不作后代执行证据；没有可信来源就停止真实观察，记录未验证。
- [ ] 若接口成立，先审一个合成只读任务和安全投影：四项控制仅presence布尔、markerEqualsOne；不读值/完整env/脚本/auth。来源/version/run身份只保存允许字段；字段缺失不归因。
- [ ] 另行冻结并取得调用/费用授权后，建议本轮至多1个真实只读worker、Laya<=1/Jev<=1且0重试；这是建议上限，不是本文件授予额度。走现有run，不为诊断换HOME/认证/执行器策略；缺少预算控制则不启动。
- [ ] 用可信工具结果而非agent摘要核对投影；首次失败停止、未观察项保留。能完成调查不等于NAT-03成立；若发现项目根因，再单独提出该文件的敏感回归/最小修复。

### S2: Jev source discovery and attribution（JEV-01…03）

**Files/API:** 只读 `src/systemone.ts:27–123,185–212`，复用现有direct-transport/task-routing回归；产出来源能力清单与有限归因，不新增observer/公开错误schema。

- [ ] 列明实际可取得字段。现有固定错误只能证明失败，不能证明DNS/TLS阶段；未观察status为null/unknown，不是451。先运行既有离线安全回归，HTTP451合成fixture只证明HTTP处理，不证明服务可用性。
- [ ] 查受支持的服务方关联/状态/预算/重试证据与可信传输观察接口；不抓原始body/header/error或完整task，不猜endpoint，不用npm审计解释Jev。无归因接口可交付限制报告，不做猜测修复。
- [ ] 前提与当轮授权成立后，建议单次托管Jev分类、0worker、0重试，走既有requestTaskChoice/directChoiceRequest并保持三项门槛。单次成功只证明该分类路径；首次失败停止，不为了恢复结论继续调用。
- [ ] 若需“真实任务链路恢复”结论，单独确认完整只读run范围及额外worker额度；不用doctor/probe冒充。原因或恢复证据不足时JEV核心项仍开放。

### S3: Frozen finite quality/cost comparison（CAL-01…04）

**Files/API:** 专属新合成项目/私有manifest与oracle；消费parseProjectConfig和现有run/receipt/journal/usage，默认不改routing rubric或生产代码。公共文档仅摘要，不建eval框架。

- [ ] 先冻结少量中英开发/留出任务、完整task/hash/字节数、oracle、可接受profile集合、基线/候选配置、配对顺序、调用/费用上限。oracle先用人工已知答案和错误答案离线自检，失败答案必须被拒绝；没有完整冻结记录不调用。
- [ ] 基线六个profile统一绑定事先批准的合法model/effort，候选保留自然路由；两个项目正常run且同输入/验收条件。配置与非推理前置检查不等于真实模型授权，模型拒绝时不换模型补跑。
- [ ] 仅在调用、数据和可执行支出边界获准后运行。若冻结N个配对，完整上限是2N个worker、每后端至多2N次分类；额外probe/诊断必须显式占额度。首次真实失败停止整轮对应实验，失败计入、其余配对标未执行，不补齐或隐藏。
- [ ] 分开验收集合匹配、worker质量、模型可用性、时延和费用。missing usage=unreported，子计数不重复累加；账单不可归属则只按授权报告质量/时延，CAL成本问题未关闭。
- [ ] 无必要调规则就不调；若开发集暴露问题，先提新方案/预算，后续使用未调优留出集，不改旧标签/门槛。完整样本也只支持该有限实验，不证明六档全覆盖、最轻充分或一般节省比例。

### S4: Correct-scope historical state reconciliation（META-01…04）

**API/Records:** 原项目`turnhelm/feat-task-entry`四个列表见规格§8；只用受支持work_state接口/明确项目上下文，不修改源代码或数据库。

- [ ] 重新检查实际工具签名/项目定位能力；当前无project参数。若仍不能证明读写目标，结束本次能力调查，保留原同步待办受阻，当前项目只写说明，不向裸旧列表试写。
- [ ] 若获得受支持正确上下文，先保存目标身份/原条目接受依据及非目标有效状态；只关闭已有明确接受依据的记录，无法证明同次dispatch的umbrella标被取代（dropped+依据），不虚构新实现完成。
- [ ] 写后在同一可信项目读includeClosed验证有效投影及非目标未变；旧事件历史doing允许保留，不再作为当前排程。无写后证明不报同步完成，不顺带关闭NAT/JEV/CAL。

## Final verification and handoff

| 规格门槛 | 所属任务/证据 |
| --- | --- |
| N24-01、N24-02 | Tasks1–3：engine/doctor/当前说明一致，旧Node22 leg退役，合成边界+实际24 |
| N24-03、N24-04、N24-05 | Tasks2–3：激活正向对照、TLS、默认并行全量/coverage、完整audit、既有pack安装 |
| NAT-01、NAT-02、NAT-03 | Task3既有初始回归 + S1可信真实来源；核心关闭另有因果证据 |
| JEV-01、JEV-02、JEV-03 | Task3既有传输回归 + S2有限观察；unknown诚实保留，恢复声明按范围 |
| CAL-01、CAL-02、CAL-03、CAL-04 | S3冻结/自检/真实配对/成本范围；未执行或账单不足不关闭 |
| META-01、META-02、META-03、META-04 | S4正确作用域及写后投影；接口不支持则停止并保留待办 |

- [ ] 最终逐项对照规格：代码/文档符合现有接口，无新框架、公开配置、重试、兼容旁路、自动安装、秘密值或历史重写；保留实际执行/退役/受阻/未执行及费用边界。
- [ ] Node-only交付走N24 gate即可；如后续有代码变更，再对该变更运行focused及Node24全量/coverage/audit并按风险复核，不套用此前CI结果。
- [ ] 用户审阅本计划并确认实施范围、执行方法；建议Node工程采用subagent-driven以独立复核版本/代理证据，调查只派明确边界的只读agent。确认之前不开始Task1或真实调用；无需为“收尾”擅自commit/push/merge/清理。

**本轮文档自查范围：**检查任务到规格覆盖、接口/类型、文档链接、命令作用域和最小变更面；不把计划中未运行的命令标通过，不以Astra复核代替运行验收。
