// checkCourseatAvailable.js

import fetch from "node-fetch";
import chalk from "chalk";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import readline from "readline";
import fs from "fs";

// ================= 环境配置加载 =================
dotenv.config({ path: "./email_info.env" });
dotenv.config({ path: "./user_info.env" });

// ================= 全局变量配置 =================
let TERM = "";
let COURSES_TO_MONITOR = [];
let enableEmailAlerts = true;
let enableAutoRegister = false;

let USER_COOKIE = process.env.USER_COOKIE || "";
let USER_TOKEN = process.env.USER_TOKEN || "";
let USER_SESSION_ID = process.env.USER_SESSION_ID || "";

const successfullyRegisteredCRNs = new Set();

const BASE_URL = "https://prodapps.isadm.oregonstate.edu/StudentRegistrationSsb/ssb";
const SEARCH_URL = `${BASE_URL}/searchResults/searchResults`;
const START_URL = `${BASE_URL}/classSearch/classSearch`;
const TERM_SELECTION_URL = `${BASE_URL}/term/termSelection?mode=search`;
const TERM_URL = `${BASE_URL}/term/search?mode=search`;
const GET_TERMS_URL = `${BASE_URL}/classSearch/getTerms`;
const RESET_URL = `${BASE_URL}/classSearch/resetDataForm`;
const RESTRICTIONS_URL = `${BASE_URL}/searchResults/getRestrictions`;
const ENROLLMENT_INFO_URL = `${BASE_URL}/searchResults/getEnrollmentInfo`;
const OSU_CLASSES_DETAILS_URL = "https://classes.oregonstate.edu/api/?page=fose&route=details";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const DEBUG_HTTP = true;

// ================= Cookie / Debug 辅助函数 =================
function getSetCookieValues(res) {
    if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
    if (typeof res.headers.raw === "function") return res.headers.raw()["set-cookie"] || [];
    const single = res.headers.get("set-cookie");
    return single ? [single] : [];
}

