// checkOnlineAvailability_Multi_EN.js

import fetch from "node-fetch";
import chalk from "chalk";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config({ path: './email_info.env' });

// ================= CONFIGURATION =================
const TERM = "202603";            // Term (e.g., YYYY+Term, like 202603)

// Multi-course monitoring list
// You can add as many courses as you want to monitor here
const COURSES_TO_MONITOR = [
    { subject: "CS", courseNumber: "175", checkOnlineOnly: true },  // Monitor CS 175 (Online)
    { subject: "CS", courseNumber: "312", checkOnlineOnly: true },  // Monitor CS 312 (Online)
];

// Base URL Configuration
const BASE_URL = "https://prodapps.isadm.oregonstate.edu/StudentRegistrationSsb/ssb";
const SEARCH_URL = `${BASE_URL}/searchResults/searchResults`;
const START_URL = `${BASE_URL}/classSearch/classSearch`;
const TERM_URL = `${BASE_URL}/term/search?mode=search`;
const RESET_URL = `${BASE_URL}/classSearch/resetDataForm`;
const RESTRICTIONS_URL = `${BASE_URL}/searchResults/getRestrictions`; 

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

let dynamicCookie = "";
let dynamicToken = "";
let lastRefreshTime = 0; // NEW: Tracks the last time the token was refreshed

// ================= UTILITY FUNCTIONS =================
// Get formatted Pacific Time
function getPacificTime() {
    return new Date().toLocaleString("en-US", { 
        timeZone: "America/Los_Angeles", 
        hour12: false 
    });
}

// ================= EMAIL CONFIGURATION =================
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

const COOLDOWN_MS = 3600_000; // 1 hour cooldown
// Record cooldown times separately for each course
const lastMailTSMap = new Map(); 

async function sendEmailAlert(courseKey, subject, htmlBody) {
    const now = Date.now();
    const lastTS = lastMailTSMap.get(courseKey) || 0;
    
    if (now - lastTS < COOLDOWN_MS) {
        console.log(chalk.blue(`[${getPacificTime()}] [${courseKey}] Cooldown: Only ${((now - lastTS) / 1000).toFixed(1)}s since last email alert.`));
        return;
    }
    
    try {
        const info = await transporter.sendMail({ from: process.env.MAIL_FROM, to: process.env.MAIL_TO, subject, html: htmlBody });
        lastMailTSMap.set(courseKey, now); // Record the send time for this specific course
        console.log(chalk.green(`[${getPacificTime()}] [${courseKey}] Alert email sent, MessageID: ${info.messageId}`));
    } catch (err) {
        console.error(chalk.red(`[${getPacificTime()}] [${courseKey}] Failed to send email: ${err.message}`));
    }
}

// ================= CORE LOGIC =================

