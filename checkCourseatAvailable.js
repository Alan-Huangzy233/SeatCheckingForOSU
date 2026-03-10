// checkCourseatAvailable.js

import fetch from "node-fetch";
import chalk from "chalk";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import readline from "readline";
import fs from "fs"; // 引入文件系统模块，用于读写 .env 文件

dotenv.config({ path: './email_info.env' });

// ================= 配置区域 =================
const TERM = "202603";            // 学期 (如 YYYY+Term, eg. 202603)

let COURSES_TO_MONITOR = [];
let enableEmailAlerts = true;     // 全局邮件提醒开关

const BASE_URL = "https://prodapps.isadm.oregonstate.edu/StudentRegistrationSsb/ssb";
const SEARCH_URL = `${BASE_URL}/searchResults/searchResults`;
const START_URL = `${BASE_URL}/classSearch/classSearch`;
const TERM_URL = `${BASE_URL}/term/search?mode=search`;
const RESET_URL = `${BASE_URL}/classSearch/resetDataForm`;
const RESTRICTIONS_URL = `${BASE_URL}/searchResults/getRestrictions`; 

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

let dynamicCookie = "";
let dynamicToken = "";
let lastRefreshTime = 0;

// 创建命令行交互接口
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

// ================= 工具函数 =================
function getPacificTime() {
    return new Date().toLocaleString("zh-CN", { 
        timeZone: "America/Los_Angeles", 
        hour12: false 
    });
}

// ================= 邮件配置 =================
let transporter; // 声明在外部，方便重新初始化

// 初始化或重新初始化邮件发送器
function initTransporter() {
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: true,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
}

// 首次启动时初始化
initTransporter();

const COOLDOWN_MS = 3600_000; 
const lastMailTSMap = new Map(); 

// 验证邮件配置
async function verifyEmailConfig() {
    console.log(chalk.blue(`[${getPacificTime()}] 正在验证邮件配置 (email_info.env)...`));
    try {
        await transporter.verify();
        console.log(chalk.green(`[${getPacificTime()}] 邮件配置验证成功！已启用邮件提醒功能。`));
        return true;
    } catch (error) {
        return false;
    }
}

// 动态创建/覆盖 .env 文件功能
// 动态创建/覆盖 .env 文件功能
async function configureEnvFile() {
    console.log(chalk.cyan("\n=== 邮件配置向导 (Email Setup Wizard) ==="));
    console.log(chalk.gray("检测到 email_info.env 缺失或配置错误。现在将引导您进行配置。\n"));
    
    // ----- 引导用户获取 Gmail 专用密码 -----
    console.log(chalk.bgYellow.black(" 【重要提示：如何获取 Gmail 授权码 (App Password)】 "));
    console.log(chalk.white("由于 Google 的安全政策，您不能直接使用邮箱的日常登录密码。请按以下步骤操作："));
    console.log(chalk.white(`1. 开启“两步验证 (2-Step Verification)”：`));
    console.log(`   请按住 Ctrl 键点击 (或复制到浏览器): ${chalk.underline.blueBright('https://myaccount.google.com/intro/security')}`);
    console.log(chalk.white(`2. 获取 Gmail 应用专用密码 (App Password)：`));
    console.log(`   请按住 Ctrl 键点击 (或复制到浏览器): ${chalk.underline.blueBright('https://myaccount.google.com/apppasswords')}`);
    console.log(chalk.white("3. 生成一个 16 位的专用密码，并将其复制。我们稍后会用到它。\n"));
    // ---------------------------------------
    
    // 增加默认值逻辑，提升用户体验
    const hostInput = await askQuestion(chalk.yellow("请输入 SMTP 服务器地址 (直接回车默认 smtp.gmail.com): "));
    const host = hostInput.trim() || "smtp.gmail.com";

    const portInput = await askQuestion(chalk.yellow("请输入 SMTP 端口 (直接回车默认 465): "));
    const port = portInput.trim() || "465";

    const user = await askQuestion(chalk.yellow("请输入你的发件邮箱地址 (例如 xxx@gmail.com): "));
    const pass = await askQuestion(chalk.yellow("请输入你刚刚获取的 16 位专用密码 (直接粘贴): "));
    const mailTo = await askQuestion(chalk.yellow("请输入接收提醒的目标邮箱地址 (可以是同一个邮箱): "));

    const envContent = `SMTP_HOST=${host}\nSMTP_PORT=${port}\nSMTP_USER=${user.trim()}\nSMTP_PASS=${pass.trim()}\nMAIL_FROM=${user.trim()}\nMAIL_TO=${mailTo.trim()}\n`;

    try {
        // 写入本地文件
        fs.writeFileSync('./email_info.env', envContent, { encoding: 'utf8' });
        
        // 强制更新当前运行环境的变量
        process.env.SMTP_HOST = host;
        process.env.SMTP_PORT = port;
        process.env.SMTP_USER = user.trim();
        process.env.SMTP_PASS = pass.trim();
        process.env.MAIL_FROM = user.trim();
        process.env.MAIL_TO = mailTo.trim();

        // 重新初始化 transporter
        initTransporter();
        
        console.log(chalk.green("\n设置成功：email_info.env 文件已自动生成并应用！"));
        return true;
    } catch (err) {
        console.error(chalk.red(`\n写入配置文件失败: ${err.message}`));
        return false;
    }
}

