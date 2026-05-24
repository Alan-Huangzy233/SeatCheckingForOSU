// allInOne.js

import fetch from "node-fetch";
import chalk from "chalk";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import readline from "readline";
import fs from "fs";

// ================= Environment Configuration =================
dotenv.config({ path: "./email_info.env" });
dotenv.config({ path: "./user_info.env" });

// ================= Global Configuration =================
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

// ================= Cookie and Debug Helpers =================
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
        if (DEBUG_HTTP) {
            console.log(chalk.gray(`[COOKIE JAR] ${label} received ${setCookies.length} Set-Cookie header(s), merged into private session.`));
        }
    }
}

let dynamicCookie = "";
let dynamicToken = "";
let lastRefreshTime = 0;

function absorbDynamicCookiesFromResponse(res, label = "") {
    const setCookies = getSetCookieValues(res);
    if (setCookies.length > 0) {
        dynamicCookie = mergeCookieStrings(dynamicCookie, setCookies);
        if (DEBUG_HTTP) {
            console.log(chalk.gray(`[DYNAMIC COOKIE] ${label} received ${setCookies.length} Set-Cookie header(s), merged into search session.`));
        }
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
        console.log(chalk.red(`[DEBUG:${label}] body cannot be read: ${err.message}`));
    }
}

