# 安装与故障排查

## 开始前

安装并登录自己的 Codex 桌面应用。Monkex 不捆绑 Codex，不提供账号或额外额度。从 [公开 Releases](https://github.com/zxzin/Monkex/releases)选择匹配系统和架构的附件，阅读 Preview 限制，核对 SHA256SUMS.txt。

macOS 可运行 shasum -a 256 文件路径；Windows PowerShell 可运行 Get-FileHash -Algorithm SHA256 文件路径。比较完整文件名与哈希。哈希验证文件完整性，不替代发行者身份判断。

## macOS Apple Silicon

下载 Monkex-macOS-arm64.zip，解压完整 Monkex.app，复制到 ~/Applications 或系统“应用程序”。升级前正常退出旧版并保留旧应用备份，保留用户数据。双击启动，主屏工作区右下角出现香蕉树；运行时不显示 Dock 图标。右键香蕉树选择“退出 Monkex”。

当前预览包为 ad-hoc 签名，未进行 Apple 公证。核验来源和哈希后，由用户通过系统界面决定是否允许打开；不要关闭安全防护或自动删除隔离属性。

## Windows x64

下载 Monkex-Windows-x64-setup.exe，双击进行当前用户安装；WebView2 缺失时安装器会尝试联网补齐。之后从开始菜单打开 Monkex，主屏工作区右下角出现香蕉树，窗口不占任务栏。整棵树按住拖动、轻点展开；右键香蕉树选择“退出 Monkex”。

未签名包可能触发 SmartScreen，由用户核验来源并决定。真实 Codex 跳转和已读同步需要在实际电脑验证，CI 通过不等于完整真机验收。

Intel Mac、Windows ARM64 与 Linux 当前没有对应附件，请暂停安装。

## 连接自己的 Codex

Monkex 从本机 Codex 可执行程序启动观察连接，使用当前用户已有 CODEX_HOME；未设置时使用默认目录。凭据由 Codex 管理，无需作者账号。独立用户目录不继承作者数据；同一个用户共享不同账号历史时，Monkex 不做云账号级二次分离。

看板直接显示 Codex 已有任务标题与进展文字，不额外发起模型生成请求。

## 看板为空或无法连接

- 先确认 Codex 自己可正常使用，等待首次加载；没有历史任务时空看板正常。
- 核对当前用户与 CODEX_HOME 是否一致，不要为排障删除历史。
- 检查 127.0.0.1:8766 是否被其他程序占用；先查归属，不盲目结束进程。
- 非标准路径可为 Monkex 设置 MONKEX_CODEX_PATH，指向支持 app-server --listen stdio:// 的完整可执行文件。Windows 使用原生 .exe，不用 WSL 路径或 .cmd 包装器。
- 未知周额度显示破折号；没有已观测 Token 消耗时金币停止。

## 跳转与已读

Codex 必须注册 codex://threads/… 处理器。系统接受 URL 只表示派发，应确认原任务实际显示。请挑选一个任务测试，不批量点击清空未读。

Codex 内部已读同步使用当前本地记录格式。首次未观察到未读、不支持的格式、远程设备或结果版本变化时保留原状态；不会用鼠标停留、窗口标题或修改时间猜测阅读。

## 卸载与升级

正常退出后移除明确的应用文件或运行 Windows 卸载器。保留 Monkex 用户数据可在重装后保留已读记录；清理数据前单独确认并备份，始终保留 Codex 数据。当前没有自动更新、开机自启或云备份。