async function sendEmailAlert(courseKey, subject, htmlBody) {
    if (!enableEmailAlerts) return; 

    const now = Date.now();
    const lastTS = lastMailTSMap.get(courseKey) || 0;
    
    if (now - lastTS < COOLDOWN_MS) {
        console.log(chalk.blue(`[${getPacificTime()}] [${courseKey}] 冷却中：距离上次邮件只有 ${((now - lastTS) / 1000).toFixed(1)}s`));
        return;
    }
    
    try {
        const info = await transporter.sendMail({ from: process.env.MAIL_FROM, to: process.env.MAIL_TO, subject, html: htmlBody });
        lastMailTSMap.set(courseKey, now); 
        console.log(chalk.green(`[${getPacificTime()}] [${courseKey}] 提醒邮件已发送，MessageID: ${info.messageId}`));
    } catch (err) {
        console.error(chalk.red(`[${getPacificTime()}] [${courseKey}] 邮件发送失败: ${err.message}`));
    }
}

// ================= 核心逻辑 =================
async function refreshSession() {
    console.log(chalk.blue(`[${getPacificTime()}] 正在获取最新的 Cookie 和 Token`));
    try {
        const res = await fetch(START_URL, { headers: { "User-Agent": USER_AGENT } });
        let cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.raw()['set-cookie'] || []);
        if (cookies.length > 0) dynamicCookie = cookies.map(c => c.split(';')[0]).join('; ');

        const html = await res.text();
        const tokenMatch = html.match(/name="synchronizerToken"\s+content="([^"]+)"/i) || html.match(/content="([^"]+)"\s+name="synchronizerToken"/i);
        if (tokenMatch && tokenMatch[1]) dynamicToken = tokenMatch[1];
        else throw new Error("未找到 synchronizerToken。");

        const termRes = await fetch(TERM_URL, {
            method: "POST",
            headers: {
                "Cookie": dynamicCookie, "X-Synchronizer-Token": dynamicToken,
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": USER_AGENT, "X-Requested-With": "XMLHttpRequest"
            },
            body: new URLSearchParams({ term: TERM }).toString()
        });

        if (!termRes.ok) throw new Error(`绑定学期失败: ${termRes.status}`);
        
        lastRefreshTime = Date.now();
        console.log(chalk.green(`[${getPacificTime()}] Session 初始化成功! Token: ${dynamicToken.substring(0, 8)}...`));
    } catch (e) {
        console.error(chalk.red(`[${getPacificTime()}] 自动获取凭证失败: ${e.message}`));
    }
}

async function resetSearch() {
    try {
        await fetch(RESET_URL, {
            method: "POST",
            headers: {
                "Cookie": dynamicCookie, "X-Synchronizer-Token": dynamicToken,
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": USER_AGENT, "X-Requested-With": "XMLHttpRequest"
            },
            body: ""
        });
    } catch (e) { }
}

async function fetchCourseData(subject, courseNumber, isRetry = false) {
    if (!dynamicCookie || !dynamicToken) await refreshSession();
    await resetSearch();

    const params = new URLSearchParams({
        txt_subject: subject, txt_courseNumber: courseNumber, txt_term: TERM,
        startDatepicker: "", endDatepicker: "", uniqueSessionId: Date.now(),
        pageOffset: "0", pageMaxSize: "50", sortColumn: "subjectDescription", sortDirection: "asc"
    });

    const res = await fetch(`${SEARCH_URL}?${params.toString()}`, {
        method: "GET",
        headers: {
            "accept": "application/json, text/javascript, */*; q=0.01",
            "sec-fetch-mode": "cors", "user-agent": USER_AGENT,
            "x-requested-with": "XMLHttpRequest", "x-synchronizer-token": dynamicToken, "cookie": dynamicCookie
        }
    });

    if ((res.status === 401 || res.status === 403 || res.status === 400) && !isRetry) {
        await refreshSession(); return fetchCourseData(subject, courseNumber, true);
    }
    if (!res.ok) throw new Error(`API HTTP ${res.status}`);
    return await res.json();
}

