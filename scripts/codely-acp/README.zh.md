# Codely ACP 图片验证

[English](./README.md)

这是一个独立实验，用于验证已登录的本地 Codely CLI 能否承担图片模型调用。
脚本尚未注册为 Midscene provider，也不会操作浏览器或设备。需要 Node.js、
PATH 中可用的 Codely 和已有登录状态，无需配置 Midscene API Key 或安装工作区
依赖。推理由 Codely 账号对应的远端模型完成，并消耗其额度。

## 正式 provider

Core 现在提供正式的 `codely://acp` 调用分支，不依赖这些早期独立验证脚本。
配置如下：

```bash
export MIDSCENE_MODEL_BASE_URL="codely://acp"
export MIDSCENE_MODEL_NAME="codely-vl"
export MIDSCENE_MODEL_FAMILY="codely-vl"
```

`provider-smoke.mjs` 使用构建后的 core 入口和正常环境变量配置，验证流式
`callAI` 与 `AiLocateElement`：

```bash
pnpm exec nx build @midscene/core
pnpm exec node scripts/codely-acp/provider-smoke.mjs --image screenshot.png
```

该脚本不操作设备。2026-10-16 实测文本流式返回通过（1922 ms），真实 Midscene
流程在之前的 1200×2670 安卓截图上成功定位 TapTap（13509 ms），返回中心
`(459, 1618)`。证据：
`midscene_run/codely-acp/provider-integration-20261016/summary.json`。
运行时与 token 用量限制见中英文模型配置文档。

```bash
# 只检查协议，不发送推理请求。
pnpm exec node scripts/codely-acp/probe.mjs --handshake-only

# 发起两次图片推理，每次使用独立新会话。
pnpm exec node scripts/codely-acp/probe.mjs --model codely-vl --timeout-ms 90000

# 不调用模型的协议与结果校验测试。
pnpm exec node --test scripts/codely-acp/probe.node-test.mjs
```

`--model` 指定 Codely 主模型，该模型必须支持图片输入。脚本通过
`CODELY_ENABLE_VLM=1` 请求直接看图，不调用 `analyze_multimedia`。
CLI 声明支持图片并不代表所选模型一定支持。CLI 仍可能需要正常写入登录和会话
缓存的权限，以及网络访问权限。

脚本创建临时工作目录和可复现的 800×600 PNG，为子进程指定精简系统提示词，
并关闭内置工具、Agent、技能、UPM、hooks、遥测和自动续写。拒绝服务端权限
请求，发现工具调用则判定失败。脚本不编辑已有用户配置和凭据；Codely 仍自行
维护正常的登录和会话状态。

验证内容：

1. ACP v1 握手声明支持图片。
2. 模型定位红色矩形，返回原始图片像素坐标的严格 JSON。提示词不包含答案。
   bbox 四条边与 `[500, 360, 700, 480]` 的偏差均不得超过 20 像素，中心与
   `[600, 420]` 的偏差均不得超过 15 像素，且中心必须处于返回的 bbox 内。
3. 模型对不存在的紫色三角形返回 `found: false`，bbox 和 center 均为 null。
   使用新会话，避免继承上一题的答案。

两次推理都必须以 `stopReason: end_turn` 结束。JSON 无效、Markdown 代码围栏、
坐标尺度错误、超时或校验失败都会以非零状态退出。`--timeout-ms` 分别用于创建
会话和推理请求；握手最多等待 15 秒。首次失败后停止，不自动重试。

证据默认保存在被 Git 忽略的 `midscene_run/codely-acp/<时间戳>-<进程号>/`：

- `fixture.png`：实际发给两次会话的图片。
- `*-request.json`：提示词和图片哈希，不包含图片 base64。
- `*-response.txt`：返回正文，失败时也保留已有的部分正文。
- `protocol.jsonl`：方法名、正文增量和事件类型，不记录凭据、原始 stderr 或推理文本。
- `summary.json`：能力声明、各项检查、耗时与失败状态。CLI stderr 只记录分类。

可以用 `--output DIR` 指定证据目录。通过仅代表该合成图片的协议约定成立，尚不能
证明真实 UI 定位质量、多次运行稳定性、Midscene 模型 family 坐标兼容性、token
成本或完整 provider 集成。

## 首次实测记录

2026-10-16，Codely `1.0.0-rc.60` 配合 `--model codely-vl` 通过全部三项
检查：握手 407 ms、红色矩形推理 2299 ms、不存在目标推理 3739 ms。返回的
bbox 和 center 与预设答案完全一致，不存在目标的坐标均为 null。两次推理都以
`end_turn` 结束，未观察到工具调用。进程总耗时 6616 ms。

本地证据：`midscene_run/codely-acp/2026-10-16T06-59-52-947Z-13525/`。
更早的一次沙箱运行在创建会话阶段出现文件权限错误，尚未进入推理。成功运行具备
正常访问 Codely 会话缓存和网络的权限。上述耗时只描述本次运行。

## 真实截图与 Midscene 原始定位提示词

需要 Node.js 22.13+ 提供 `stripTypeScriptTypes`。以下命令只定位，不会点击或
控制设备：

```bash
pnpm exec node scripts/codely-acp/locate.mjs --image screenshot.png \
  --target 'TapTap 应用图标' --output midscene_run/codely-acp/real-screen

pnpm exec node --test scripts/codely-acp/midscene-locate.node-test.mjs
```

`midscene-locate.mjs` 去除类型和模块语法后，直接执行当前仓库的 TypeScript
提示词生成器、JSON 解析器和坐标转换代码。这是有明确范围的实验加载器，并非
构建后的 Agent 运行时。语言显式设为 Chinese；外部 JSON 修复功能关闭，
格式损坏的 JSON 会失败。没有复制提示词正文或坐标算法。PNG 原样发送，图片
位于用户文本之前。采用 Midscene 默认的 0–1000 归一化 bbox 协议，不据此推断
`codely-vl` 背后的模型 family。

输出包括原始系统和用户提示词、源文件哈希、输入 PNG、模型正文、归一化 bbox，
以及 Midscene 原始转换代码得到的像素中心和矩形。解析无效或目标不存在时失败，
不执行动作。

2026-10-16，连接安卓手机的桌面截图尺寸为 1200×2670。对 TapTap 图标返回
`bbox: [308, 572, 458, 644]`，Midscene 将中心转换为 `(460, 1623)`。
推理耗时 7023 ms。确认手机仍在桌面且分辨率一致后，操作者通过 ADB 在该点
点击一次，前台应用变为 `com.taptap`，动作后截图显示 TapTap 首页。
此次点击由用户明确要求，不是 `locate.mjs` 自动执行的动作。
证据：`midscene_run/codely-acp/android-taptap-20261016/`。
