// checkOnlineAvailability_Full_CN.js

import fetch from "node-fetch";
import chalk from "chalk";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config({ path: './email_info.env' });

// ================= 配置区域 =================
const TERM = "202603";            // 学期 (如 YYYY+Term, eg. 202603, Fall-01, Winter-02, Spring-03, Summer-04)
const SUBJECT = "CS";             // 科目
const COURSE_NUMBER = "123";      // 课号

// 新增：课程类型模式切换
// true  = 仅监控网课 (Ecampus / Online)
// false = 仅监控线下课 (Corvallis 本校区实体课)
const CHECK_ONLINE_ONLY = false;   

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

// ================= 邮件配置 =================
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

const COOLDOWN_MS = 3600_000; // 1 小时冷却
let lastMailTS = 0;

async function sendEmailAlert(subject, htmlBody) {
    const now = Date.now();
    if (now - lastMailTS < COOLDOWN_MS) {
        console.log(chalk.blue(`冷却中：距离上次邮件只有 ${((now - lastMailTS) / 1000).toFixed(1)}s`));
        return;
    }
    try {
        const info = await transporter.sendMail({ from: process.env.MAIL_FROM, to: process.env.MAIL_TO, subject, html: htmlBody });
        lastMailTS = now;
        console.log(chalk.green(`提醒邮件已发送，MessageID: ${info.messageId}`));
    } catch (err) {
        console.error(chalk.red(`邮件发送失败: ${err.message}`));
    }
}

// ================= 核心逻辑 =================

async function refreshSession() {
    console.log(chalk.blue("正在获取最新的 Cookie 和 Token"));
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
        console.log(chalk.green(`Session 初始化成功! Token: ${dynamicToken.substring(0, 8)}...`));
    } catch (e) {
        console.error(chalk.red(`自动获取凭证失败: ${e.message}`));
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

async function fetchCourseData(isRetry = false) {
    if (!dynamicCookie || !dynamicToken) await refreshSession();
    await resetSearch();

    const params = new URLSearchParams({
        txt_subject: SUBJECT, txt_courseNumber: COURSE_NUMBER, txt_term: TERM,
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
        await refreshSession(); return fetchCourseData(true);
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

async function checkPerfectSection() {
    const modeText = CHECK_ONLINE_ONLY ? "【网课】" : "【线下课】";
    try {
        const json = await fetchCourseData();
        if (!json || !json.success || !json.data) return;

        // 1. 根据模式寻找有座位的课
        const availableCourses = json.data.filter(c => {
            const isOnlineSchedule = c.scheduleTypeDescription === "Online";
            const isEcampus = c.campusDescription && c.campusDescription.includes("Ecampus");
            const isOnlineCourse = isOnlineSchedule || isEcampus;
            
            // 获取 Section 编号 (Banner 系统中通常叫 sequenceNumber)
            const sectionNum = c.sequenceNumber || ""; 

            // 根据 CHECK_ONLINE_ONLY 标志过滤课程
            if (CHECK_ONLINE_ONLY) {
                // 【网课模式】
                if (!isOnlineCourse) return false; 
            } else {
                // 【线下课模式】
                if (isOnlineCourse) return false; // 是网课 -> 剔除
                // 新增：确保线下课的 Section 是以 "0" 开头的 (即 Corvallis 主校区)
                if (!sectionNum.startsWith("0")) return false; 
            }

            // (如果你只想查真实座位，不想查 Waitlist，可以把后面的 || c.waitAvailable > 0 删掉)
            const hasSeats = c.seatsAvailable > 0 || c.waitAvailable > 0; 
            return hasSeats;
        });

        if (availableCourses.length === 0) {
            console.log(chalk.gray(`[${new Date().toLocaleTimeString()}] 扫描 ${SUBJECT} ${COURSE_NUMBER} ${modeText}，暂无空位...`));
            return;
        }

        // 2. 针对有座位的课，进一步检查限制 (黑名单模式)
        const perfectCourses = [];
        
        // 只要 HTML 里出现以下任何一个关键词，该课程就会被拦截
        const restrictionBlacklist = [
            "Dist. Degree Corvallis Student(DSC)",
            "Oregon State - Corvallis (C)"
        ];

        for (const course of availableCourses) {
            try {
                const html = await fetchRestrictions(course.courseReferenceNumber);
                
                let foundRestriction = null;
                for (const keyword of restrictionBlacklist) {
                    if (html.includes(keyword)) {
                        foundRestriction = keyword;
                        break; // 命中黑名单，直接跳出循环
                    }
                }

                if (!foundRestriction) {
                    perfectCourses.push(course); // 既有座，又没有任何黑名单限制！
                } else {
                    console.log(chalk.yellow(`CRN ${course.courseReferenceNumber} 有空位，但被拦截: 检测到 “${foundRestriction}”`));
                }
            } catch (err) {
                console.error(chalk.red(`获取 CRN ${course.courseReferenceNumber} 的限制失败: ${err.message}`));
            }
        }

        // 3. 最终发送邮件
        if (perfectCourses.length > 0) {
            console.log(chalk.green(`发现 ${perfectCourses.length} 个【有空位且无任何限制】的完美 ${modeText} 选项！`));

            let detailsHtml = perfectCourses.map(c => `
                <li style="margin-bottom: 10px;">
                    <b>CRN:</b> ${c.courseReferenceNumber}<br/>
                    <b>Title:</b> ${c.courseTitle}<br/>
                    <b>Type:</b> ${c.scheduleTypeDescription} (${c.campusDescription})<br/>
                    <b>Seats Available:</b> <span style="color:red; font-weight:bold">${c.seatsAvailable} / ${c.maximumEnrollment}</span><br/>
                    <b>Waitlist Available:</b> <span style="color:red; font-weight:bold">${c.waitAvailable}</span>
                </li>
            `).join("");

            const subject = `发现无限制且有空位的 ${SUBJECT} ${COURSE_NUMBER} ${modeText}`;
            const body = `
                <h2>${SUBJECT} ${COURSE_NUMBER} 发现了可以立刻选的 ${modeText} 选项</h2>
                <p>以下 Section 既有空位，也<b>未检测到 DSC 或 Corvallis 本校区限制</b>：</p>
                <ul>${detailsHtml}</ul>
                <p>请尽快注册！</p>
            `;
            await sendEmailAlert(subject, body);
        }

    } catch (error) {
        console.error(chalk.red(`综合检测出错: ${error.message}`));
    }
}

// ================= 启动程序 =================
(async () => {
    const modeText = CHECK_ONLINE_ONLY ? "【网课】" : "【线下课】";
    console.log(chalk.cyan(`开始综合监控 ${SUBJECT} ${COURSE_NUMBER} ${modeText} (空位 + DSC/Campus 限制)...`));
    await refreshSession();
    await checkPerfectSection();
    setInterval(checkPerfectSection, 15_000); 
})();