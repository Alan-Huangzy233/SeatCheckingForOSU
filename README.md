# OSU Course Monitor (OSU 选课空位监控脚本)

[English Version Below](#english-version)

这是一个专为 Oregon State University (OSU) 学生设计的自动化选课监控工具。该脚本会持续监控指定课程的座位可用性，并在发现有空位且无选课限制时，自动发送邮件提醒，且**无需登录 OSU 账号**！

---

## 介绍太多看不明白？没关系！Windows用户直接点这个下载，解压，双击start.bat就好！
[可点击这里下载程序压缩包](https://github.com/Alan-Huangzy233/SeatCheckingForOSU/releases/download/SeatChecking-V1/SeatCheckingForOSU.zip)

---

## 核心功能 (Features)

* **小白友好 (Zero-Config):** 告别修改代码！自带交互式命令行向导，启动后根据屏幕提示输入课程号即可，支持无限添加你想监控的课程。
* **一键傻瓜启动 (Auto Setup):** 无论是 Windows 还是 Mac/Linux，只需运行启动脚本，**程序会自动帮你安装 Node.js 和所有运行依赖包**。
* **智能邮箱配置 (Smart Email Wizard):** 首次运行会自动弹出配置向导，一步步引导你填写邮箱信息并自动生成配置文件。
* **自动获取凭证:** 自动模拟浏览器请求获取最新的 Cookie 和 Token，每 5 分钟自动刷新保活，彻底告别手动抓包和 Session 过期。
* **双模式 (Dual Mode):**
  * **网课模式:** 仅监控 Ecampus/Online 课程。
  * **线下课模式:** 仅监控 Corvallis 本校区实体课（自动过滤非 0 开头的 Section，如 Cascades 校区课程）。
* **限制查询 (Restriction Check):** 不仅查空位，还会自动爬取并分析限制页面。如果该课程包含 `Dist. Degree Corvallis Student(DSC)` 或 `Oregon State - Corvallis (C)` 限制，脚本会自动拦截假阳性提醒。

---

## 快速开始 (Getting Started)

### 步骤 1：下载并运行 (Run the Script)
将本项目下载或克隆到本地并解压。
[可点击这里下载程序压缩包](https://github.com/Alan-Huangzy233/SeatCheckingForOSU/releases/download/SeatChecking-V1/SeatCheckingForOSU.zip)
或者访问(https://github.com/Alan-Huangzy233/SeatCheckingForOSU/releases/download/SeatChecking-V1/SeatCheckingForOSU.zip) 进行下载。

请根据你的操作系统直接运行：

**对于 Windows 用户：**
直接双击文件夹中的 `start.bat` 文件。
*(如果弹出 Windows 保护提示，请点击“更多信息” -> “仍要运行”)*

**对于 macOS 和 Linux 用户：**
打开“终端 (Terminal)”，使用 `cd` 命令进入本项目的文件夹，然后直接输入以下命令并回车：

```bash
bash start.sh
```

*(注：如果你的电脑没有 Node.js，该脚本会自动通过 nvm 下载并配置好最新环境！)*
### 步骤 2：准备邮箱授权码 (Prerequisite)
程序会自动帮你搞定所有运行环境，你唯一需要准备的是一个用来发邮件的 Gmail 账号。
同时程序也会指引你完成以下步骤：
由于 Google 的安全政策，你不能直接使用邮箱的日常登录密码。请提前准备好 16 位的**应用专用密码 (App Password)**：
1. 前往 Google 账号安全设置：[点击这里 (Security)](https://myaccount.google.com/intro/security)，开启**“两步验证 (2-Step Verification)”**。
2. 前往应用专用密码页面：[点击这里 (App Passwords)](https://myaccount.google.com/apppasswords)。
3. 生成一个 16 位的 App Password，将其**复制保存**，稍后运行程序时会用到。



### 步骤 3：跟着提示走！
运行脚本后，请选择界面语言。如果是首次运行，程序会：
1. 自动检查并安装所需的运行依赖 (`npm install`)。
2. 引导你粘贴刚才获取的 16 位 Gmail 专用密码，并自动创建配置。
3. 询问你需要监控哪些课程（例如输入 CS, 175, y）。
一切录入完毕后，脚本将自动开始 24 小时无间断监控！

---

## 免责声明与注意事项 (Disclaimer)

* **合理使用 (Acceptable Use):** 目前脚本设置为每 15 秒轮询一次。极高频的请求可能会对学校服务器造成负担，并有触发 OSU IT 部门风控机制（如拉黑 IP 或暂时冻结 ONID 账号）的风险。建议在不需要时关闭终端停止脚本。
* **个人责任:** 本脚本仅供学习和个人辅助使用，不对因使用本脚本造成的任何选课失败或账号问题负责。

---
---

<a name="english-version"></a>

# OSU Course Monitor (English Version)

An automated course registration monitoring tool designed for Oregon State University (OSU) students. This script continuously monitors the seat availability of specified courses and automatically sends an email alert when it finds an open seat with no registration restrictions—**and absolutely no OSU account login required!**

---

## Too much introduction and can't understand? No problem! Windows users, just click here to download, extract, and double-click start.bat. That's it!
[You can click here to download the ZIP file](https://github.com/Alan-Huangzy233/SeatCheckingForOSU/releases/download/SeatChecking-V1/SeatCheckingForOSU.zip)

---

## Features

* **Beginner Friendly (Zero-Config):** No need to edit any code! Features an interactive CLI wizard. Just follow the on-screen prompts to enter your courses. You can add as many courses as you want.
* **One-Click Auto Setup:** Comes with dedicated launcher scripts for Windows, macOS, and Linux that **automatically detect and install Node.js** and all missing dependencies.
* **Smart Email Wizard:** Automatically detects missing configurations on the first run and guides you step-by-step to set up your email alerts.
* **Auto-Refresh Session:** Automatically fetches the latest Cookie and Token, and proactively refreshes them every 5 minutes to prevent session timeouts.
* **Dual Mode:**
  * **Online Mode:** Monitors only Ecampus/Online courses.
  * **Offline Mode:** Monitors only Corvallis main campus in-person classes (automatically filters out Cascades campus courses).
* **Restriction Check:** Goes beyond simply checking seat counts by automatically crawling and analyzing the restrictions page. If the course contains `Dist. Degree Corvallis Student(DSC)` or `Oregon State - Corvallis (C)` restrictions, the script will block the notification to prevent false-positive alerts.

---

## Getting Started

### Step 1: Download and Run
Download or clone this repository and extract it.
[You can click here to download the ZIP file](https://github.com/Alan-Huangzy233/SeatCheckingForOSU/releases/download/SeatChecking-V1/SeatCheckingForOSU.zip)

Or visit (https://github.com/Alan-Huangzy233/SeatCheckingForOSU/releases/download/SeatChecking-V1/SeatCheckingForOSU.zip) to download the ZIP file.

Run the tool based on your OS:

**For Windows Users:**
Simply double-click the `start.bat` file in the folder.
*(If Windows SmartScreen pops up, click "More info" -> "Run anyway")*

**For macOS and Linux Users:**
Open the "Terminal", navigate to the project folder using the `cd` command, and run the following command:

```bash
bash start.sh
```

*(Note: If Node.js is missing, the script will automatically install and configure it via nvm for you!)*

### Step 2: Get your Gmail App Password
The script will handle all environment setups for you. The only thing you need is a Gmail account to send the alerts.

Meanwhile, the start program also contain the following step to guiding you finish your setup.
Due to Google's security policies, you cannot use your regular account password. You must generate a 16-digit App Password beforehand:
1. Go to your Google Account Security: [Click here](https://myaccount.google.com/intro/security) and ensure **"2-Step Verification"** is turned on.
2. Go to App Passwords: [Click here](https://myaccount.google.com/apppasswords).
3. Generate a 16-digit App Password. **Copy it**, you will need to paste it when you run the script.

### Step 3: Follow the Prompts!
After launching the script, select your language. On the first run, the tool will:
1. Automatically check and install required packages (`npm install`).
2. Guide you to paste your 16-digit Gmail App Password and auto-generate the configuration file.
3. Ask you which courses you want to monitor (e.g., CS, 175, y).
Once setup is complete, the script will run continuously in the background!

---

## Disclaimer & Acceptable Use

* **Acceptable Use Policy:** By default, this script polls the server every 15 seconds. Extremely high-frequency requests may put a burden on university servers and risk triggering OSU IT's anti-DDoS/security mechanisms (which could result in IP bans or temporary ONID account suspension). It is highly recommended to close the terminal and stop the script when not needed.
* **Personal Responsibility:** This script is provided for educational purposes and personal assistance only. The author is not responsible for any failed course registrations or account-related issues caused by the use of this script. Use at your own risk.
