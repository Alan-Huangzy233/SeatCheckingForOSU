// checkOnlineAvailability_Full_EN.js

import fetch from "node-fetch";
import chalk from "chalk";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config({ path: './email_info.env' });

// ================= Configuration Area =================
const TERM = "202503";            // Term (e.g. YYYY+Term, eg. 202603, Fall-01, Winter-02, Spring-03, Summer-04)
const SUBJECT = "CS";             // Subject
const COURSE_NUMBER = "123";      // Course Number

// NEW: Course Type Mode Toggle
// true  = Monitor Online courses only (Ecampus / Online)
// false = Monitor Offline courses only (Corvallis campus in-person classes)
const CHECK_ONLINE_ONLY = false;   

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

// ================= Email Configuration =================
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

const COOLDOWN_MS = 3600_000; // 1-hour cooldown
let lastMailTS = 0;

async function sendEmailAlert(subject, htmlBody) {
    const now = Date.now();
    if (now - lastMailTS < COOLDOWN_MS) {
        console.log(chalk.blue(`Cooldown active: Only ${((now - lastMailTS) / 1000).toFixed(1)}s since the last email.`));
        return;
    }
    try {
        const info = await transporter.sendMail({ from: process.env.MAIL_FROM, to: process.env.MAIL_TO, subject, html: htmlBody });
        lastMailTS = now;
        console.log(chalk.green(`Alert email sent successfully, MessageID: ${info.messageId}`));
    } catch (err) {
        console.error(chalk.red(`Failed to send email: ${err.message}`));
    }
}

// ================= Core Logic =================

async function refreshSession() {
    console.log(chalk.blue("Fetching the latest Cookie and Token..."));
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
        console.log(chalk.green(`Session initialized successfully! Token: ${dynamicToken.substring(0, 8)}...`));
    } catch (e) {
        console.error(chalk.red(`Failed to fetch credentials: ${e.message}`));
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
    const modeText = CHECK_ONLINE_ONLY ? "[Online]" : "[Offline]";
    try {
        const json = await fetchCourseData();
        if (!json || !json.success || !json.data) return;

        // 1. Find available courses based on mode
        const availableCourses = json.data.filter(c => {
            const isOnlineSchedule = c.scheduleTypeDescription === "Online";
            const isEcampus = c.campusDescription && c.campusDescription.includes("Ecampus");
            const isOnlineCourse = isOnlineSchedule || isEcampus;
            
            // Get Section number (usually sequenceNumber in Banner)
            const sectionNum = c.sequenceNumber || ""; 

            // Filter courses based on CHECK_ONLINE_ONLY flag
            if (CHECK_ONLINE_ONLY) {
                // [Online Mode]
                if (!isOnlineCourse) return false; 
            } else {
                // [Offline Mode]
                if (isOnlineCourse) return false; // If it's an online course, exclude it
                // NEW: Ensure offline course sections start with "0" (Corvallis main campus)
                if (!sectionNum.startsWith("0")) return false; 
            }

            // (If you only want real seats and not waitlist, remove || c.waitAvailable > 0)
            const hasSeats = c.seatsAvailable > 0 || c.waitAvailable > 0; 
            return hasSeats;
        });

        if (availableCourses.length === 0) {
            console.log(chalk.gray(`[${new Date().toLocaleTimeString()}] Scanning ${SUBJECT} ${COURSE_NUMBER} ${modeText}, no available seats...`));
            return;
        }

        // 2. Further check restrictions for available courses (Blacklist mode)
        const perfectCourses = [];
        
        // If any of the following keywords appear in the HTML, the course will be blocked
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
                        break; // Hit blacklist, break loop
                    }
                }

                if (!foundRestriction) {
                    perfectCourses.push(course); // Has seats AND no blacklist restrictions!
                } else {
                    console.log(chalk.yellow(`CRN ${course.courseReferenceNumber} has seats, but blocked: Detected "${foundRestriction}"`));
                }
            } catch (err) {
                console.error(chalk.red(`Failed to fetch restrictions for CRN ${course.courseReferenceNumber}: ${err.message}`));
            }
        }

        // 3. Finally, send email
        if (perfectCourses.length > 0) {
            console.log(chalk.green(`Found ${perfectCourses.length} perfect ${modeText} option(s) (Available seats + No restrictions)!`));

            let detailsHtml = perfectCourses.map(c => `
                <li style="margin-bottom: 10px;">
                    <b>CRN:</b> ${c.courseReferenceNumber}<br/>
                    <b>Title:</b> ${c.courseTitle}<br/>
                    <b>Type:</b> ${c.scheduleTypeDescription} (${c.campusDescription})<br/>
                    <b>Seats Available:</b> <span style="color:red; font-weight:bold">${c.seatsAvailable} / ${c.maximumEnrollment}</span><br/>
                    <b>Waitlist Available:</b> <span style="color:red; font-weight:bold">${c.waitAvailable}</span>
                </li>
            `).join("");

            const subject = `Found open and unrestricted ${SUBJECT} ${COURSE_NUMBER} ${modeText}`;
            const body = `
                <h2>Found immediately available ${modeText} sections for ${SUBJECT} ${COURSE_NUMBER}</h2>
                <p>The following section(s) have open seats and <b>NO DSC or Corvallis campus restrictions detected</b>:</p>
                <ul>${detailsHtml}</ul>
                <p>Please register as soon as possible!</p>
            `;
            await sendEmailAlert(subject, body);
        }

    } catch (error) {
        console.error(chalk.red(`Comprehensive check error: ${error.message}`));
    }
}

// ================= Program Initialization =================
(async () => {
    const modeText = CHECK_ONLINE_ONLY ? "[Online]" : "[Offline]";
    console.log(chalk.cyan(`Starting comprehensive monitoring for ${SUBJECT} ${COURSE_NUMBER} ${modeText} (Seats + DSC/Campus Restrictions)...`));
    await refreshSession();
    await checkPerfectSection();
    setInterval(checkPerfectSection, 15_000); 
})();