async function fetchRestrictions(crn, isRetry = false) {
    const res = await fetch(RESTRICTIONS_URL, {
        method: "POST",
        headers: {
            "accept": "text/html, */*; q=0.01", 
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "user-agent": USER_AGENT,
            "x-requested-with": "XMLHttpRequest",
            "x-synchronizer-token": dynamicToken,
            "cookie": dynamicCookie,
            "referer": START_URL 
        },
        body: new URLSearchParams({ term: TERM, courseReferenceNumber: crn }).toString()
    });

    if ((res.status === 401 || res.status === 403 || res.status === 400) && !isRetry) {
        await refreshSession(); return fetchRestrictions(crn, true);
    }
    if (!res.ok) throw new Error(`getRestrictions HTTP ${res.status}`);
    return await res.text();
}

async function checkPerfectSection(course) {
    const { subject, courseNumber, checkOnlineOnly } = course;
    const modeText = checkOnlineOnly ? "【网课】" : "【线下课】";
    const courseKey = `${subject}_${courseNumber}_${checkOnlineOnly ? 'Online' : 'InPerson'}`;
    
    try {
        const json = await fetchCourseData(subject, courseNumber);
        if (!json || !json.success || !json.data) return;

        const availableCourses = json.data.filter(c => {
            const isOnlineSchedule = c.scheduleTypeDescription === "Online";
            const isEcampus = c.campusDescription && c.campusDescription.includes("Ecampus");
            const isOnlineCourse = isOnlineSchedule || isEcampus;
            const sectionNum = c.sequenceNumber || ""; 

            if (checkOnlineOnly) {
                if (!isOnlineCourse) return false; 
            } else {
                if (isOnlineCourse) return false; 
                if (!sectionNum.startsWith("0")) return false; 
            }

            const hasSeats = c.seatsAvailable > 0 || c.waitAvailable > 0; 
            return hasSeats;
        });

        if (availableCourses.length === 0) {
            console.log(chalk.gray(`[${getPacificTime()}] 扫描 ${subject} ${courseNumber} ${modeText}，暂无空位...`));
            return;
        }

        const perfectCourses = [];
        const restrictionBlacklist = [
            "Dist. Degree Corvallis Student(DSC)",
            "Oregon State - Corvallis (C)"
        ];

        for (const c of availableCourses) {
            try {
                const html = await fetchRestrictions(c.courseReferenceNumber);
                let foundRestriction = null;
                for (const keyword of restrictionBlacklist) {
                    if (html.includes(keyword)) {
                        foundRestriction = keyword;
                        break;
                    }
                }

                if (!foundRestriction) {
                    perfectCourses.push(c);
                } else {
                    console.log(chalk.yellow(`[${getPacificTime()}] [${subject} ${courseNumber}] CRN ${c.courseReferenceNumber} 有空位，但被拦截: 检测到 “${foundRestriction}”`));
                }
            } catch (err) {
                console.error(chalk.red(`[${getPacificTime()}] 获取 CRN ${c.courseReferenceNumber} 的限制失败: ${err.message}`));
            }
        }

        if (perfectCourses.length > 0) {
            console.log(chalk.green(`[${getPacificTime()}] [${subject} ${courseNumber}] 发现 ${perfectCourses.length} 个【有空位且无任何限制】的完美 ${modeText} 选项！`));

            let detailsHtml = perfectCourses.map(c => `
                <li style="margin-bottom: 10px;">
                    <b>CRN:</b> ${c.courseReferenceNumber}<br/>
                    <b>Title:</b> ${c.courseTitle}<br/>
                    <b>Type:</b> ${c.scheduleTypeDescription} (${c.campusDescription})<br/>
                    <b>Seats Available:</b> <span style="color:red; font-weight:bold">${c.seatsAvailable} / ${c.maximumEnrollment}</span><br/>
                    <b>Waitlist Available:</b> <span style="color:red; font-weight:bold">${c.waitAvailable}</span>
                </li>
            `).join("");

            const mailSubject = `发现无限制且有空位的 ${subject} ${courseNumber} ${modeText}`;
            const body = `
                <h2>${subject} ${courseNumber} 发现了可以立刻选的 ${modeText} 选项</h2>
                <p>以下 Section 既有空位，也<b>未检测到 DSC 或 Corvallis 本校区限制</b>：</p>
                <ul>${detailsHtml}</ul>
                <p>请尽快前往 <a href="https://prodapps.isadm.oregonstate.edu/StudentRegistrationSsb/ssb/registration#">OSU 选课系统</a> 完成注册！</p>
            `;
            await sendEmailAlert(courseKey, mailSubject, body);
        }

    } catch (error) {
        console.error(chalk.red(`[${getPacificTime()}] [${subject} ${courseNumber}] 检测出错: ${error.message}`));
    }
}

