// checkOnlineAvailability_Multi.js

import fetch from "node-fetch";
import chalk from "chalk";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config({ path: './email_info.env' });

// ================= 配置区域 =================
const TERM = "202603";            // 学期 (如 YYYY+Term, eg. 202603)

// 多课程监控列表
// 你可以在这里无限添加你想监控的课程
const COURSES_TO_MONITOR = [
    { subject: "CS", courseNumber: "312", checkOnlineOnly: true } // 监控 CS 312 网课
    //{ subject: "CS", courseNumber: "175", checkOnlineOnly: true },  // 监控 CS 175 网课
];

// 基础 URL 配置
const BASE_URL = "https://prodapps.isadm.oregonstate.edu/StudentRegistrationSsb/ssb";
const SEARCH_URL = `${BASE_URL}/searchResults/searchResults`;
const START_URL = `${BASE_URL}/classSearch/classSearch`;
const TERM_URL = `${BASE_URL}/term/search?mode=search`;
const RESET_URL = `${BASE_URL}/classSearch/resetDataForm`;
const RESTRICTIONS_URL = `${BASE_URL}/searchResults/getRestrictions`; 

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

let dynamicCookie = "";
let dynamicToken = "";
let lastRefreshTime = 0; // 新增：记录上一次刷新 Token 的时间戳

// ================= 工具函数 =================
// 获取格式化的美西时间 (Pacific Time)
function getPacificTime() {
    return new Date().toLocaleString("zh-CN", { 
        timeZone: "America/Los_Angeles", 
        hour12: false 
    });
}

// ================= 邮件配置 =================
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

const COOLDOWN_MS = 3600_000; // 1 小时冷却
// 为每门课单独记录冷却时间
const lastMailTSMap = new Map(); 

async function sendEmailAlert(courseKey, subject, htmlBody) {
    const now = Date.now();
    const lastTS = lastMailTSMap.get(courseKey) || 0;
    
    if (now - lastTS < COOLDOWN_MS) {
        console.log(chalk.blue(`[${getPacificTime()}] [${courseKey}] 冷却中：距离上次邮件只有 ${((now - lastTS) / 1000).toFixed(1)}s`));
        return;
    }
    
    try {
        const info = await transporter.sendMail({ from: process.env.MAIL_FROM, to: process.env.MAIL_TO, subject, html: htmlBody });
        lastMailTSMap.set(courseKey, now); // 记录这门课的发送时间
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
        
        lastRefreshTime = Date.now(); // 更新最后刷新时间
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

// 接收 subject 和 courseNumber 作为参数
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

// 接收 course 对象作为参数
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

// 顺序轮询所有课程
async function monitorAllCourses() {
    // 1. 每 5 分钟 (300,000 毫秒) 主动刷新一次 Token
    if (Date.now() - lastRefreshTime >= 300_000) {
        console.log(chalk.magenta(`[${getPacificTime()}] 距离上次刷新已达 5 分钟，主动刷新 Session...`));
        await refreshSession();
    }

    console.log(chalk.cyan(`\n--- 开始新一轮全量扫描 (${getPacificTime()}) ---`));
    
    for (const course of COURSES_TO_MONITOR) {
        await checkPerfectSection(course);
        // 为了防止请求过快被服务器断开，每查完一门课稍微等 2 秒
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // 一轮结束后，等待 15 秒再次触发（使用递归 setTimeout 代替 setInterval，防止网络卡顿导致的并发重叠）
    setTimeout(monitorAllCourses, 15_000);
}

// ================= 启动程序 =================
(async () => {
    console.log(chalk.blue(`[${getPacificTime()}] 免责提示：本程序仅用于学习和研究目的，请勿用于任何商业或非法用途。`));
    console.log(chalk.magenta(`[${getPacificTime()}] 启动多课程监控，共监控 ${COURSES_TO_MONITOR.length} 门课程...`));
    await refreshSession();
    await monitorAllCourses(); 
})();