function tryParseJson(text, label = "JSON") {
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${label} parse failed. The server did not return valid JSON.`);
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
    return new Date().toLocaleString("en-US", {
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
    return isRealNumber(parsed) ? String(parsed) : "Unknown";
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
        if (i > 0) promptText = chalk.gray("[Type '-' to go back] ") + promptText;

        let ans = await askQuestion(promptText);
        ans = ans.trim();

        if (ans === "-" && i > 0) {
            i--;
            continue;
        }

        if (ans === "-" && i === 0) {
            console.log(chalk.red("You are already at the first question."));
            continue;
        }

        if (questions[i].validate && !questions[i].validate(ans)) continue;

        answers[i] = ans;
        i++;
    }

    return answers;
}

// ================= Module 1: Email System =================
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

    if (full.includes("eai_again") || full.includes("enotfound") || full.includes("getaddrinfo")) {
        return "The SMTP host could not be resolved. Check SMTP_HOST. For Gmail, it is usually smtp.gmail.com.";
    }

    if (full.includes("econnrefused")) {
        return "The SMTP server refused the connection. Check SMTP_HOST and SMTP_PORT.";
    }

    if (full.includes("etimedout") || full.includes("timeout")) {
        return "The SMTP connection timed out. Check your network, firewall, proxy/VPN, or whether the port is blocked.";
    }

    if (full.includes("self signed") || full.includes("certificate") || full.includes("tls")) {
        return "TLS/SSL certificate verification failed. Make sure the port and secure setting match. Gmail usually uses port 465 with secure=true.";
    }

    if (
        full.includes("invalid login") ||
        full.includes("auth") ||
        full.includes("535") ||
        full.includes("username and password not accepted")
    ) {
        return "Email authentication failed. For Gmail, do not use your normal login password. Use a 16-character App Password instead.";
    }

    if (full.includes("missing credentials")) {
        return "Missing email credentials. Check SMTP_USER and SMTP_PASS.";
    }

    return `Unknown email configuration error: ${message || response || code || "no additional error details"}`;
}

function validateEmailConfigValues({ host, port, user, pass, mailTo }) {
    const errors = [];

    if (!host || !String(host).trim()) {
        errors.push("SMTP host cannot be empty.");
    }

    if (!isValidSmtpPort(port)) {
        errors.push("SMTP port must be a number between 1 and 65535.");
    }

    if (!isValidEmailAddress(user)) {
        errors.push("Sender email address format is invalid.");
    }

    if (!pass || !String(pass).trim()) {
        errors.push("Email app password / password cannot be empty.");
    }

    if (!isValidEmailAddress(mailTo)) {
        errors.push("Destination email address format is invalid.");
    }

    return errors;
}

async function verifyEmailConfig() {
    console.log(chalk.blue(`[${getPacificTime()}] Verifying email configuration (email_info.env)...`));

    const currentConfig = {
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        mailTo: process.env.MAIL_TO
    };

    const validationErrors = validateEmailConfigValues(currentConfig);

    if (validationErrors.length > 0) {
        console.log(chalk.red(`[${getPacificTime()}] Email configuration format check failed:`));
        for (const err of validationErrors) {
            console.log(chalk.red(`  - ${err}`));
        }
        return false;
    }

    try {
        initTransporter();
        await transporter.verify();
        console.log(chalk.green(`[${getPacificTime()}] Email configuration verified successfully. Email alerts are enabled.`));
        return true;
    } catch (error) {
        console.log(chalk.red(`[${getPacificTime()}] Email configuration verification failed.`));
        console.log(chalk.red(`Reason: ${explainEmailVerifyError(error)}`));

        if (DEBUG_HTTP) {
            console.log(chalk.gray(`[DEBUG] Nodemailer error code: ${error?.code || "<none>"}`));
            console.log(chalk.gray(`[DEBUG] Nodemailer command: ${error?.command || "<none>"}`));
            console.log(chalk.gray(`[DEBUG] Nodemailer response: ${error?.response || "<none>"}`));
        }

        return false;
    }
}

async function configureEnvFile() {
    console.log(chalk.cyan("\n=== Email Setup Wizard ==="));
    console.log(chalk.gray("If you use Gmail, use a 16-character App Password instead of your normal login password."));
    console.log(chalk.gray("Gmail App Password guide: https://github.com/Alan-Huangzy233/SeatCheckingForOSU#%E6%AD%A5%E9%AA%A4-2%E5%87%86%E5%A4%87%E9%82%AE%E7%AE%B1%E6%8E%88%E6%9D%83%E7%A0%81-prerequisite\n"));

    const envQs = [
        {
            prompt: chalk.yellow("Enter SMTP server host (press Enter for default smtp.gmail.com): "),
            validate: () => true
        },
        {
            prompt: chalk.yellow("Enter SMTP port (press Enter for default 465): "),
            validate: ans => {
                const value = ans.trim() || "465";
                if (isValidSmtpPort(value)) return true;
                console.log(chalk.red("SMTP port must be a number between 1 and 65535."));
                return false;
            }
        },
        {
            prompt: chalk.yellow("Enter your sender email address: "),
            validate: ans => {
                if (isValidEmailAddress(ans)) return true;
                console.log(chalk.red("Invalid sender email address format. Please try again."));
                return false;
            }
        },
        {
            prompt: chalk.yellow("Enter your email app password / password: "),
            validate: ans => {
                if (ans.trim().length > 0) return true;
                console.log(chalk.red("Email app password / password cannot be empty."));
                return false;
            }
        },
        {
            prompt: chalk.yellow("Enter the destination email address for alerts: "),
            validate: ans => {
                if (isValidEmailAddress(ans)) return true;
                console.log(chalk.red("Invalid destination email address format. Please try again."));
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
        console.log(chalk.red("\nEmail configuration failed local format validation:"));
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

        console.log(chalk.red("\nEmail configuration was not saved because SMTP verification failed."));
        console.log(chalk.red(`Reason: ${explainEmailVerifyError(error)}`));

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
        console.log(chalk.green("\nEmail configuration verified and saved to email_info.env."));
        return true;
    } catch (error) {
        console.log(chalk.red(`\nEmail configuration verified, but failed to write email_info.env: ${error.message}`));
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
        console.log(chalk.green(`[${getPacificTime()}] [${courseKey}] Alert email sent, MessageID: ${info.messageId}`));
    } catch (err) {
        console.error(chalk.red(`[${getPacificTime()}] [${courseKey}] Failed to send email: ${err.message}`));
    }
}

// ================= Module 2: Private Account and Auto-Registration System =================
async function configureUserEnvFile() {
    console.log(chalk.cyan("\n=== Authorization Credential Setup ==="));
    console.log(chalk.white("Extract the following three values from the batch or classRegistration request in the browser Network panel:"));

    const cookie = await askQuestion(chalk.yellow("\n1. Paste Cookie (stickounet=...; JSESSIONID=...):\n> "));
    const token = await askQuestion(chalk.yellow("2. Paste X-Synchronizer-Token:\n> "));
    const sessionId = await askQuestion(chalk.yellow("3. Paste uniqueSessionId:\n> "));

    if (!cookie.trim() || !token.trim() || !sessionId.trim()) {
        console.log(chalk.red("Missing required values. Configuration failed."));
        return false;
    }

    USER_COOKIE = cookie.trim();
    USER_TOKEN = token.trim();
    USER_SESSION_ID = sessionId.trim();

    const envContent = `USER_COOKIE="${USER_COOKIE}"\nUSER_TOKEN="${USER_TOKEN}"\nUSER_SESSION_ID="${USER_SESSION_ID}"\n`;
    fs.writeFileSync("./user_info.env", envContent, { encoding: "utf8" });
    console.log(chalk.green("\nPrivate credentials have been saved to user_info.env."));
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
            console.log(chalk.bgRed.white("\n[Critical Warning] Private session expired. Auto-registration has been paused. Please capture fresh credentials."));
            enableAutoRegister = false;
        } else {
            console.log(chalk.gray(`[${getPacificTime()}] [Heartbeat] Private session is still valid.`));
        }
    } catch {
        console.log(chalk.yellow(`[${getPacificTime()}] [Heartbeat] Network issue during heartbeat request.`));
    }
}

async function executeRegistration(course, crn) {
    const courseStr = `${course.subject} ${course.courseNumber} (CRN: ${crn})`;
    console.log(chalk.bgMagenta.white(`\n[${getPacificTime()}] Starting standard registration flow: ${courseStr}...`));

    try {
        if (!USER_COOKIE || !USER_TOKEN || !USER_SESSION_ID) {
            throw new Error("Private credentials are incomplete: missing USER_COOKIE / USER_TOKEN / USER_SESSION_ID.");
        }

        console.log(chalk.gray("[DEBUG] 1/3 Adding the course to the summary/cart..."));
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
            throw new Error("Step 1 was redirected to the login flow. The private session has expired. Please recapture Cookie / Token / uniqueSessionId.");
        }

        const addRawText = await addRes.text();
        console.log(chalk.yellow(`\n[DEBUG] Raw addRegistrationItem response:\n${addRawText.substring(0, 1200)}\n`));

        const addData = tryParseJson(addRawText, "Step 1 addRegistrationItem");

        if (!addData.success) {
            throw new Error(`Step 1 failed: ${addData.message || "addRegistrationItem did not succeed."}`);
        }

        let courseTemplate = addData.model || null;

        if (!courseTemplate) {
            console.log(chalk.gray("[DEBUG] 2/3 addRegistrationItem did not return a model directly. Trying fallback endpoint getRegistrationEvents..."));

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
                throw new Error("Step 2 was redirected. The private session has expired.");
            }

            const eventRaw = await eventRes.text();
            console.log(chalk.yellow(`\n[DEBUG] Raw getRegistrationEvents response:\n${eventRaw.substring(0, 1200)}\n`));

            const eventData = tryParseJson(eventRaw, "Step 2 getRegistrationEvents");

            if (Array.isArray(eventData)) {
                courseTemplate = eventData.find(item => String(item.courseReferenceNumber) === String(crn));
            } else if (eventData && Array.isArray(eventData.data)) {
                courseTemplate = eventData.data.find(item => String(item.courseReferenceNumber) === String(crn));
            } else if (eventData?.data && String(eventData.data.courseReferenceNumber) === String(crn)) {
                courseTemplate = eventData.data;
            }
        }

        if (!courseTemplate) {
            throw new Error("Unable to obtain the course template data from addRegistrationItem or the fallback endpoint.");
        }

        courseTemplate.courseReferenceNumber = String(crn);
        courseTemplate.term = TERM;
        courseTemplate.courseRegistrationStatus = "RW";

        console.log(chalk.cyan(`[DEBUG] Key fields about to be submitted:\n${JSON.stringify({
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

        console.log(chalk.gray("[DEBUG] 3/3 Submitting batch registration request..."));
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
            throw new Error("Step 3 was redirected. The session is invalid during batch submit. Please recapture the three current credentials.");
        }

        const batchRawText = await batchRes.text();
        console.log(chalk.yellow(`\n[DEBUG] Raw batch response:\n${batchRawText.substring(0, 1200)}\n`));

        const batchData = tryParseJson(batchRawText, "Step 3 submitRegistration/batch");

        let isSuccess = false;
        let errMsg = "";

        if (batchData.success) {
            const specificError = findCrnErrors(batchData, crn);

            if (specificError) {
                errMsg = specificError.message || specificError.errorType || "The server returned a CRN-level error";
            } else {
                const returnedUpdates = Array.isArray(batchData?.data?.update) ? batchData.data.update : [];
                const returnedCreates = Array.isArray(batchData?.data?.create) ? batchData.data.create : [];
                const returnedAll = [...returnedUpdates, ...returnedCreates];
                const targetRecord = returnedAll.find(item => String(item.courseReferenceNumber) === String(crn));

                if (!targetRecord) {
                    errMsg = `batch returned success, but target CRN ${crn} was not found in response data. Manual verification is required.`;
                } else {
                    const status = String(targetRecord.courseRegistrationStatus || "").toUpperCase();
                    const statusIndicator = String(targetRecord.statusIndicator || "").toUpperCase();
                    const errorFlag = String(targetRecord.errorFlag || "").toUpperCase();
                    const recordMessage = String(targetRecord.message || "").trim();

                    console.log(chalk.cyan(`[DEBUG] Target CRN record returned by server:\n${JSON.stringify({
                        crn: targetRecord.courseReferenceNumber,
                        status,
                        statusDescription: targetRecord.courseRegistrationStatusDescription || "",
                        statusIndicator,
                        errorFlag,
                        message: recordMessage
                    }, null, 2)}\n`));

                    if (errorFlag === "F" || statusIndicator === "F") {
                        errMsg = recordMessage || `Target CRN ${crn} was marked as failed by the server.`;
                    } else if (recordMessage) {
                        const lowerMsg = recordMessage.toLowerCase();

                        if (
                            lowerMsg.includes("duplicate") ||
                            lowerMsg.includes("already") ||
                            lowerMsg.includes("existing registration")
                        ) {
                            isSuccess = true;
                            errMsg = recordMessage;
                        } else {
                            errMsg = recordMessage;
                        }
                    } else if (status === "RW") {
                        isSuccess = true;
                    } else {
                        errMsg = `Target CRN ${crn} returned an unexpected status: status=${status}, statusIndicator=${statusIndicator}`;
                    }
                }
            }
        } else {
            errMsg = batchData.message || batchData.errorMessage || "batch request was rejected by the server";
        }

        if (isSuccess) {
            console.log(chalk.bgGreen.black(`\n Registration succeeded: ${courseStr} has been submitted successfully. \n`));
            successfullyRegisteredCRNs.add(String(crn));

            const mailSubject = `Registration succeeded: ${courseStr}`;
            const body = `
                <h2>Registration Success Notification</h2>
                <p>The system has successfully submitted <b>${courseStr}</b>.</p>
                <p>Note: ${errMsg || "Operation completed without exceptions."}</p>
                <p>Please check the OSU registration system immediately to verify your final schedule.</p>
            `;

            await sendEmailAlert(`SUCCESS_${crn}`, mailSubject, body, true);
        } else {
            console.log(chalk.bgRed.white(`\n Registration failed: ${courseStr} was not completed. Reason: ${errMsg} \n`));

            const failSubject = `Registration failed: ${courseStr}`;
            const failBody = `
                <p>Attempted to register <b>${courseStr}</b>, but the operation did not complete.</p>
                <p>Error reason: <b style="color:red">${errMsg}</b></p>
                <p>Open the web registration page to confirm the current Cart / Summary status, and recapture the three credentials if needed.</p>
            `;

            await sendEmailAlert(`FAIL_${crn}`, failSubject, failBody, true);
        }
    } catch (error) {
        console.error(chalk.red(`[${getPacificTime()}] Auto-registration interrupted: ${error.message}`));
    }
}

// ================= Module 3: Term and Search Session =================
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
        throw new Error("termSelection was redirected. Unable to initialize search session.");
    }

    const html = await res.text();

    const tokenMatch =
        html.match(/name="synchronizerToken"\s+content="([^"]+)"/i) ||
        html.match(/content="([^"]+)"\s+name="synchronizerToken"/i);

    if (!tokenMatch || !tokenMatch[1]) {
        console.log(chalk.red("[DEBUG] First 1000 characters of termSelection page:"));
        console.log(html.slice(0, 1000));
        throw new Error("Unable to parse synchronizerToken from termSelection page.");
    }

    dynamicToken = tokenMatch[1];
    console.log(chalk.gray(`[DEBUG] Search session initialized successfully, token=${dynamicToken.slice(0, 8)}...`));
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
            "Accept-Language": "en-US,en;q=0.9",
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
        throw new Error("getTerms was redirected. The search session may be invalid.");
    }

    const text = await res.text();
    const terms = tryParseJson(text, "getTerms");

    if (!Array.isArray(terms)) throw new Error("getTerms did not return an array.");
    return terms;
}

