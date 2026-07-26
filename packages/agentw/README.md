# AgentW Edge MVP

AgentW 是面向 Windows 11 和 Microsoft Edge 的本地网页侧边栏 Agent。它复用 Pi 的模型、会话、工具和 Skill 能力，并在侧栏开启后自动同步当前活动的普通 `http/https` 标签页。

## 开发启动

在仓库根目录运行：

```powershell
npm install --ignore-scripts
npm run hydrate:model-data
node packages/agentw/scripts/build.mjs
node packages/agentw/scripts/compile-host.mjs
```

最后一步需要 [Bun](https://bun.sh/)；它会同时生成 `agentw-host.exe` 和 Host 必需的同目录 `pi.exe`。AgentW 默认复用 `~/.pi/agent` 中已有的 Pi 模型登录信息，也可通过 `AGENTW_PI_AGENT_DIR` 指定其他目录。

然后：

1. 打开 `edge://extensions`，启用“开发人员模式”。
2. 选择“加载解压缩的扩展”，加载 `packages/agentw/dist/edge`。
3. 复制 Edge 显示的扩展 ID。
4. 注册当前用户的 Native Host：

```powershell
$agentwExtensionId = Read-Host "Paste the AgentW ID shown by edge://extensions"
.\packages\agentw\scripts\register-native-host.ps1 -ExtensionId $agentwExtensionId
```

不需要管理员权限。更新源码后重新运行构建脚本，并在 `edge://extensions` 中重新加载扩展。

## 本地验收

不要直接通过 `file://` 打开测试页面。在仓库根目录启动本地 HTTP 服务：

```powershell
node packages/agentw/scripts/serve-fixtures.mjs
```

打开 `http://127.0.0.1:4173/shop/page-1.html`，点击 Edge 工具栏中的 AgentW 图标打开侧栏。侧栏宽度由 Edge 自带分隔线调整，可拖到接近网页与 AgentW 各占一半。此后切换普通网页或标签页时，AgentW 会自动同步当前页面。

输入“提取两页商品并生成 Excel”。AgentW 会读取两页、按商品链接去重、生成六列 Excel，并在用户确认下载后删除任务临时文件。

输入“提取商品并写入 Google Sheets”时，AgentW 会打开或复用 Google 表格并尝试把七列商品数据写入 A1。若 Google 要求登录，AgentW 会暂停并让用户亲自完成账号、验证码等登录步骤；登录后告诉 AgentW“继续写入”即可。若 Google Sheets 拒绝扩展发出的自动粘贴事件，数据会保留在剪贴板，侧栏会提示用户点击 A1 后按一次 `Ctrl+V`。

输入“提取所有结果页商品并写入 Google Sheets”时，AgentW 使用批量采集工具在工具内部逐页执行，不把全部商品行放入模型上下文。每页会按商品 URL 去重后追加到任务工作区，结束时生成 `data.json` 下载项，再创建 Google Sheet。默认安全上限是 200 页，可由任务提高到最多 1000 页；遇到空商品页、找不到下一页或页面不再变化时自动停止。商品字段包含名称、包装规格、价格、生产日期、链接、来源页和采集时间。

## Skill 安全边界

设置面板支持 ZIP 或文件夹上传。Skill 必须包含带 `name` 和 `description` frontmatter 的 `SKILL.md`。上传限制为 ZIP 10 MiB、解压后 50 MiB、最多 200 个文件；路径穿越、符号链接和脚本/可执行文件会被拒绝。Skill 变更在下一次新对话中生效。