function mergeCookieStrings(existingCookieStr, setCookieHeaders) {
    const jar = new Map();

    for (const part of (existingCookieStr || "").split(";")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const name = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (name) jar.set(name, value);
    }

    for (const sc of setCookieHeaders || []) {
        const firstPart = String(sc).split(";")[0].trim();
        if (!firstPart) continue;
        const eq = firstPart.indexOf("=");
        if (eq === -1) continue;
        const name = firstPart.slice(0, eq).trim();
        const value = firstPart.slice(eq + 1).trim();
        if (name) jar.set(name, value);
    }

    return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorbUserCookiesFromResponse(res, label = "") {
    const setCookies = getSetCookieValues(res);
    if (setCookies.length > 0) {
        USER_COOKIE = mergeCookieStrings(USER_COOKIE, setCookies);
        if (DEBUG_HTTP) console.log(chalk.gray(`[COOKIE JAR] ${label} 收到 ${setCookies.length} 个 Set-Cookie，已合并进私人会话。`));
    }
}

let dynamicCookie = "";
let dynamicToken = "";
let lastRefreshTime = 0;

function absorbDynamicCookiesFromResponse(res, label = "") {
    const setCookies = getSetCookieValues(res);
    if (setCookies.length > 0) {
        dynamicCookie = mergeCookieStrings(dynamicCookie, setCookies);
        if (DEBUG_HTTP) console.log(chalk.gray(`[DYNAMIC COOKIE] ${label} 收到 ${setCookies.length} 个 Set-Cookie，已合并进搜索会话。`));
    }
}

async function debugResponse(label, res, maxBody = 1000) {
    if (!DEBUG_HTTP) return;

    const location = res.headers.get("location");
    const contentType = res.headers.get("content-type");

    console.log(chalk.yellow(`\n[DEBUG:${label}] status = ${res.status} ${res.statusText}`));
    console.log(chalk.yellow(`[DEBUG:${label}] url = ${res.url}`));
    console.log(chalk.yellow(`[DEBUG:${label}] redirected = ${res.redirected}`));
    console.log(chalk.yellow(`[DEBUG:${label}] location = ${location || "<none>"}`));
    console.log(chalk.yellow(`[DEBUG:${label}] content-type = ${contentType || "<none>"}`));

    const safeHeaders = {};
    for (const [k, v] of res.headers.entries()) {
        if (["set-cookie", "cookie", "x-synchronizer-token", "authorization"].includes(k.toLowerCase())) {
            safeHeaders[k] = "<hidden>";
        } else {
            safeHeaders[k] = v;
        }
    }
    console.log(chalk.gray(`[DEBUG:${label}] headers = ${JSON.stringify(safeHeaders, null, 2)}`));

    try {
        const text = await res.clone().text();
        console.log(chalk.gray(`[DEBUG:${label}] body preview:\n${text.slice(0, maxBody)}\n`));
    } catch (err) {
        console.log(chalk.red(`[DEBUG:${label}] body 无法读取: ${err.message}`));
    }
}

function tryParseJson(text, label = "JSON") {
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${label} 解析失败，服务器返回的不是合法 JSON。`);
    }
}

function findCrnErrors(payload, crn) {
    const candidates = [
        payload?.data?.crnErrors,
        payload?.crnErrors,
        payload?.errors?.crnErrors,
        payload?.data?.errors?.crnErrors
    ];

    for (const arr of candidates) {
        if (Array.isArray(arr)) {
            const hit = arr.find(e => String(e.courseReferenceNumber) === String(crn));
            if (hit) return hit;
        }
    }
    return null;
}

function getPacificTime() {
    return new Date().toLocaleString("zh-CN", {
        timeZone: "America/Los_Angeles",
        hour12: false
    });
}

function generateSearchSessionId() {
    return Math.random().toString(36).slice(2, 7) + Date.now();
}

function isSearchSessionReady() {
    return Boolean(dynamicCookie && dynamicToken && TERM);
}

function toIntOrNull(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text || text.toLowerCase().includes("varies")) return null;
    const cleaned = text.replace(/[^\d-]/g, "");
    if (cleaned === "") return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
}

function isRealNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function displayValue(value) {
    const parsed = toIntOrNull(value);
    return isRealNumber(parsed) ? String(parsed) : "未知";
}

function extractNumberFromHtmlByLabels(html, labels) {
    const normalizedHtml = String(html).replace(/\r?\n/g, " ").replace(/\s+/g, " ");

    for (const label of labels) {
        const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const tdRegex = new RegExp(
            `<t[dh][^>]*>\\s*${escapedLabel}\\s*:?\\s*<\\/t[dh]>\\s*<t[dh][^>]*>\\s*([\\d-]+)\\s*<\\/t[dh]>`,
            "i"
        );
        const tdMatch = normalizedHtml.match(tdRegex);
        if (tdMatch) return toIntOrNull(tdMatch[1]);
    }

    const text = normalizedHtml
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ");

    for (const label of labels) {
        const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const textRegex = new RegExp(`${escapedLabel}\\s*:?\\s*([\\d-]+)`, "i");
        const textMatch = text.match(textRegex);
        if (textMatch) return toIntOrNull(textMatch[1]);
    }

    return null;
}

// ================= Readline =================
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = query => new Promise(resolve => rl.question(query, resolve));

async function askWithBack(questions) {
    const answers = [];
    let i = 0;

    while (i < questions.length) {
        let promptText = questions[i].prompt;
        if (i > 0) promptText = chalk.gray("[输入 '-' 返回] ") + promptText;

        let ans = await askQuestion(promptText);
        ans = ans.trim();

        if (ans === "-" && i > 0) {
            i--;
            continue;
        }
        if (ans === "-" && i === 0) {
            console.log(chalk.red("当前已经是第一题了！"));
            continue;
        }

        if (questions[i].validate && !questions[i].validate(ans)) continue;

        answers[i] = ans;
        i++;
    }

    return answers;
}

// ================= 模块 1: 邮件系统 =================
let transporter;

function initTransporter() {
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: true,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
}

initTransporter();

const COOLDOWN_MS = 3600_000;
const lastMailTSMap = new Map();

function isValidEmailAddress(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function isValidSmtpPort(port) {
    const num = Number(port);
    return Number.isInteger(num) && num > 0 && num <= 65535;
}

function explainEmailVerifyError(error) {
    const code = error?.code || "";
    const command = error?.command || "";
    const response = error?.response || "";
    const message = error?.message || "";

    const full = `${code} ${command} ${response} ${message}`.toLowerCase();

    if (full.includes("eaia_again") || full.includes("enotfound") || full.includes("getaddrinfo")) {
        return "SMTP 服务器地址无法解析。请检查 SMTP_HOST 是否正确，例如 Gmail 通常是 smtp.gmail.com。";
    }

    if (full.includes("econnrefused")) {
        return "SMTP 服务器拒绝连接。请检查 SMTP_HOST 和 SMTP_PORT 是否正确。";
    }

    if (full.includes("etimedout") || full.includes("timeout")) {
        return "连接 SMTP 服务器超时。请检查网络、防火墙、代理/VPN，或端口是否被阻断。";
    }

    if (full.includes("self signed") || full.includes("certificate") || full.includes("tls")) {
        return "TLS/SSL 证书验证失败。请确认端口和 secure 设置匹配，Gmail 常用 465 且 secure=true。";
    }

    if (
        full.includes("invalid login") ||
        full.includes("auth") ||
        full.includes("535") ||
        full.includes("username and password not accepted")
    ) {
        return "邮箱认证失败。Gmail 不能使用普通登录密码，通常需要使用 16 位 App Password。请确认 SMTP_USER 和 SMTP_PASS。";
    }

    if (full.includes("missing credentials")) {
        return "缺少邮箱登录凭证。请确认 SMTP_USER 和 SMTP_PASS 已填写。";
    }

    return `未知邮件配置错误：${message || response || code || "没有更多错误信息"}`;
}

function validateEmailConfigValues({ host, port, user, pass, mailTo }) {
    const errors = [];

    if (!host || !String(host).trim()) {
        errors.push("SMTP 服务器地址不能为空。");
    }

    if (!isValidSmtpPort(port)) {
        errors.push("SMTP 端口必须是 1 到 65535 之间的数字。");
    }

    if (!isValidEmailAddress(user)) {
        errors.push("发件邮箱格式不正确。");
    }

    if (!pass || !String(pass).trim()) {
        errors.push("邮箱授权码/密码不能为空。");
    }

    if (!isValidEmailAddress(mailTo)) {
        errors.push("收件邮箱格式不正确。");
    }

    return errors;
}

async function verifyEmailConfig() {
    console.log(chalk.blue(`[${getPacificTime()}] 正在验证邮件配置 (email_info.env)...`));

    const currentConfig = {
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        mailTo: process.env.MAIL_TO
    };

    const validationErrors = validateEmailConfigValues(currentConfig);

    if (validationErrors.length > 0) {
        console.log(chalk.red(`[${getPacificTime()}] 邮件配置格式检查失败：`));
        for (const err of validationErrors) {
            console.log(chalk.red(`  - ${err}`));
        }
        return false;
    }

    try {
        initTransporter();
        await transporter.verify();
        console.log(chalk.green(`[${getPacificTime()}] 邮件配置验证成功！已启用邮件提醒功能。`));
        return true;
    } catch (error) {
        console.log(chalk.red(`[${getPacificTime()}] 邮件配置验证失败。`));
        console.log(chalk.red(`原因：${explainEmailVerifyError(error)}`));

        if (DEBUG_HTTP) {
            console.log(chalk.gray(`[DEBUG] Nodemailer error code: ${error?.code || "<none>"}`));
            console.log(chalk.gray(`[DEBUG] Nodemailer command: ${error?.command || "<none>"}`));
            console.log(chalk.gray(`[DEBUG] Nodemailer response: ${error?.response || "<none>"}`));
        }

        return false;
    }
}

async function configureEnvFile() {
    console.log(chalk.cyan("\n=== 邮件配置向导 ==="));
    console.log(chalk.gray("如果使用 Gmail，请使用 16 位 App Password，不要使用普通登录密码。"));
    console.log(chalk.gray("Gmail App Password 教程：https://github.com/Alan-Huangzy233/SeatCheckingForOSU#%E6%AD%A5%E9%AA%A4-2%E5%87%86%E5%A4%87%E9%82%AE%E7%AE%B1%E6%8E%88%E6%9D%83%E7%A0%81-prerequisite\n"));

    const envQs = [
        {
            prompt: chalk.yellow("请输入 SMTP 服务器地址 (直接回车默认 smtp.gmail.com): "),
            validate: () => true
        },
        {
            prompt: chalk.yellow("请输入 SMTP 端口 (直接回车默认 465): "),
            validate: ans => {
                const value = ans.trim() || "465";
                if (isValidSmtpPort(value)) return true;
                console.log(chalk.red("SMTP 端口必须是 1 到 65535 之间的数字。"));
                return false;
            }
        },
        {
            prompt: chalk.yellow("请输入你的发件邮箱地址: "),
            validate: ans => {
                if (isValidEmailAddress(ans)) return true;
                console.log(chalk.red("发件邮箱格式不正确，请重新输入。"));
                return false;
            }
        },
        {
            prompt: chalk.yellow("请输入邮箱授权码/密码: "),
            validate: ans => {
                if (ans.trim().length > 0) return true;
                console.log(chalk.red("邮箱授权码/密码不能为空。"));
                return false;
            }
        },
        {
            prompt: chalk.yellow("请输入接收提醒的目标邮箱: "),
            validate: ans => {
                if (isValidEmailAddress(ans)) return true;
                console.log(chalk.red("收件邮箱格式不正确，请重新输入。"));
                return false;
            }
        }
    ];

    const answers = await askWithBack(envQs);

    const host = answers[0] || "smtp.gmail.com";
    const port = answers[1] || "465";
    const user = answers[2];
    const pass = answers[3];
    const mailTo = answers[4];

    const validationErrors = validateEmailConfigValues({ host, port, user, pass, mailTo });

    if (validationErrors.length > 0) {
        console.log(chalk.red("\n邮件配置未通过本地格式检查："));
        for (const err of validationErrors) {
            console.log(chalk.red(`  - ${err}`));
        }
        return false;
    }

    const oldEnv = {
        SMTP_HOST: process.env.SMTP_HOST,
        SMTP_PORT: process.env.SMTP_PORT,
        SMTP_USER: process.env.SMTP_USER,
        SMTP_PASS: process.env.SMTP_PASS,
        MAIL_FROM: process.env.MAIL_FROM,
        MAIL_TO: process.env.MAIL_TO
    };

    process.env.SMTP_HOST = host;
    process.env.SMTP_PORT = port;
    process.env.SMTP_USER = user;
    process.env.SMTP_PASS = pass;
    process.env.MAIL_FROM = user;
    process.env.MAIL_TO = mailTo;

    initTransporter();

    try {
        await transporter.verify();
    } catch (error) {
        process.env.SMTP_HOST = oldEnv.SMTP_HOST;
        process.env.SMTP_PORT = oldEnv.SMTP_PORT;
        process.env.SMTP_USER = oldEnv.SMTP_USER;
        process.env.SMTP_PASS = oldEnv.SMTP_PASS;
        process.env.MAIL_FROM = oldEnv.MAIL_FROM;
        process.env.MAIL_TO = oldEnv.MAIL_TO;
        initTransporter();

        console.log(chalk.red("\n邮件配置未保存，因为 SMTP 验证失败。"));
        console.log(chalk.red(`原因：${explainEmailVerifyError(error)}`));

        if (DEBUG_HTTP) {
            console.log(chalk.gray(`[DEBUG] Nodemailer error code: ${error?.code || "<none>"}`));
            console.log(chalk.gray(`[DEBUG] Nodemailer command: ${error?.command || "<none>"}`));
            console.log(chalk.gray(`[DEBUG] Nodemailer response: ${error?.response || "<none>"}`));
        }

        return false;
    }

    const envContent =
        `SMTP_HOST=${host}\n` +
        `SMTP_PORT=${port}\n` +
        `SMTP_USER=${user}\n` +
        `SMTP_PASS=${pass}\n` +
        `MAIL_FROM=${user}\n` +
        `MAIL_TO=${mailTo}\n`;

    try {
        fs.writeFileSync("./email_info.env", envContent, { encoding: "utf8" });
        console.log(chalk.green("\n邮件配置已通过验证并保存至 email_info.env。"));
        return true;
    } catch (error) {
        console.log(chalk.red(`\n邮件配置验证通过，但写入 email_info.env 失败：${error.message}`));
        return false;
    }
}

async function sendEmailAlert(courseKey, subject, htmlBody, force = false) {
    if (!enableEmailAlerts) return;

    const now = Date.now();
    const lastTS = lastMailTSMap.get(courseKey) || 0;
    if (!force && now - lastTS < COOLDOWN_MS) return;

    try {
        const info = await transporter.sendMail({
            from: process.env.MAIL_FROM,
            to: process.env.MAIL_TO,
            subject,
            html: htmlBody
        });
        lastMailTSMap.set(courseKey, now);
        console.log(chalk.green(`[${getPacificTime()}] [${courseKey}] 提醒邮件已发送，MessageID: ${info.messageId}`));
    } catch (err) {
        console.error(chalk.red(`[${getPacificTime()}] [${courseKey}] 邮件发送失败: ${err.message}`));
    }
}

// ================= 模块 2: 私人账号与自动注册系统 =================
async function configureUserEnvFile() {
    console.log(chalk.cyan("\n=== 授权凭证录入 ==="));
    console.log(chalk.white("请从浏览器 Network 面板的 batch / classRegistration 请求中提取以下三个参数："));

    const cookie = await askQuestion(chalk.yellow("\n1. 请粘贴 Cookie (stickounet=...; JSESSIONID=...):\n> "));
    const token = await askQuestion(chalk.yellow("2. 请粘贴 X-Synchronizer-Token:\n> "));
    const sessionId = await askQuestion(chalk.yellow("3. 请粘贴 uniqueSessionId:\n> "));

    if (!cookie.trim() || !token.trim() || !sessionId.trim()) {
        console.log(chalk.red("参数不完整，配置失败！"));
        return false;
    }

    USER_COOKIE = cookie.trim();
    USER_TOKEN = token.trim();
    USER_SESSION_ID = sessionId.trim();

    const envContent = `USER_COOKIE="${USER_COOKIE}"\nUSER_TOKEN="${USER_TOKEN}"\nUSER_SESSION_ID="${USER_SESSION_ID}"\n`;
    fs.writeFileSync("./user_info.env", envContent, { encoding: "utf8" });
    console.log(chalk.green("\n私人凭证已保存至 user_info.env。"));
    return true;
}

async function privateHeartbeat() {
    if (!enableAutoRegister || !USER_COOKIE) return;

    try {
        const res = await fetch(`${BASE_URL}/classRegistration/classRegistration`, {
            headers: {
                "User-Agent": USER_AGENT,
                "Cookie": USER_COOKIE
            },
            redirect: "manual"
        });

        absorbUserCookiesFromResponse(res, "HEARTBEAT");

        if (res.status >= 300 && res.status < 400) {
            console.log(chalk.bgRed.white("\n[严重警告] 私人会话已失效！自动注册已挂起，请重新抓取当前有效凭证。"));
            enableAutoRegister = false;
        } else {
            console.log(chalk.gray(`[${getPacificTime()}] [系统保活] 私人会话心跳正常。`));
        }
    } catch {
        console.log(chalk.yellow(`[${getPacificTime()}] [系统保活] 心跳请求遇到网络波动。`));
    }
}

async function executeRegistration(course, crn) {
    const courseStr = `${course.subject} ${course.courseNumber} (CRN: ${crn})`;
    console.log(chalk.bgMagenta.white(`\n[${getPacificTime()}] 🚀 开始执行标准注册流：${courseStr}...`));

    try {
        if (!USER_COOKIE || !USER_TOKEN || !USER_SESSION_ID) {
            throw new Error("私人凭证不完整：缺少 USER_COOKIE / USER_TOKEN / USER_SESSION_ID。 ");
        }

        const addUrl = `${BASE_URL}/classRegistration/addRegistrationItem?term=${TERM}&courseReferenceNumber=${crn}&olr=false`;
        const addRes = await fetch(addUrl, {
            method: "GET",
            headers: {
                "Cookie": USER_COOKIE,
                "X-Synchronizer-Token": USER_TOKEN,
                "User-Agent": USER_AGENT,
                "X-Requested-With": "XMLHttpRequest",
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Referer": `${BASE_URL}/classRegistration/classRegistration`
            },
            redirect: "manual"
        });

        absorbUserCookiesFromResponse(addRes, "ADD_TO_SUMMARY");

        if (addRes.status >= 300 && addRes.status < 400) {
            await debugResponse("ADD_TO_SUMMARY_REDIRECT", addRes);
            throw new Error("步骤 1 被重定向到登录链：当前私人会话已失效，请重新获取 Cookie / Token / uniqueSessionId。 ");
        }

        const addRawText = await addRes.text();
        console.log(chalk.yellow(`\n[DEBUG] addRegistrationItem 原始返回:\n${addRawText.substring(0, 1200)}\n`));

        const addData = tryParseJson(addRawText, "步骤 1 addRegistrationItem");
        if (!addData.success) {
            throw new Error(`步骤 1 失败：${addData.message || "addRegistrationItem 未成功。"}`);
        }

        let courseTemplate = addData.model || null;

        if (!courseTemplate) {
            console.log(chalk.gray("[DEBUG] addRegistrationItem 未直接返回 model，尝试备用接口 getRegistrationEvents..."));

            const eventUrl = `${BASE_URL}/classRegistration/getRegistrationEvents?termFilter=&crn=${crn}`;
            const eventRes = await fetch(eventUrl, {
                method: "GET",
                headers: {
                    "Cookie": USER_COOKIE,
                    "X-Synchronizer-Token": USER_TOKEN,
                    "User-Agent": USER_AGENT,
                    "X-Requested-With": "XMLHttpRequest",
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "Referer": `${BASE_URL}/classRegistration/classRegistration`
                },
                redirect: "manual"
            });

            absorbUserCookiesFromResponse(eventRes, "GET_REGISTRATION_EVENTS");

            if (eventRes.status >= 300 && eventRes.status < 400) {
                await debugResponse("GET_REGISTRATION_EVENTS_REDIRECT", eventRes);
                throw new Error("步骤 2 被重定向：当前私人会话已失效。 ");
            }

            const eventRaw = await eventRes.text();
            console.log(chalk.yellow(`\n[DEBUG] getRegistrationEvents 原始返回:\n${eventRaw.substring(0, 1200)}\n`));

            const eventData = tryParseJson(eventRaw, "步骤 2 getRegistrationEvents");

            if (Array.isArray(eventData)) {
                courseTemplate = eventData.find(item => String(item.courseReferenceNumber) === String(crn));
            } else if (eventData && Array.isArray(eventData.data)) {
                courseTemplate = eventData.data.find(item => String(item.courseReferenceNumber) === String(crn));
            } else if (eventData?.data && String(eventData.data.courseReferenceNumber) === String(crn)) {
                courseTemplate = eventData.data;
            }
        }

        if (!courseTemplate) {
            throw new Error("未能从 addRegistrationItem 或备用接口中获取该课程的模板数据。 ");
        }

        courseTemplate.courseReferenceNumber = String(crn);
        courseTemplate.term = TERM;
        courseTemplate.courseRegistrationStatus = "RW";

        console.log(chalk.cyan(`[DEBUG] 即将提交的关键字段:\n${JSON.stringify({
            crn: courseTemplate.courseReferenceNumber,
            term: courseTemplate.term,
            subject: courseTemplate.subject,
            courseNumber: courseTemplate.courseNumber,
            status: courseTemplate.courseRegistrationStatus,
            statusDescription: courseTemplate.courseRegistrationStatusDescription,
            selectedAction: courseTemplate.selectedAction,
            id: courseTemplate.id,
            version: courseTemplate.version,
            statusIndicator: courseTemplate.statusIndicator
        }, null, 2)}\n`));

        const batchUrl = `${BASE_URL}/classRegistration/submitRegistration/batch`;
        const payload = {
            create: [],
            update: [courseTemplate],
            destroy: [],
            uniqueSessionId: USER_SESSION_ID
        };

        const batchRes = await fetch(batchUrl, {
            method: "POST",
            headers: {
                "Cookie": USER_COOKIE,
                "X-Synchronizer-Token": USER_TOKEN,
                "User-Agent": USER_AGENT,
                "X-Requested-With": "XMLHttpRequest",
                "Content-Type": "application/json",
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Origin": "https://prodapps.isadm.oregonstate.edu",
                "Referer": `${BASE_URL}/classRegistration/classRegistration`
            },
            body: JSON.stringify(payload),
            redirect: "manual"
        });

        absorbUserCookiesFromResponse(batchRes, "BATCH_SUBMIT");

        if (batchRes.status >= 300 && batchRes.status < 400) {
            await debugResponse("BATCH_SUBMIT_REDIRECT", batchRes);
            throw new Error("步骤 3 被重定向：batch 提交时会话无效，请重新抓取当前有效的 3 把钥匙。 ");
        }

        const batchRawText = await batchRes.text();
        console.log(chalk.yellow(`\n[DEBUG] batch 原始返回:\n${batchRawText.substring(0, 1200)}\n`));

        const batchData = tryParseJson(batchRawText, "步骤 3 submitRegistration/batch");

        let isSuccess = false;
        let errMsg = "";

        if (batchData.success) {
            const specificError = findCrnErrors(batchData, crn);

            if (specificError) {
                errMsg = specificError.message || specificError.errorType || "服务器返回了 CRN 级错误";
            } else {
                const returnedUpdates = Array.isArray(batchData?.data?.update) ? batchData.data.update : [];
                const returnedCreates = Array.isArray(batchData?.data?.create) ? batchData.data.create : [];
                const returnedAll = [...returnedUpdates, ...returnedCreates];
                const targetRecord = returnedAll.find(item => String(item.courseReferenceNumber) === String(crn));

                if (!targetRecord) {
                    errMsg = `batch 返回成功，但未在返回数据中找到目标 CRN ${crn}，需要人工核实。`;
                } else {
                    const status = String(targetRecord.courseRegistrationStatus || "").toUpperCase();
                    const statusIndicator = String(targetRecord.statusIndicator || "").toUpperCase();
                    const errorFlag = String(targetRecord.errorFlag || "").toUpperCase();
                    const recordMessage = String(targetRecord.message || "").trim();

                    console.log(chalk.cyan(`[DEBUG] 服务器返回的目标 CRN 记录:\n${JSON.stringify({
                        crn: targetRecord.courseReferenceNumber,
                        status,
                        statusDescription: targetRecord.courseRegistrationStatusDescription || "",
                        statusIndicator,
                        errorFlag,
                        message: recordMessage
                    }, null, 2)}\n`));

                    if (errorFlag === "F" || statusIndicator === "F") {
                        errMsg = recordMessage || `目标 CRN ${crn} 被服务器标记为失败。`;
                    } else if (recordMessage) {
                        const lowerMsg = recordMessage.toLowerCase();
                        if (lowerMsg.includes("duplicate") || lowerMsg.includes("already") || lowerMsg.includes("existing registration")) {
                            isSuccess = true;
                            errMsg = recordMessage;
                        } else {
                            errMsg = recordMessage;
                        }
                    } else if (status === "RW") {
                        isSuccess = true;
                    } else {
                        errMsg = `目标 CRN ${crn} 返回了非预期状态：status=${status}, statusIndicator=${statusIndicator}`;
                    }
                }
            }
        } else {
            errMsg = batchData.message || batchData.errorMessage || "batch 请求被服务器拒绝";
        }

        if (isSuccess) {
            console.log(chalk.bgGreen.black(`\n 注册成功：${courseStr} 已提交成功！ \n`));
            successfullyRegisteredCRNs.add(String(crn));

            const mailSubject = `抢课成功：${courseStr}`;
            const body = `
                <h2>抢课成功通知</h2>
                <p>系统已成功为您提交 <b>${courseStr}</b>。</p>
                <p>附言：${errMsg || "操作顺畅，无异常。"}</p>
                <p>请立即前往 OSU 系统核实最终课表。</p>
            `;
            await sendEmailAlert(`SUCCESS_${crn}`, mailSubject, body, true);
        } else {
            console.log(chalk.bgRed.white(`\n 注册失败：${courseStr} 未完成。原因：${errMsg} \n`));

            const failSubject = `抢课失败：${courseStr}`;
            const failBody = `
                <p>尝试为您注册 <b>${courseStr}</b> 时未能完成。</p>
                <p>错误原因：<b style="color:red">${errMsg}</b></p>
                <p>建议您打开网页端确认当前 Cart / Summary 状态，并在必要时重新抓取 3 把钥匙。</p>
            `;
            await sendEmailAlert(`FAIL_${crn}`, failSubject, failBody, true);
        }
    } catch (error) {
        console.error(chalk.red(`[${getPacificTime()}] 自动注册中断: ${error.message}`));
    }
}

// ================= 模块 3: Term / 搜索 Session =================
async function initSearchTermSession() {
    dynamicCookie = "";
    dynamicToken = "";

    const res = await fetch(TERM_SELECTION_URL, {
        method: "GET",
        headers: {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        redirect: "manual"
    });

    absorbDynamicCookiesFromResponse(res, "TERM_SELECTION");

    if (res.status >= 300 && res.status < 400) {
        await debugResponse("TERM_SELECTION_REDIRECT", res);
        throw new Error("termSelection 被重定向，无法初始化搜索会话。 ");
    }

    const html = await res.text();
    const tokenMatch =
        html.match(/name="synchronizerToken"\s+content="([^"]+)"/i) ||
        html.match(/content="([^"]+)"\s+name="synchronizerToken"/i);

    if (!tokenMatch || !tokenMatch[1]) {
        console.log(chalk.red("[DEBUG] termSelection 页面前 1000 字符："));
        console.log(html.slice(0, 1000));
        throw new Error("无法从 termSelection 页面解析 synchronizerToken。 ");
    }

    dynamicToken = tokenMatch[1];
    console.log(chalk.gray(`[DEBUG] 搜索会话初始化成功，token=${dynamicToken.slice(0, 8)}...`));
}

async function fetchAvailableTerms() {
    if (!dynamicCookie || !dynamicToken) await initSearchTermSession();

    const params = new URLSearchParams({
        searchTerm: "",
        offset: "1",
        max: "20",
        _: String(Date.now())
    });

    const res = await fetch(`${GET_TERMS_URL}?${params.toString()}`, {
        method: "GET",
        headers: {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "User-Agent": USER_AGENT,
            "X-Requested-With": "XMLHttpRequest",
            "X-Synchronizer-Token": dynamicToken,
            "Cookie": dynamicCookie,
            "Referer": TERM_SELECTION_URL
        },
        redirect: "manual"
    });

    absorbDynamicCookiesFromResponse(res, "GET_TERMS");

    if (res.status >= 300 && res.status < 400) {
        await debugResponse("GET_TERMS_REDIRECT", res);
        throw new Error("getTerms 被重定向，搜索会话可能失效。 ");
    }

    const text = await res.text();
    const terms = tryParseJson(text, "getTerms");

    if (!Array.isArray(terms)) throw new Error("getTerms 返回的不是数组。 ");
    return terms;
}

async function chooseTermFromBanner() {
    console.log(chalk.bgCyan.black(" 【第一步：从 Banner 获取可用学期】 "));

    const terms = await fetchAvailableTerms();

    const selectableTerms = terms.filter(term => {
        const description = String(term.description || "").toLowerCase();
        return !description.includes("view only");
    });

    if (selectableTerms.length === 0) {
        throw new Error("Banner 没有返回任何可注册的 term。当前返回的学期可能全部都是 View Only。");
    }

    console.log(chalk.cyan("\n当前 Banner 返回的可用注册学期："));
    selectableTerms.forEach((term, index) => {
        console.log(`  [${index + 1}] ${term.description}  (${term.code})`);
    });

    while (true) {
        const ans = (await askQuestion(chalk.yellow("\n请选择要监控的学期编号: "))).trim();
        const index = Number(ans) - 1;

        if (Number.isInteger(index) && index >= 0 && index < selectableTerms.length) {
            TERM = String(selectableTerms[index].code);
            console.log(chalk.green(`\n监控学期已锁定为: ${selectableTerms[index].description} (${TERM})`));
            return;
        }

        console.log(chalk.red("无效选项，请重新输入。"));
    }
}

async function refreshSession() {
    try {
        await initSearchTermSession();

        if (!TERM) {
            lastRefreshTime = Date.now();
            return;
        }

        const termRes = await fetch(TERM_URL, {
            method: "POST",
            headers: {
                "Cookie": dynamicCookie,
                "X-Synchronizer-Token": dynamicToken,
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "User-Agent": USER_AGENT,
                "X-Requested-With": "XMLHttpRequest",
                "Referer": TERM_SELECTION_URL
            },
            body: new URLSearchParams({ term: TERM }).toString(),
            redirect: "manual"
        });

        absorbDynamicCookiesFromResponse(termRes, "TERM_SEARCH");

        if (termRes.status >= 300 && termRes.status < 400) {
            await debugResponse("TERM_SEARCH_REDIRECT", termRes);
            throw new Error("term/search 被重定向，term 可能无效或搜索会话未绑定成功。 ");
        }

        const termText = await termRes.text();
        if (DEBUG_HTTP) console.log(chalk.gray(`[DEBUG] term/search 返回预览: ${termText.slice(0, 300)}`));

        lastRefreshTime = Date.now();
        console.log(chalk.green(`[${getPacificTime()}] 搜索会话刷新成功，TERM=${TERM}, token=${dynamicToken.slice(0, 8)}...`));
    } catch (e) {
        console.error(chalk.red(`[${getPacificTime()}] 访客凭证获取失败: ${e.message}`));
    }
}

async function resetSearch() {
    try {
        if (!dynamicCookie || !dynamicToken) return;

        const res = await fetch(RESET_URL, {
            method: "POST",
            headers: {
                "Cookie": dynamicCookie,
                "X-Synchronizer-Token": dynamicToken,
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "Accept": "text/html, */*; q=0.01",
                "User-Agent": USER_AGENT,
                "X-Requested-With": "XMLHttpRequest",
                "Referer": START_URL
            },
            body: "",
            redirect: "manual"
        });

        absorbDynamicCookiesFromResponse(res, "RESET_SEARCH");
    } catch (e) {
        if (DEBUG_HTTP) console.log(chalk.yellow(`[DEBUG] resetSearch 忽略错误: ${e.message}`));
    }
}

async function fetchCourseData(subject, courseNumber, isRetry = false) {
    if (!isSearchSessionReady()) await refreshSession();
    await resetSearch();

    const params = new URLSearchParams({
        txt_subject: subject,
        txt_courseNumber: courseNumber,
        txt_term: TERM,
        startDatepicker: "",
        endDatepicker: "",
        uniqueSessionId: generateSearchSessionId(),
        pageOffset: "0",
        pageMaxSize: "50",
        sortColumn: "subjectDescription",
        sortDirection: "asc"
    });

    const res = await fetch(`${SEARCH_URL}?${params.toString()}`, {
        method: "GET",
        headers: {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "User-Agent": USER_AGENT,
            "X-Requested-With": "XMLHttpRequest",
            "X-Synchronizer-Token": dynamicToken,
            "Cookie": dynamicCookie,
            "Referer": START_URL
        },
        redirect: "manual"
    });

    absorbDynamicCookiesFromResponse(res, "SEARCH_RESULTS");

    if ((res.status === 401 || res.status === 403 || res.status === 400 || (res.status >= 300 && res.status < 400)) && !isRetry) {
        await debugResponse("SEARCH_RESULTS_RETRY", res);
        await refreshSession();
        return fetchCourseData(subject, courseNumber, true);
    }

    const text = await res.text();

    if (!res.ok) {
        console.log(chalk.red(`[DEBUG] searchResults HTTP ${res.status}:`));
        console.log(text.slice(0, 1200));
        throw new Error(`searchResults 请求失败: HTTP ${res.status}`);
    }

    try {
        return JSON.parse(text);
    } catch {
        console.log(chalk.red("[DEBUG] searchResults 返回的不是合法 JSON，原始返回预览："));
        console.log(text.slice(0, 1200));
        throw new Error("searchResults 返回 HTML/错误页，不是 JSON。通常是 token、cookie、term 或 referer 不匹配。 ");
    }
}

async function fetchRestrictions(crn, isRetry = false) {
    const res = await fetch(RESTRICTIONS_URL, {
        method: "POST",
        headers: {
            "Accept": "text/html, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": USER_AGENT,
            "X-Requested-With": "XMLHttpRequest",
            "X-Synchronizer-Token": dynamicToken,
            "Cookie": dynamicCookie,
            "Referer": START_URL
        },
        body: new URLSearchParams({
            term: TERM,
            courseReferenceNumber: crn
        }).toString(),
        redirect: "manual"
    });

    absorbDynamicCookiesFromResponse(res, "GET_RESTRICTIONS");

    if ((res.status === 401 || res.status === 403 || res.status === 400 || (res.status >= 300 && res.status < 400)) && !isRetry) {
        await refreshSession();
        return fetchRestrictions(crn, true);
    }

    return await res.text();
}

async function fetchEnrollmentInfoFromBanner(crn, isRetry = false) {
    try {
        const res = await fetch(ENROLLMENT_INFO_URL, {
            method: "POST",
            headers: {
                "Accept": "text/html, */*; q=0.01",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": USER_AGENT,
                "X-Requested-With": "XMLHttpRequest",
                "X-Synchronizer-Token": dynamicToken,
                "Cookie": dynamicCookie,
                "Referer": START_URL
            },
            body: new URLSearchParams({
                term: TERM,
                courseReferenceNumber: crn
            }).toString(),
            redirect: "manual"
        });

        absorbDynamicCookiesFromResponse(res, "GET_ENROLLMENT_INFO");

        if ((res.status === 401 || res.status === 403 || res.status === 400 || (res.status >= 300 && res.status < 400)) && !isRetry) {
            await refreshSession();
            return fetchEnrollmentInfoFromBanner(crn, true);
        }

        const html = await res.text();

        return {
            source: "Banner SSB 实时数据",
            maxEnroll: extractNumberFromHtmlByLabels(html, ["Enrollment Maximum", "Maximum Enrollment", "Max Enroll", "Max Enrl"]),
            enrollment: extractNumberFromHtmlByLabels(html, ["Enrollment Actual", "Actual Enrollment", "Actual Enrl", "Enrollment"]),
            seatsAvailable: extractNumberFromHtmlByLabels(html, ["Enrollment Seats Available", "Seats Available", "Seats Avail", "Remaining Seats"]),
            waitCapacity: extractNumberFromHtmlByLabels(html, ["Waitlist Capacity", "Waitlist Maximum", "Waitlist Max"]),
            waitCount: extractNumberFromHtmlByLabels(html, ["Waitlist Actual", "Waitlist Count", "Actual Waitlist", "Wait Count"]),
            waitAvailable: extractNumberFromHtmlByLabels(html, ["Waitlist Seats Available", "Waitlist Available", "Wait Available"])
        };
    } catch (err) {
        console.log(chalk.yellow(`[${getPacificTime()}] [CRN ${crn}] Banner enrollment info 获取失败: ${err.message}`));
        return null;
    }
}

// ================= 模块 4: 备用 Waitlist 查询 / 数据补全 =================
function firstNumberFromSection(section, names) {
    for (const name of names) {
        const parsed = toIntOrNull(section?.[name]);
        if (isRealNumber(parsed)) return parsed;
    }
    return null;
}

function buildNormalizedCourse(section, extra = {}) {
    return {
        ...section,
        maxEnroll: firstNumberFromSection(section, ["maxEnroll", "maximumEnrollment", "maxEnrollment", "enrollmentMaximum"]),
        enrollment: firstNumberFromSection(section, ["enrollment", "actualEnrollment", "enrollmentActual"]),
        seatsAvailable: firstNumberFromSection(section, ["seatsAvailable", "ssbsect_seats_avail", "seatAvailable"]),
        waitCapacity: firstNumberFromSection(section, ["waitCapacity", "waitlistCapacity", "waitlist_capacity"]),
        waitCount: firstNumberFromSection(section, ["waitCount", "waitlistCount", "ssbsect_wait_count"]),
        waitAvailable: firstNumberFromSection(section, ["waitAvailable", "waitlistAvailable", "ssbsect_wait_avail"]),
        _mainDataSource: "Banner SSB searchResults 快速扫描数据",
        _waitlistSource: "Banner SSB searchResults 快速扫描数据",
        _waitlistStale: false,
        _matchReason: "",
        ...extra
    };
}

function mergeMetricIfPresent(target, key, value) {
    const parsed = toIntOrNull(value);
    if (isRealNumber(parsed)) {
        target[key] = parsed;
        return true;
    }
    return false;
}

function mergeBannerEnrollmentInfo(section, bannerInfo) {
    if (!bannerInfo) return section;

    mergeMetricIfPresent(section, "maxEnroll", bannerInfo.maxEnroll);
    mergeMetricIfPresent(section, "enrollment", bannerInfo.enrollment);
    mergeMetricIfPresent(section, "seatsAvailable", bannerInfo.seatsAvailable);

    const gotWaitCapacity = mergeMetricIfPresent(section, "waitCapacity", bannerInfo.waitCapacity);
    const gotWaitCount = mergeMetricIfPresent(section, "waitCount", bannerInfo.waitCount);
    const gotWaitAvailable = mergeMetricIfPresent(section, "waitAvailable", bannerInfo.waitAvailable);

    section._mainDataSource = bannerInfo.source || section._mainDataSource;

    if (gotWaitCapacity || gotWaitCount || gotWaitAvailable) {
        section._waitlistSource = bannerInfo.source || "Banner SSB 实时数据";
        section._waitlistStale = false;
    }

    return section;
}

async function fetchWaitlistFromClassesBackup(subject, courseNumber, crn) {
    try {
        const payload = {
            group: `code:${subject} ${courseNumber}`,
            key: `crn:${crn}`,
            srcdb: TERM,
            matched: `crn:${crn}`
        };

        const res = await fetch(OSU_CLASSES_DETAILS_URL, {
            method: "POST",
            headers: {
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
                "X-Requested-With": "XMLHttpRequest",
                "Referer": `https://classes.oregonstate.edu/?keyword=${subject.toLowerCase()}${courseNumber}&srcdb=${TERM}`
            },
            body: JSON.stringify(payload),
            redirect: "manual"
        });

        const text = await res.text();

        if (!res.ok) {
            console.log(chalk.yellow(`[${getPacificTime()}] [${subject} ${courseNumber}] CRN ${crn} 备用源 HTTP ${res.status}`));
            console.log(text.slice(0, 800));
            return null;
        }

        const data = tryParseJson(text, "classes.oregonstate.edu waitlist backup");

        let maxEnroll = toIntOrNull(data.max_enroll);
        let enrollment = toIntOrNull(data.enrollment);
        let seatsAvailable = toIntOrNull(data.ssbsect_seats_avail);

        if ((!isRealNumber(maxEnroll) || !isRealNumber(enrollment)) && data.all_sections__data) {
            try {
                const allSectionsData = typeof data.all_sections__data === "string"
                    ? JSON.parse(data.all_sections__data)
                    : data.all_sections__data;

                const hit = Array.isArray(allSectionsData?.sections)
                    ? allSectionsData.sections.find(item => String(item?.data_crn) === String(crn))
                    : null;

                if (hit) {
                    if (!isRealNumber(maxEnroll)) maxEnroll = toIntOrNull(hit?.max_enroll?.val);
                    if (!isRealNumber(enrollment)) enrollment = toIntOrNull(hit?.enrollment?.val);
                    if (!isRealNumber(seatsAvailable) && isRealNumber(maxEnroll) && isRealNumber(enrollment)) {
                        seatsAvailable = Math.max(maxEnroll - enrollment, 0);
                    }
                }
            } catch (err) {
                if (DEBUG_HTTP) console.log(chalk.yellow(`[DEBUG] all_sections__data 解析失败: ${err.message}`));
            }
        }

        return {
            source: "classes.oregonstate.edu 备用数据",
            waitlistStale: true,
            maxEnroll,
            enrollment,
            seatsAvailable,
            waitCapacity: toIntOrNull(data.waitlist_capacity),
            waitCount: toIntOrNull(data.ssbsect_wait_count),
            waitAvailable: toIntOrNull(data.ssbsect_wait_avail)
        };
    } catch (err) {
        console.log(chalk.yellow(`[${getPacificTime()}] [${subject} ${courseNumber}] CRN ${crn} 备用 waitlist 查询失败: ${err.message}`));
        return null;
    }
}

