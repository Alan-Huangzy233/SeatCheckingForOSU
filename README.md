# OSU Course Monitor (OSU 选课空位监控脚本)

[English Version Below](#english-version)

这是一个专为 Oregon State University (OSU) 学生设计的自动化选课监控工具。该脚本会持续监控指定课程的座位可用性，并在发现有空位且无选课限制时，自动发送邮件提醒，且**无需登录OSU账号**！

## 核心功能 (Features)

* **自动获取前置所需信息:** 自动模拟浏览器请求获取最新的 Cookie 和 Token，彻底告别手动抓包。
* **双模式 (Dual Mode):**
  * **网课模式:** 仅监控 Ecampus/Online 课程。
  * **线下课模式:** 仅监控 Corvallis 本校区实体课（自动过滤非 0 开头的 Section，如 Cascades 校区课程）。
* **限制查询 (Restriction Check):** 不仅查空位，还会自动爬取并分析限制页面。如果该课程包含 `Dist. Degree Corvallis Student(DSC)` 或 `Oregon State - Corvallis (C)` 限制，脚本会自动拦截假阳性提醒。
* **邮件提醒 (Email Alerts):** 发现目标课程有空位后，第一时间发送带有详细 CRN 和座位信息的邮件。

---

## 快速开始 (Getting Started)

### 1. 环境依赖 (Prerequisites)
* 安装 [Node.js](https://nodejs.org/zh-cn/download) (推荐 v16 以上版本)
* 一个用于发送提醒的邮箱账号（推荐使用 Gmail）

### 2. 安装 (Installation)
克隆此仓库并安装必要的依赖包：

```bash
git clone https://github.com/Alan-Huangzy233/SeatCheckingForOsu.git
cd SeatCheckingForOsu
npm install
```
*(依赖库包括: `node-fetch`, `chalk`, `nodemailer`, `dotenv`)*

### 3. 配置邮箱 (Email Configuration)
在项目根目录下创建一个名为 `email_info.env` 的文件，并填入以下内容：

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=[替换为你的发件邮箱@gmail.com
SMTP_PASS=[替换为你的专用密码]
MAIL_FROM=[替换为你的发件邮箱]@gmail.com
MAIL_TO=[替换为接收提醒的邮箱]@xxx.com
```

**如何获取 Gmail 的 SMTP_PASS (App Password):**
由于 Google 的安全政策，你不能直接使用邮箱的登录密码。
1. 前往 Google 账号设置：[管理你的账号](https://myaccount.google.com/intro/security)或直接直接前往网站(https://myaccount.google.com/intro/security)开启“两步验证 (2-Step Verification)”。
2. 前往 Google 账号设置：[获取 Gmail 应用专用密码](https://myaccount.google.com/apppasswords) 或直接直接前往网站(https://myaccount.google.com/apppasswords)
3. 生成一个 16 位的 App Password，将其复制并粘贴到 `.env` 文件的 `SMTP_PASS` 中。

### 4. 配置监控课程 (Script Configuration)
打开主脚本文件（如 `checkOnlineAvailability_Full.js`），在顶部的配置区域修改你想要监控的课程信息：

```javascript
// ================= 配置区域 =================
// 学期代码 (如 Fall 2026 为 202601，Winter 2026 为 202602，Spring 2026 为 202603，Summer 2026 为 202604) 
const TERM = "202603";

// 科目简称: SUBJECT = "CS";
// 课号: COURSE_NUMBER = "123";
// 模式切换
// true  = 仅监控网课 (Ecampus)
// false = 仅监控线下课 (Corvallis 本校区)
const COURSES_TO_MONITOR = [
    { subject: "CS", courseNumber: "123", checkOnlineOnly: false },
    { subject: "CS", courseNumber: "456", checkOnlineOnly: true },
];
// ===========================================
```

### 5. 运行脚本 (Run)
```bash
node checkCourseatAvailable.js
```
脚本启动后，会在控制台输出当前的监控模式，并默认每隔 15 秒扫描一次 OSU 系统。

---

## 免责声明与注意事项 (Disclaimer)

* **合理使用 (Acceptable Use):** 目前脚本设置为每 15 秒轮询一次。极高频的请求可能会对学校服务器造成负担，并有触发 OSU IT 部门风控机制（如拉黑 IP 或暂时冻结 ONID 账号）的风险。建议在不需要时停止脚本，或在代码中引入随机休眠时间。
* **个人责任:** 本脚本仅供学习和个人辅助使用，不对因使用本脚本造成的任何选课失败或账号问题负责。

---
---

<a name="english-version"></a>

# OSU Course Monitor (English Version)

An automated course registration monitoring tool designed for Oregon State University (OSU) students. This script continuously monitors the seat availability of specified courses and automatically sends an email alert when it finds an open seat with no registration restrictions—**and absolutely no OSU account login required!**

## Features

* **Automatically obtain the required information in advance:** Automatically simulates browser requests to fetch the latest Cookie and Token. Say goodbye to manual packet sniffing.
* **Dual Mode:**
  * **Online Mode:** Monitors only Ecampus/Online courses.
  * **Offline Mode:** Monitors only Corvallis main campus in-person classes (automatically filters out non-`0` starting sections to exclude Cascades campus courses).
* **Restriction Check:** Goes beyond simply checking seat counts by automatically crawling and analyzing the restrictions page. If the course contains `Dist. Degree Corvallis Student(DSC)` or `Oregon State - Corvallis (C)` restrictions, the script will block the notification to prevent false-positive alerts.
* **Email Alerts:** Sends an email with detailed CRN and seat information immediately upon it is discovered that there are vacancies in the target course.

---

## Getting Started

### 1. Prerequisites
* [Node.js](https://nodejs.org/en/download) (v16 or higher recommended)
* An email account used to send the alerts (Gmail is highly recommended)

### 2. Installation
Clone this repository and install the necessary dependencies:

```bash
git clone https://github.com/Alan-Huangzy233/SeatCheckingForOsu.git
cd SeatCheckingForOsu
npm install
```
*(Dependencies include: `node-fetch`, `chalk`, `nodemailer`, `dotenv`)*

### 3. Email Configuration
Create a file named `email_info.env` in the root directory of the project and add the following content:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=[Change to your_sender_email]@gmail.com
SMTP_PASS=[Change to your_app_password]
MAIL_FROM=[Change to your_sender_email]@gmail.com
MAIL_TO=[Change to your_receiving_email]@example.com
```

**How to get the Gmail `SMTP_PASS` (App Password):**
Due to Google's security policies, you cannot use your regular account password.
1. Go to your Google Account Management: [Manage your account](https://myaccount.google.com/intro/security). Ensure that "Google 2-Step Verification" is turned on.
2. Go to your Google Account Settings: [App Passwords](https://myaccount.google.com/apppasswords).
3. Generate a 16-digit App Password. Copy and paste it into the `SMTP_PASS` field in your `.env` file.

### 4. Script Configuration
Open the main script file (e.g., `checkOnlineAvailability_Full.js`) and modify the target course information in the top configuration area:

```javascript
// ================= Configuration Area =================
// Term code (e.g., Fall 2026 is 202601，Winter 2026 is 202602，Spring 2026 is 202603，Summer 2026 is 202604) 
const TERM = "202603";

// Subject code: SUBJECT = "CS";
// Course number: COURSE_NUMBER = "123";
// Mode Toggle
// true  = Monitor Online courses only (Ecampus)
// false = Monitor Offline courses only (Corvallis main campus)
const COURSES_TO_MONITOR = [
    { subject: "CS", courseNumber: "123", checkOnlineOnly: false },
    { subject: "CS", courseNumber: "456", checkOnlineOnly: true },

];
// ======================================================
```

### 5. Run the Script
```bash
node ENcheckCourseSeatAvailable.js
```
Once started, the script will output the current monitoring mode to the console and begin scanning the OSU system every 15 seconds by default.

---

## Disclaimer & Acceptable Use

* **Acceptable Use Policy:** By default, this script polls the server every 15 seconds. Extremely high-frequency requests may put a burden on university servers and risk triggering OSU IT's anti-DDoS/security mechanisms (which could result in IP bans or temporary ONID account suspension). It is highly recommended to stop the script when not needed, or manually introduce a random sleep/delay mechanism in the code to mimic human behavior.
* **Personal Responsibility:** This script is provided for educational purposes and personal assistance only. The author is not responsible for any failed course registrations or account-related issues caused by the use of this script. Use at your own risk.