async function refreshSession() {
    console.log(chalk.blue(`[${getPacificTime()}] Fetching latest Cookie and Token...`));
    try {
        const res = await fetch(START_URL, { headers: { "User-Agent": USER_AGENT } });
        let cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.raw()['set-cookie'] || []);
        if (cookies.length > 0) dynamicCookie = cookies.map(c => c.split(';')[0]).join('; ');

        const html = await res.text();
        const tokenMatch = html.match(/name="synchronizerToken"\s+content="([^"]+)"/i) || html.match(/content="([^"]+)"\s+name="synchronizerToken"/i);
        if (tokenMatch && tokenMatch[1]) dynamicToken = tokenMatch[1];
        else throw new Error("synchronizerToken not found.");

        const termRes = await fetch(TERM_URL, {
            method: "POST",
            headers: {
                "Cookie": dynamicCookie, "X-Synchronizer-Token": dynamicToken,
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": USER_AGENT, "X-Requested-With": "XMLHttpRequest"
            },
            body: new URLSearchParams({ term: TERM }).toString()
        });

        if (!termRes.ok) throw new Error(`Failed to bind term: ${termRes.status}`);
        
        lastRefreshTime = Date.now(); // Update the last refresh timestamp
        console.log(chalk.green(`[${getPacificTime()}] Session initialized successfully! Token: ${dynamicToken.substring(0, 8)}...`));
    } catch (e) {
        console.error(chalk.red(`[${getPacificTime()}] Failed to auto-fetch credentials: ${e.message}`));
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

// Accept subject and courseNumber as parameters
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

// Accept course object as parameter
async function checkPerfectSection(course) {
    const { subject, courseNumber, checkOnlineOnly } = course;
    const modeText = checkOnlineOnly ? "[Online]" : "[In-Person]";
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
            console.log(chalk.gray(`[${getPacificTime()}] Scanning ${subject} ${courseNumber} ${modeText}... No seats available currently.`));
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
                    console.log(chalk.yellow(`[${getPacificTime()}] [${subject} ${courseNumber}] CRN ${c.courseReferenceNumber} has seats, but was blocked: Detected "${foundRestriction}" restriction.`));
                }
            } catch (err) {
                console.error(chalk.red(`[${getPacificTime()}] Failed to fetch restrictions for CRN ${c.courseReferenceNumber}: ${err.message}`));
            }
        }

        if (perfectCourses.length > 0) {
            console.log(chalk.green(`[${getPacificTime()}] [${subject} ${courseNumber}] Found ${perfectCourses.length} perfect ${modeText} option(s) with available seats and NO restrictions!`));

            let detailsHtml = perfectCourses.map(c => `
                <li style="margin-bottom: 10px;">
                    <b>CRN:</b> ${c.courseReferenceNumber}<br/>
                    <b>Title:</b> ${c.courseTitle}<br/>
                    <b>Type:</b> ${c.scheduleTypeDescription} (${c.campusDescription})<br/>
                    <b>Seats Available:</b> <span style="color:red; font-weight:bold">${c.seatsAvailable} / ${c.maximumEnrollment}</span><br/>
                    <b>Waitlist Available:</b> <span style="color:red; font-weight:bold">${c.waitAvailable}</span>
                </li>
            `).join("");

            const mailSubject = `Available seats found for ${subject} ${courseNumber} ${modeText} (No Restrictions)`;
            const body = `
                <h2>Found ${modeText} options for ${subject} ${courseNumber} that you can register for immediately!</h2>
                <p>The following sections have seats available and <b>NO DSC or Corvallis campus restrictions detected</b>:</p>
                <ul>${detailsHtml}</ul>
                <p>Please head to the <a href="https://prodapps.isadm.oregonstate.edu/StudentRegistrationSsb/ssb/registration#">OSU Registration System</a> to complete your registration ASAP!</p>
            `;
            await sendEmailAlert(courseKey, mailSubject, body);
        }

    } catch (error) {
        console.error(chalk.red(`[${getPacificTime()}] [${subject} ${courseNumber}] Scan encountered an error: ${error.message}`));
    }
}

// Sequentially poll all courses
async function monitorAllCourses() {
    // 1. Proactively refresh the Token every 5 minutes (300,000 ms)
    if (Date.now() - lastRefreshTime >= 300_000) {
        console.log(chalk.magenta(`[${getPacificTime()}] 5 minutes have passed since last refresh. Proactively refreshing session...`));
        await refreshSession();
    }

    console.log(chalk.cyan(`\n--- Starting a new full scan (${getPacificTime()}) ---`));
    
    for (const course of COURSES_TO_MONITOR) {
        await checkPerfectSection(course);
        // Wait 2 seconds between checking each course to prevent server disconnects from rapid requests
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Wait 15 seconds after a full round before triggering the next round 
    // (using recursive setTimeout instead of setInterval to prevent overlapping due to network lag)
    setTimeout(monitorAllCourses, 15_000);
}

// ================= START PROGRAM =================
(async () => {
    console.log(chalk.blue(`[${getPacificTime()}] Disclaimer: This program is for educational and research purposes only. Do not use for any commercial or illegal activities.`));
    console.log(chalk.magenta(`[${getPacificTime()}] Starting multi-course monitor... Monitoring ${COURSES_TO_MONITOR.length} course(s) in total.`));
    await refreshSession();
    await monitorAllCourses(); 
})();