function shouldUseBackupWaitlist(section) {
    const seatsAvailable = toIntOrNull(section.seatsAvailable);
    const waitAvailable = toIntOrNull(section.waitAvailable);

    const seatIsKnownFull = isRealNumber(seatsAvailable) && seatsAvailable <= 0;
    const waitMissingOrUnavailable = !isRealNumber(waitAvailable) || waitAvailable <= 0;

    return seatIsKnownFull && waitMissingOrUnavailable;
}

async function enrichCandidateCourse(course, section) {
    const normalized = buildNormalizedCourse(section);
    const bannerInfo = await fetchEnrollmentInfoFromBanner(normalized.courseReferenceNumber);
    return mergeBannerEnrollmentInfo(normalized, bannerInfo);
}

function addCandidate(candidateMap, section, reason) {
    const crn = String(section.courseReferenceNumber || "");
    if (!crn) return;

    const existing = candidateMap.get(crn);
    if (!existing) {
        candidateMap.set(crn, { ...section, _matchReason: reason });
        return;
    }

    const reasons = new Set(String(existing._matchReason || "").split(" + ").filter(Boolean));
    reasons.add(reason);
    existing._matchReason = Array.from(reasons).join(" + ");
}

function formatCourseConsoleLine(c) {
    const staleNote = c._waitlistStale
        ? " Waitlist 来自备用源，可能延迟，非最新实时数据"
        : "";

    return [
        `CRN: ${c.courseReferenceNumber}`,
        `Title: ${c.courseTitle || c.title || "未知"}`,
        `Section: ${c.sequenceNumber || c.section || "未知"}`,
        `Campus: ${c.campusDescription || c.campus || "未知"}`,
        `Type: ${c.scheduleTypeDescription || c.scheduleType || "未知"}`,
        `Match Reason: ${c._matchReason || "符合条件"}`,
        `Max Enroll: ${displayValue(c.maxEnroll)}`,
        `Actual Enroll: ${displayValue(c.enrollment)}`,
        `Seats Available: ${displayValue(c.seatsAvailable)}`,
        `Waitlist Capacity: ${displayValue(c.waitCapacity)}`,
        `Waitlist Count: ${displayValue(c.waitCount)}`,
        `Waitlist Available: ${displayValue(c.waitAvailable)}${staleNote}`,
        `Main Data Source: ${c._mainDataSource || "Banner SSB"}`,
        `Waitlist Source: ${c._waitlistSource || "Banner SSB"}`
    ].join("\n  ");
}