async function monitorAllCourses() {
    if (Date.now() - lastRefreshTime >= 300_000) {
        console.log(chalk.magenta(`[${getPacificTime()}] 距离上次刷新已达 5 分钟，主动刷新 Session...`));
        await refreshSession();
    }

    console.log(chalk.cyan(`\n--- 开始新一轮全量扫描 (${getPacificTime()}) ---`));
    
    for (const course of COURSES_TO_MONITOR) {
        await checkPerfectSection(course);
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    setTimeout(monitorAllCourses, 15_000);
}

// ================= 交互录入与启动程序 =================
async function setupCoursesInteractively() {
    console.log(chalk.cyan(`\n=== 欢迎使用 OSU 选课监控助手 ===`));
    let addMore = true;

    while (addMore) {
        console.log(chalk.gray(`\n[录入第 ${COURSES_TO_MONITOR.length + 1} 门课程]`));
        
        const subject = await askQuestion(chalk.yellow("请输入 Subject (例如 CS, MTH): "));
        const courseNumber = await askQuestion(chalk.yellow("请输入 Course Number (例如 123, 456): "));
        const onlineInput = await askQuestion(chalk.yellow("是否只监控网课？(y/n，直接回车默认 y): "));
        
        const checkOnlineOnly = onlineInput.trim().toLowerCase() !== 'n';

        COURSES_TO_MONITOR.push({
            subject: subject.trim().toUpperCase(),
            courseNumber: courseNumber.trim(),
            checkOnlineOnly: checkOnlineOnly
        });

        const moreInput = await askQuestion(chalk.green("\n是否继续添加其他监控课程？(y/n，直接回车默认 n): "));
        addMore = moreInput.trim().toLowerCase() === 'y';
    }
}

// ================= 程序入口 =================
(async () => {
    console.log(chalk.blue(`[${getPacificTime()}] 免责提示：本程序仅用于学习和研究目的，请勿用于任何商业或非法用途。`));
    
    // 1. 启动时先验证邮箱配置
    let emailOk = await verifyEmailConfig();
    
    // 如果失败，抛出带选项的菜单
    if (!emailOk) {
        console.log(chalk.bgRed.white("\n 警告: 邮件配置验证失败 (可能未配置 email_info.env 或账号密码错误) "));
        console.log("请选择后续操作：");
        console.log("  [1] 在【无邮件提醒】的情况下继续运行 (仅在屏幕显示提示)");
        console.log("  [2] 现在设置邮件配置 (将引导您创建 .env 文件)");
        console.log("  [3] 退出程序");
        
        const ans = await askQuestion(chalk.yellow("\n请输入您的选择 (1/2/3): "));
        
        if (ans.trim() === '1') {
            enableEmailAlerts = false;
            console.log(chalk.magenta(`\n[${getPacificTime()}] 已选择继续运行。程序检测到空位时将【仅在控制台显示】，不会发送邮件。`));
        } else if (ans.trim() === '2') {
            // 调用环境向导创建文件
            const configSuccess = await configureEnvFile();
            if (configSuccess) {
                // 再次验证
                const reVerify = await verifyEmailConfig();
                if (!reVerify) {
                    console.log(chalk.red(`\n[${getPacificTime()}] 设置后仍然验证失败，程序将退出，请检查您输入的账号和授权码是否正确。`));
                    rl.close();
                    process.exit(1);
                }
            } else {
                rl.close();
                process.exit(1);
            }
        } else {
            console.log(chalk.red(`\n[${getPacificTime()}] 程序已退出。`));
            rl.close();
            process.exit(0);
        }
    }

    // 2. 启动交互式引导录入课程
    await setupCoursesInteractively();
    rl.close(); // 录入完毕，关闭输入流

    if (COURSES_TO_MONITOR.length === 0) {
        console.log(chalk.red("未添加任何课程，程序退出。"));
        return;
    }

    // 3. 正式启动监控
    console.log(chalk.magenta(`\n[${getPacificTime()}] 录入完毕！启动多课程监控，共监控 ${COURSES_TO_MONITOR.length} 门课程...`));
    await refreshSession();
    await monitorAllCourses(); 
})();