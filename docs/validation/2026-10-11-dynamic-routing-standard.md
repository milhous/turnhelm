# 动态 model 路由：标准链路验证摘要

日期：2026-10-11（UTC+8）。结论：**PARTIAL**，不是全部真实付费场景或一般路由质量验收。

## 固定基线与口径

- 代码：`9a484c0f9bb2fcea999ada2c5bb7eb1cff46cc49`；main。
- 实际工具：Node 24.11.0、pnpm 10.12.1、Codex CLI 0.162.0；ChatGPT 登录。
- 用户批准标准链路、隔离消费者和已披露的三个 manifest SHA；本轮最大 9 worker / 14 后端预留。授权不自动延续到下一轮。
- 请求数是客户端尝试，不是服务端接收、完成推理或账单证明；不报告 API 金额或节省。

## 有限结果

| 项目 | 结果 | 解释边界 |
| --- | --- | --- |
| 六组 model/effort 准入 | 全部 PASS | 每例把全部 profile 绑定同一 pair，分类均选 balanced；不是自然选择六档 |
| 未 rebind 的 dual Laya 优先 worker | PASS；一笔 Laya，无 Jev | 只证明这一例的自然默认映射与结果 |
| 本地受控 503 → 实际 Jev | FAIL；无 worker、无输出文件 | Jev attempt 为 request / HTTP null / ETIMEDOUT；根因未知 |
| Jev-only | 未执行 | 首个工程失败后整轮停止，未补跑、未重放 |
| 三项 classifier-only | 合法选择 3/3；预声明 band 匹配 2/3 | 一次/任务，无统计准确率、稳定性或普遍语言结论 |

六组准入为 `gpt-6-luna/low`、`gpt-6.1-sol/medium`、`gpt-6.1-sol/high`、`gpt-6-astra/high`、`gpt-6-astra/xhigh`、`gpt-6-astra/max`。其中 max 写例的合成 `out/summary.json` 独立复核为 `{"count":4,"sum":17}`。

| 预声明任务 | band | 观测 |
| --- | --- | --- |
| Rename the README heading to Turnhelm; change only that line. | fast / balanced | frontier：不匹配 |
| 把 README 的标题改成 Turnhelm，只改这一行。 | fast / balanced | balanced：匹配 |
| Investigate a worker/database race, fix it, and add regression tests. | deep / frontier / frontier_xhigh | frontier：匹配 |

12 例计划、11 例执行：10 工程 PASS、1 FAIL、1 未执行。7 个真实 worker 完成；12 个客户端尝试 = 10 次真实 Laya 分类 + 1 次本地 HTTP503 fixture + 1 次托管 Jev 尝试。实际预留 8 worker / 13 后端（Laya 11、Jev 2）；预留不等于实际调用。

Jev 失败例中：fixture 3ms，托管 attempt 266ms，整例 345ms、CLI/整轮 exit 1。该错误不证明 DNS、代理、TLS、地域、账号或供应商服务的任何一种具体原因。七个成功 worker 整例耗时约 61–94 秒；不得从这些小样本发布 p95、吞吐或性能收益。

## 已做验证与未证明项

- 本轮 prepare 前实际 Node 24 的 test、coverage 各 406/406，失败/取消/跳过均 0，exit 0；行/分支/函数覆盖率 95.11% / 90.12% / 94.82%；依赖审计 `No known vulnerabilities found`。这是当时的记录，不是后续文档或代码修改的重新测试。
- 结束核对 HEAD、冻结源码/dist、manifest、宿主项目 config、消费者输入/指令/config 均未变；工作区干净。owned Laya 服务 SIGINT 正常退出，8765 关闭，parent hosted gate 未打开。
- 没有源码、全局配置、认证、commit/push/merge 修改；未取得全局 auth/config 的逐字节前后快照，不宣称它们被实测为字节一致。
- 当前只读 oracle 只核对 stdout 最后一行，不能排除前面的多余说明；JSON 结果比较还允许多余字段。这是源码核对确认的验收缺口，不是证明真实 worker 已输出了这些内容。
- model/effort 证据仅为冻结 CLI 请求与 journal/receipt 一致性，没有供应商侧解析模型/effort 的独立证明。
- bounded evidence 未保留 worker usage；`classifierUsage=unreported`，`wholeRunUsageScope=unverified`，没有整轮 token/金额/内部请求预算证据。
- 未覆盖复杂业务质量、并发/认证/迁移任务结果、自然六档、Jev 成功 worker、后代秘密隔离或一般成本收益。

## 原始证据的固定引用

私有目录：`/tmp/turnhelm-routing-validation-20261011-hqtKKY`。本文件只持久化有限摘要，不复制原始响应、worker 输出、完整环境或密钥，不修改原始记录。

| 文件 | SHA-256 |
| --- | --- |
| REPORT.md | `9937966aa03f9642b7bfe2e294defa30a3abeb7f3e92d8a93e5f6c519d349025` |
| results.json | `49e65e0a6cd8e7d6a44893c8e7b512f559ad73ea969f7091a70d23b0242e1fa9` |
| seal.json | `a80fa8aa474a02770dde7323f2e385af992c6014b7fa33909f374bbc2f90c5ca` |

临时目录可能被系统清理；摘要及 hash 不替代完整原始证据。下一步见 [可靠性规格](../superpowers/specs/2026-10-11-routing-reliability-design.md)，不自动继续真实调用。