function formatCourseEmailItem(c) {
    const staleNote = c._waitlistStale
        ? `<br/><span style="color:#b45309;"><b>注意：</b>Waitlist 来自 classes.oregonstate.edu 备用源，可能存在延迟，非最新实时数据。</span>`
        : "";

    return `
        <li style="margin-bottom: 18px;">
            <b>CRN:</b> ${c.courseReferenceNumber}<br/>
            <b>Title:</b> ${c.courseTitle || c.title || "未知"}<br/>
            <b>Section:</b> ${c.sequenceNumber || c.section || "未知"}<br/>
            <b>Campus:</b> ${c.campusDescription || c.campus || "未知"}<br/>
            <b>Type:</b> ${c.scheduleTypeDescription || c.scheduleType || "未知"}<br/>
            <b>Match Reason:</b> ${c._matchReason || "符合条件"}<br/>
            <b>Max Enroll:</b> ${displayValue(c.maxEnroll)}<br/>
            <b>Actual Enroll:</b> ${displayValue(c.enrollment)}<br/>
            <b>Seats Available:</b> <span style="color:red; font-weight:bold">${displayValue(c.seatsAvailable)}</span><br/>
            <b>Waitlist Capacity:</b> ${displayValue(c.waitCapacity)}<br/>
            <b>Waitlist Count:</b> ${displayValue(c.waitCount)}<br/>
            <b>Waitlist Available:</b> <span style="color:red; font-weight:bold">${displayValue(c.waitAvailable)}</span><br/>
            <b>Main Data Source:</b> ${c._mainDataSource || "Banner SSB"}<br/>
            <b>Waitlist Source:</b> ${c._waitlistSource || "Banner SSB"}
            ${staleNote}
        </li>
    `;
}

