**OSU Course Monitor (OSU 选课与空位监控脚本)**
这是一个专为 Oregon State University (OSU) 学生设计的自动化选课监控工具。该脚本会持续监控指定课程的座位可用性，并在发现有空位且无选课限制时，自动发送邮件提醒，且**无需登录**！

**核心功能 (Features)**
自动模拟浏览器请求获取最新的 Cookie 和 Token，彻底告别手动抓包。

双模式 (Dual Mode):

网课模式: 仅监控 Ecampus/Online 课程。

线下课模式: 仅监控 Corvallis 本校区实体课（自动过滤非 0 开头的 Section，如 Cascades 校区课程）。

限制查询 (Restriction Check): 不仅查空位，还会自动爬取并分析限制页面。如果该课程包含 Dist. Degree Corvallis Student(DSC) 或 Oregon State - Corvallis (C) 限制，脚本会自动拦截假阳性提醒。

邮件提醒 (Email Alerts): 发现完美选课机会后，第一时间发送带有详细 CRN 和座位信息的邮件。

**快速开始 (Getting Started)**
1. 环境依赖 (Prerequisites)
安装 Node.js (推荐 v16 以上版本)

一个用于发送提醒的邮箱账号（推荐使用 Gmail）

2. 安装 (Installation)
克隆此仓库并安装必要的依赖包：

git clone https://github.com/Alan-Huangzy233/SeatCheckingForOsu.git
cd SeatCheckingForOsu
npm install
(依赖库包括: node-fetch, chalk, nodemailer, dotenv)

3. 配置邮箱 (Email Configuration)
在项目根目录下创建一个名为 email_info.env 的文件，并填入以下内容：

SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=你的发件邮箱@gmail.com
SMTP_PASS=你的专用密码
MAIL_FROM=你的发件邮箱@gmail.com
MAIL_TO=接收提醒的邮箱@xxx.com

如何获取 Gmail 的 SMTP_PASS (App Password):
由于 Google 的安全政策，你不能直接使用邮箱的登录密码。

前往 Google 账号设置：获取 Gmail 应用专用密码

开启“两步验证 (2-Step Verification)”。

生成一个 16 位的 App Password，将其复制并粘贴到 .env 文件的 SMTP_PASS 中（中间不要有空格）。

4. 配置监控课程 (Script Configuration)
打开主脚本文件（如 checkOnlineAvailability_Full.js），在顶部的配置区域修改你想要监控的课程信息：

// ================= 配置区域 =================
const TERM = "202603";            // 学期代码 (如 Spring 2026 为 202603)
const SUBJECT = "CS";             // 科目简称
const COURSE_NUMBER = "312";      // 课号

// 模式切换
// true  = 仅监控网课 (Ecampus)
// false = 仅监控线下课 (Corvallis 本校区)
const CHECK_ONLINE_ONLY = false;  
// ===========================================

5. 运行脚本 (Run)
node checkOnlineAvailability_Full.js
脚本启动后，会在控制台输出当前的监控模式，并默认每隔 15 秒扫描一次 OSU 系统。

**免责声明与注意事项 (Disclaimer)**
合理使用 (Acceptable Use): 目前脚本设置为每 15 秒轮询一次。极高频的请求可能会对学校服务器造成负担，并有触发 OSU IT 部门风控机制（如拉黑 IP 或暂时冻结 ONID 账号）的风险。建议在不需要时停止脚本，或在代码中引入随机休眠时间。

个人责任: 本脚本仅供学习和个人辅助使用，不对因使用本脚本造成的任何选课失败或账号问题负责。