async function chooseTermFromBanner() {
    console.log(chalk.bgCyan.black(" [Step 1: Fetch Available Terms from Banner] "));

    const terms = await fetchAvailableTerms();

    const selectableTerms = terms.filter(term => {
        const description = String(term.description || "").toLowerCase();
        return !description.includes("view only");
    });

    if (selectableTerms.length === 0) {
        throw new Error("Banner did not return any registerable terms. All returned terms may be View Only.");
    }

    console.log(chalk.cyan("\nAvailable registerable terms returned by Banner:"));
    selectableTerms.forEach((term, index) => {
        console.log(`  [${index + 1}] ${term.description}  (${term.code})`);
    });

    while (true) {
        const ans = (await askQuestion(chalk.yellow("\nSelect the term number to monitor: "))).trim();
        const index = Number(ans) - 1;

        if (Number.isInteger(index) && index >= 0 && index < selectableTerms.length) {
            TERM = String(selectableTerms[index].code);
            console.log(chalk.green(`\nMonitoring term locked to: ${selectableTerms[index].description} (${TERM})`));
            return;
        }

        console.log(chalk.red("Invalid option. Please try again."));
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
            throw new Error("term/search was redirected. The term may be invalid or the search session was not bound successfully.");
        }

        const termText = await termRes.text();
        if (DEBUG_HTTP) console.log(chalk.gray(`[DEBUG] term/search response preview: ${termText.slice(0, 300)}`));

        lastRefreshTime = Date.now();
        console.log(chalk.green(`[${getPacificTime()}] Search session refreshed successfully, TERM=${TERM}, token=${dynamicToken.slice(0, 8)}...`));
    } catch (e) {
        console.error(chalk.red(`[${getPacificTime()}] Failed to fetch guest credentials: ${e.message}`));
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
        if (DEBUG_HTTP) console.log(chalk.yellow(`[DEBUG] resetSearch ignored error: ${e.message}`));
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
            "Accept-Language": "en-US,en;q=0.9",
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
        throw new Error(`searchResults request failed: HTTP ${res.status}`);
    }

    try {
        return JSON.parse(text);
    } catch {
        console.log(chalk.red("[DEBUG] searchResults did not return valid JSON. Raw response preview:"));
        console.log(text.slice(0, 1200));
        throw new Error("searchResults returned HTML or an error page instead of JSON. Usually caused by mismatched token, cookie, term, or referer.");
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
            source: "Banner SSB real-time data",
            maxEnroll: extractNumberFromHtmlByLabels(html, ["Enrollment Maximum", "Maximum Enrollment", "Max Enroll", "Max Enrl"]),
            enrollment: extractNumberFromHtmlByLabels(html, ["Enrollment Actual", "Actual Enrollment", "Actual Enrl", "Enrollment"]),
            seatsAvailable: extractNumberFromHtmlByLabels(html, ["Enrollment Seats Available", "Seats Available", "Seats Avail", "Remaining Seats"]),
            waitCapacity: extractNumberFromHtmlByLabels(html, ["Waitlist Capacity", "Waitlist Maximum", "Waitlist Max"]),
            waitCount: extractNumberFromHtmlByLabels(html, ["Waitlist Actual", "Waitlist Count", "Actual Waitlist", "Wait Count"]),
            waitAvailable: extractNumberFromHtmlByLabels(html, ["Waitlist Seats Available", "Waitlist Available", "Wait Available"])
        };
    } catch (err) {
        console.log(chalk.yellow(`[${getPacificTime()}] [CRN ${crn}] Failed to fetch Banner enrollment info: ${err.message}`));
        return null;
    }
}