// ================= 模块 5: 核心监控逻辑 =================
async function checkPerfectSection(course) {
    const { subject, courseNumber, checkOnlineOnly, monitorMode } = course;
    const modeText = checkOnlineOnly ? "【网课】" : "【线下课】";
    const typeText = monitorMode === "1" ? "「可用座位」" : monitorMode === "2" ? "「等待队列」" : "「座位或Waitlist」";
    const courseKey = `${subject}_${courseNumber}_${checkOnlineOnly ? "Online" : "InPerson"}_M${monitorMode}`;

    try {
        const json = await fetchCourseData(subject, courseNumber);
        if (!json || !json.success || !Array.isArray(json.data)) {
            console.log(chalk.yellow(`[${getPacificTime()}] [${subject} ${courseNumber}] searchResults 没有返回有效 data。`));
            return;
        }

        const candidateMap = new Map();
        const backupWaitlistCandidates = [];

        for (const rawSection of json.data) {
            const c = buildNormalizedCourse(rawSection);

            const isOnlineCourse =
                c.scheduleTypeDescription === "Online" ||
                (c.campusDescription && c.campusDescription.includes("Ecampus"));

            const sectionNum = c.sequenceNumber || "";

            if (checkOnlineOnly && !isOnlineCourse) continue;
            if (!checkOnlineOnly && (isOnlineCourse || !sectionNum.startsWith("0"))) continue;

            const seatsAvailable = toIntOrNull(c.seatsAvailable);
            const waitAvailable = toIntOrNull(c.waitAvailable);

            const hasSeat = isRealNumber(seatsAvailable) && seatsAvailable > 0;
            const hasWaitlist = isRealNumber(waitAvailable) && waitAvailable > 0;

            if (monitorMode === "1") {
                if (hasSeat) addCandidate(candidateMap, c, "座位可用");
                continue;
            }

            if (monitorMode === "2") {
                if (hasWaitlist) {
                    addCandidate(candidateMap, c, "Waitlist 可用");
                } else if (shouldUseBackupWaitlist(c)) {
                    backupWaitlistCandidates.push(c);
                }
                continue;
            }

            if (hasSeat) addCandidate(candidateMap, c, "座位可用");
            if (hasWaitlist) addCandidate(candidateMap, c, "Waitlist 可用");

            if (!hasSeat && !hasWaitlist && shouldUseBackupWaitlist(c)) {
                backupWaitlistCandidates.push(c);
            }
        }

        if (monitorMode === "2" || monitorMode === "3") {
            const seenBackupCrns = new Set();

            for (const c of backupWaitlistCandidates) {
                const crn = String(c.courseReferenceNumber || "");
                if (!crn || seenBackupCrns.has(crn)) continue;
                seenBackupCrns.add(crn);

                console.log(chalk.gray(
                    `[${getPacificTime()}] [${subject} ${courseNumber}] CRN ${crn} 座位已满，Banner waitlist 未命中，使用备用源确认 waitlist...`
                ));

                const backup = await fetchWaitlistFromClassesBackup(subject, courseNumber, crn);

                if (backup && isRealNumber(backup.waitAvailable) && backup.waitAvailable > 0) {
                    const backupSection = {
                        ...c,
                        maxEnroll: isRealNumber(backup.maxEnroll) ? backup.maxEnroll : c.maxEnroll,
                        enrollment: isRealNumber(backup.enrollment) ? backup.enrollment : c.enrollment,
                        seatsAvailable: isRealNumber(backup.seatsAvailable) ? backup.seatsAvailable : c.seatsAvailable,
                        waitCapacity: backup.waitCapacity,
                        waitCount: backup.waitCount,
                        waitAvailable: backup.waitAvailable,
                        _mainDataSource: "Banner SSB searchResults + classes.oregonstate.edu 备用补充",
                        _waitlistSource: backup.source,
                        _waitlistStale: true
                    };

                    addCandidate(candidateMap, backupSection, "备用源确认 Waitlist 可用");
                }
            }
        }

        let availableCourses = Array.from(candidateMap.values());

        if (availableCourses.length === 0) {
            console.log(chalk.gray(`[${getPacificTime()}] 扫描 ${subject} ${courseNumber} ${modeText}${typeText}，暂无空位或可用 Waitlist...`));
            return;
        }

        const enrichedCourses = [];
        for (const c of availableCourses) {
            const enriched = await enrichCandidateCourse(course, c);
            enrichedCourses.push(enriched);
        }
        availableCourses = enrichedCourses;

        const perfectCourses = [];
        const restrictionBlacklist = [
            "Dist. Degree Corvallis Student(DSC)",
            "Oregon State - Corvallis (C)"
        ];

        for (const c of availableCourses) {
            try {
                const html = await fetchRestrictions(c.courseReferenceNumber);
                const foundRestriction = restrictionBlacklist.find(keyword => html.includes(keyword));

                if (!foundRestriction) {
                    perfectCourses.push(c);
                } else {
                    console.log(chalk.yellow(
                        `[${getPacificTime()}] [${subject} ${courseNumber}] CRN ${c.courseReferenceNumber} 命中候选，但检测到拦截: “${foundRestriction}”`
                    ));
                }
            } catch (err) {
                console.log(chalk.yellow(
                    `[${getPacificTime()}] [${subject} ${courseNumber}] CRN ${c.courseReferenceNumber} restriction 检查失败，暂不纳入候选: ${err.message}`
                ));
            }
        }

        const unregisteredPerfect = perfectCourses.filter(c => !successfullyRegisteredCRNs.has(String(c.courseReferenceNumber)));

        if (unregisteredPerfect.length === 0) {
            console.log(chalk.gray(`[${getPacificTime()}] [${subject} ${courseNumber}] 候选项都已注册成功或被过滤。`));
            return;
        }

        console.log(chalk.green(
            `\n[${getPacificTime()}] 🚨 [${subject} ${courseNumber}] 发现 ${unregisteredPerfect.length} 个符合条件、可尝试注册的课程选项！`
        ));

        for (const c of unregisteredPerfect) {
            console.log(chalk.green("\n  " + formatCourseConsoleLine(c)));
        }

        const detailsHtml = unregisteredPerfect.map(c => formatCourseEmailItem(c)).join("");
        const mailSubject = `发现可注册的 ${subject} ${courseNumber} ${modeText}${typeText}`;
        const body = `
            <h2>${subject} ${courseNumber} 发现了符合要求的课程选项</h2>
            <p>座位数据优先来自 Banner SSB；如果 Banner 无法确认 waitlist 且座位已满，则使用 classes.oregonstate.edu 备用源确认 waitlist。</p>
            <p><b>注意：</b>凡是标注为备用源的 Waitlist 数据，可能存在延迟，不能视为最新实时数据。</p>
            <ul>${detailsHtml}</ul>
        `;

        await sendEmailAlert(courseKey, mailSubject, body, false);

        if (enableAutoRegister) {
            const targetCrn = unregisteredPerfect[0].courseReferenceNumber;
            await executeRegistration(course, targetCrn);
        }
    } catch (error) {
        console.error(chalk.red(`[${getPacificTime()}] [${subject} ${courseNumber}] 检测出错: ${error.message}`));
    }
}

async function monitorAllCourses() {
    if (Date.now() - lastRefreshTime >= 300_000) {
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
    await chooseTermFromBanner();

    console.log(chalk.bgCyan.black("\n 【第二步：配置监控课程】 "));
    let addMore = true;

    while (addMore) {
        console.log(chalk.bold(`\n[录入第 ${COURSES_TO_MONITOR.length + 1} 门课程]`));

        const courseQs = [
            {
                prompt: chalk.yellow("请输入 Subject (例如 CS, MTH): "),
                validate: ans => /^[A-Za-z]+$/.test(ans) ? true : (console.log(chalk.red("科目缩写错误！")), false)
            },
            {
                prompt: chalk.yellow("请输入 Course Number (例如 123, 456): "),
                validate: ans => /^\d+$/.test(ans) ? true : (console.log(chalk.red("课程号错误！")), false)
            },
            {
                prompt: chalk.yellow("是否只监控网课？(y/n，直接回车默认 y): "),
                validate: ans => ["", "y", "n"].includes(ans.trim().toLowerCase()) ? true : (console.log(chalk.red("无效输入！")), false)
            },
            {
                prompt: chalk.yellow("请选择目标：[1] 仅空座 [2] 仅Waitlist [3] 座位或Waitlist\n请输入 (1/2/3，回车默认 3): "),
                validate: ans => ["", "1", "2", "3"].includes(ans) ? true : (console.log(chalk.red("无效选项！")), false)
            }
        ];

        const courseAns = await askWithBack(courseQs);
        COURSES_TO_MONITOR.push({
            subject: courseAns[0].toUpperCase(),
            courseNumber: courseAns[1],
            checkOnlineOnly: courseAns[2].toLowerCase() !== "n",
            monitorMode: courseAns[3] || "3"
        });

        console.log(chalk.green(`成功添加: ${courseAns[0].toUpperCase()} ${courseAns[1]}`));
        const moreInput = await askQuestion(chalk.green("\n是否继续添加？(y/n，回车默认 n): "));
        addMore = moreInput.trim().toLowerCase() === "y";
    }
}

(async () => {
    console.log(chalk.cyan("\n=== 欢迎使用 OSU 选课监控助手 ==="));
    console.log(chalk.blue(`[${getPacificTime()}] 免责提示：本程序仅用于学习和研究目的。`));

    console.log(chalk.bgMagenta.white("\n 【请选择运行模式】 "));
    console.log("  [1] 侦察模式 (仅检测空位并发送邮件提醒)");
    console.log("  [2] 狙击模式 (检测到空位后，全自动发送网络请求为您抢课)");

    let modeChoice;
    while (true) {
        modeChoice = (await askQuestion(chalk.yellow("请输入选项 (1 或 2): "))).trim();
        if (modeChoice === "1" || modeChoice === "2") break;
        console.log(chalk.red("无效选项，请输入 1 或 2。"));
    }

    if (modeChoice === "2") {
        enableAutoRegister = true;

        while (!USER_COOKIE || !USER_TOKEN || !USER_SESSION_ID) {
            const wantToConfig = await askQuestion(chalk.yellow("\n需要 3 把金钥匙才能开启自动注册。是否现在配置？(y/n): "));
            if (wantToConfig.trim().toLowerCase() === "n") {
                console.log(chalk.magenta("已降级为【侦察模式】(仅提醒)。"));
                enableAutoRegister = false;
                break;
            }
            await configureUserEnvFile();
        }

        if (enableAutoRegister) {
            console.log(chalk.green(`\n已读取私人凭证！Token [${USER_TOKEN.substring(0, 8)}...]`));
            setInterval(privateHeartbeat, 4 * 60 * 1000);
            console.log(chalk.bgGreen.black(" 全自动注册引擎已挂载并开始心跳保活！ "));
        }
    }

    if (!await verifyEmailConfig()) {
        console.log(chalk.bgRed.white("\n 警告: 邮件配置验证失败 "));
        console.log("  [1] 继续运行 (仅屏幕显示)  [2] 设置邮件配置  [3] 退出");

        while (true) {
            const ans = (await askQuestion(chalk.yellow("选择 (1/2/3): "))).trim();
            if (ans === "1") {
                enableEmailAlerts = false;
                break;
            }
            if (ans === "2") {
                if (await configureEnvFile() && await verifyEmailConfig()) break;
                process.exit(1);
            }
            if (ans === "3") process.exit(0);
        }
    }

    await setupCoursesInteractively();
    rl.close();

    if (COURSES_TO_MONITOR.length === 0) process.exit(0);

    console.log(chalk.magenta(`\n[${getPacificTime()}] 录入完毕！启动监控...`));
    await refreshSession();
    await monitorAllCourses();
})();