// ================= Module 4: Backup Waitlist Query and Data Enrichment =================
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
        _mainDataSource: "Banner SSB searchResults quick scan data",
        _waitlistSource: "Banner SSB searchResults quick scan data",
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
        section._waitlistSource = bannerInfo.source || "Banner SSB real-time data";
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
                "Accept-Language": "en-US,en;q=0.9",
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
            console.log(chalk.yellow(`[${getPacificTime()}] [${subject} ${courseNumber}] CRN ${crn} backup source HTTP ${res.status}`));
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
                if (DEBUG_HTTP) console.log(chalk.yellow(`[DEBUG] Failed to parse all_sections__data: ${err.message}`));
            }
        }

        return {
            source: "classes.oregonstate.edu backup data",
            waitlistStale: true,
            maxEnroll,
            enrollment,
            seatsAvailable,
            waitCapacity: toIntOrNull(data.waitlist_capacity),
            waitCount: toIntOrNull(data.ssbsect_wait_count),
            waitAvailable: toIntOrNull(data.ssbsect_wait_avail)
        };
    } catch (err) {
        console.log(chalk.yellow(`[${getPacificTime()}] [${subject} ${courseNumber}] CRN ${crn} backup waitlist query failed: ${err.message}`));
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
        ? " Waitlist comes from a backup source and may be delayed, not real-time data"
        : "";

    return [
        `CRN: ${c.courseReferenceNumber}`,
        `Title: ${c.courseTitle || c.title || "Unknown"}`,
        `Section: ${c.sequenceNumber || c.section || "Unknown"}`,
        `Campus: ${c.campusDescription || c.campus || "Unknown"}`,
        `Type: ${c.scheduleTypeDescription || c.scheduleType || "Unknown"}`,
        `Match Reason: ${c._matchReason || "Criteria matched"}`,
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
        ? `<br/><span style="color:#b45309;"><b>Note:</b> Waitlist data comes from the classes.oregonstate.edu backup source and may be delayed, not real-time data.</span>`
        : "";

    return `
        <li style="margin-bottom: 18px;">
            <b>CRN:</b> ${c.courseReferenceNumber}<br/>
            <b>Title:</b> ${c.courseTitle || c.title || "Unknown"}<br/>
            <b>Section:</b> ${c.sequenceNumber || c.section || "Unknown"}<br/>
            <b>Campus:</b> ${c.campusDescription || c.campus || "Unknown"}<br/>
            <b>Type:</b> ${c.scheduleTypeDescription || c.scheduleType || "Unknown"}<br/>
            <b>Match Reason:</b> ${c._matchReason || "Criteria matched"}<br/>
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

// ================= Module 5: Core Monitoring Logic =================
async function checkPerfectSection(course) {
    const { subject, courseNumber, checkOnlineOnly, monitorMode } = course;
    const modeText = checkOnlineOnly ? "[Online]" : "[In-Person]";
    const typeText = monitorMode === "1" ? "[Available Seat]" : monitorMode === "2" ? "[Waitlist]" : "[Seat or Waitlist]";
    const courseKey = `${subject}_${courseNumber}_${checkOnlineOnly ? "Online" : "InPerson"}_M${monitorMode}`;

    try {
        const json = await fetchCourseData(subject, courseNumber);

        if (!json || !json.success || !Array.isArray(json.data)) {
            console.log(chalk.yellow(`[${getPacificTime()}] [${subject} ${courseNumber}] searchResults did not return valid data.`));
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
                if (hasSeat) addCandidate(candidateMap, c, "Seat available");
                continue;
            }

            if (monitorMode === "2") {
                if (hasWaitlist) {
                    addCandidate(candidateMap, c, "Waitlist available");
                } else if (shouldUseBackupWaitlist(c)) {
                    backupWaitlistCandidates.push(c);
                }
                continue;
            }

            if (hasSeat) addCandidate(candidateMap, c, "Seat available");
            if (hasWaitlist) addCandidate(candidateMap, c, "Waitlist available");

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
                    `[${getPacificTime()}] [${subject} ${courseNumber}] CRN ${crn} is full, Banner waitlist did not match, using backup source to confirm waitlist...`
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
                        _mainDataSource: "Banner SSB searchResults + classes.oregonstate.edu backup supplement",
                        _waitlistSource: backup.source,
                        _waitlistStale: true
                    };

                    addCandidate(candidateMap, backupSection, "Backup source confirmed waitlist available");
                }
            }
        }

        let availableCourses = Array.from(candidateMap.values());

        if (availableCourses.length === 0) {
            console.log(chalk.gray(`[${getPacificTime()}] Scanning ${subject} ${courseNumber} ${modeText}${typeText}, no open seat or available waitlist yet...`));
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
                        `[${getPacificTime()}] [${subject} ${courseNumber}] CRN ${c.courseReferenceNumber} matched as a candidate, but blocking restriction was detected: "${foundRestriction}"`
                    ));
                }
            } catch (err) {
                console.log(chalk.yellow(
                    `[${getPacificTime()}] [${subject} ${courseNumber}] CRN ${c.courseReferenceNumber} restriction check failed, not added as a candidate: ${err.message}`
                ));
            }
        }

        const unregisteredPerfect = perfectCourses.filter(c => !successfullyRegisteredCRNs.has(String(c.courseReferenceNumber)));

        if (unregisteredPerfect.length === 0) {
            console.log(chalk.gray(`[${getPacificTime()}] [${subject} ${courseNumber}] All candidates were already registered successfully or filtered out.`));
            return;
        }

        console.log(chalk.green(
            `\n[${getPacificTime()}] [${subject} ${courseNumber}] Found ${unregisteredPerfect.length} eligible course option(s) that may be registered.`
        ));

        for (const c of unregisteredPerfect) {
            console.log(chalk.green("\n  " + formatCourseConsoleLine(c)));
        }

        const detailsHtml = unregisteredPerfect.map(c => formatCourseEmailItem(c)).join("");
        const mailSubject = `Availability found for ${subject} ${courseNumber} ${modeText}${typeText}`;
        const body = `
            <h2>${subject} ${courseNumber} has course option(s) matching your requirements</h2>
            <p>Seat data is prioritized from Banner SSB. If Banner cannot confirm waitlist and the section is full, the program uses classes.oregonstate.edu as a backup waitlist source.</p>
            <p><b>Note:</b> Any waitlist data marked as backup-source data may be delayed and should not be treated as real-time data.</p>
            <ul>${detailsHtml}</ul>
        `;

        await sendEmailAlert(courseKey, mailSubject, body, false);

        if (enableAutoRegister) {
            const targetCrn = unregisteredPerfect[0].courseReferenceNumber;
            await executeRegistration(course, targetCrn);
        }
    } catch (error) {
        console.error(chalk.red(`[${getPacificTime()}] [${subject} ${courseNumber}] scan error: ${error.message}`));
    }
}

async function monitorAllCourses() {
    if (Date.now() - lastRefreshTime >= 300_000) {
        await refreshSession();
    }

    console.log(chalk.cyan(`\n--- Starting a new full scan (${getPacificTime()}) ---`));

    for (const course of COURSES_TO_MONITOR) {
        await checkPerfectSection(course);
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    setTimeout(monitorAllCourses, 15_000);
}

// ================= Interactive Setup and Program Entry =================
async function setupCoursesInteractively() {
    await chooseTermFromBanner();

    console.log(chalk.bgCyan.black("\n [Step 2: Configure Courses to Monitor] "));
    let addMore = true;

    while (addMore) {
        console.log(chalk.bold(`\n[Adding course #${COURSES_TO_MONITOR.length + 1}]`));

        const courseQs = [
            {
                prompt: chalk.yellow("Enter Subject (for example, CS, MTH): "),
                validate: ans => /^[A-Za-z]+$/.test(ans) ? true : (console.log(chalk.red("Invalid subject abbreviation.")), false)
            },
            {
                prompt: chalk.yellow("Enter Course Number (for example, 123, 456): "),
                validate: ans => /^\d+$/.test(ans) ? true : (console.log(chalk.red("Invalid course number.")), false)
            },
            {
                prompt: chalk.yellow("Monitor online sections only? (y/n, press Enter for default y): "),
                validate: ans => ["", "y", "n"].includes(ans.trim().toLowerCase()) ? true : (console.log(chalk.red("Invalid input.")), false)
            },
            {
                prompt: chalk.yellow("Select target: [1] Open seats only [2] Waitlist only [3] Seat or waitlist\nEnter (1/2/3, press Enter for default 3): "),
                validate: ans => ["", "1", "2", "3"].includes(ans) ? true : (console.log(chalk.red("Invalid option.")), false)
            }
        ];

        const courseAns = await askWithBack(courseQs);

        COURSES_TO_MONITOR.push({
            subject: courseAns[0].toUpperCase(),
            courseNumber: courseAns[1],
            checkOnlineOnly: courseAns[2].toLowerCase() !== "n",
            monitorMode: courseAns[3] || "3"
        });

        console.log(chalk.green(`Successfully added: ${courseAns[0].toUpperCase()} ${courseAns[1]}`));

        const moreInput = await askQuestion(chalk.green("\nAdd another course? (y/n, press Enter for default n): "));
        addMore = moreInput.trim().toLowerCase() === "y";
    }
}

(async () => {
    console.log(chalk.cyan("\n=== Welcome to OSU Course Monitor ==="));
    console.log(chalk.blue(`[${getPacificTime()}] Disclaimer: This program is for educational and research purposes only.`));

    console.log(chalk.bgMagenta.white("\n [Select Run Mode] "));
    console.log("  [1] Recon mode (detect availability and send email alerts only)");
    console.log("  [2] Auto-registration mode (automatically send registration requests when availability is detected)");

    let modeChoice;

    while (true) {
        modeChoice = (await askQuestion(chalk.yellow("Enter your choice (1 or 2): "))).trim();
        if (modeChoice === "1" || modeChoice === "2") break;
        console.log(chalk.red("Invalid option. Please enter 1 or 2."));
    }

    if (modeChoice === "2") {
        enableAutoRegister = true;

        while (!USER_COOKIE || !USER_TOKEN || !USER_SESSION_ID) {
            const wantToConfig = await askQuestion(chalk.yellow("\nThe three credentials are required to enable auto-registration. Configure now? (y/n): "));

            if (wantToConfig.trim().toLowerCase() === "n") {
                console.log(chalk.magenta("Downgraded to recon mode (alerts only)."));
                enableAutoRegister = false;
                break;
            }

            await configureUserEnvFile();
        }

        if (enableAutoRegister) {
            console.log(chalk.green(`\nPrivate credentials loaded. Token [${USER_TOKEN.substring(0, 8)}...]`));
            setInterval(privateHeartbeat, 4 * 60 * 1000);
            console.log(chalk.bgGreen.black(" Auto-registration engine is active and heartbeat has started. "));
        }
    }

    if (!await verifyEmailConfig()) {
        console.log(chalk.bgRed.white("\n Warning: email configuration verification failed "));
        console.log("  [1] Continue running (console only)  [2] Configure email settings  [3] Exit");

        while (true) {
            const ans = (await askQuestion(chalk.yellow("Select (1/2/3): "))).trim();

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

    console.log(chalk.magenta(`\n[${getPacificTime()}] Setup complete. Starting monitor...`));
    await refreshSession();
    await monitorAllCourses();
})();