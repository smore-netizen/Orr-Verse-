/**
 * Notification runner for "One Chapter, Two Hearts".
 * Runs on a GitHub Actions schedule (every ~15 minutes) instead of
 * Firebase Cloud Functions — this keeps the whole project on Firebase's
 * free Spark plan with no billing account required.
 *
 * Sends the same five notification types:
 *  1. Daily nudge        — ~10:00am Pacific, if someone hasn't written yet
 *  2. Streak-at-risk     — ~8:00pm Pacific, if the day isn't finished yet
 *  3. Weekly recap       — ~6:00pm Pacific on Sundays
 *  4. Partner reflection ping  — whenever your partner's saved entry is new
 *  5. New prayer / reply — whenever one is added
 *
 * Requires a FIREBASE_SERVICE_ACCOUNT secret (the JSON key from
 * Firebase Console > Project Settings > Service accounts).
 */

const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const NAMES = { savanna: "Savanna", jack: "Jack" };

const BOOKS = [
  ["Genesis",50],["Exodus",40],["Leviticus",27],["Numbers",36],["Deuteronomy",34],
  ["Joshua",24],["Judges",21],["Ruth",4],["1 Samuel",31],["2 Samuel",24],["1 Kings",22],["2 Kings",25],["1 Chronicles",29],["2 Chronicles",36],["Ezra",10],["Nehemiah",13],["Esther",10],
  ["Job",42],["Psalms",150],["Proverbs",31],["Ecclesiastes",12],["Song of Solomon",8],
  ["Isaiah",66],["Jeremiah",52],["Lamentations",5],["Ezekiel",48],["Daniel",12],["Hosea",14],["Joel",3],["Amos",9],["Obadiah",1],["Jonah",4],["Micah",7],["Nahum",3],["Habakkuk",3],["Zephaniah",3],["Haggai",2],["Zechariah",14],["Malachi",4],
  ["Matthew",28],["Mark",16],["Luke",24],["John",21],["Acts",28],
  ["Romans",16],["1 Corinthians",16],["2 Corinthians",13],["Galatians",6],["Ephesians",6],["Philippians",4],["Colossians",4],["1 Thessalonians",5],["2 Thessalonians",3],["1 Timothy",6],["2 Timothy",4],["Titus",3],["Philemon",1],["Hebrews",13],["James",5],["1 Peter",5],["2 Peter",3],["1 John",5],["2 John",1],["3 John",1],["Jude",1],["Revelation",22]
];
const FLAT = [];
BOOKS.forEach(([book, count]) => { for (let c = 1; c <= count; c++) FLAT.push({ book, chapter: c }); });
function refFor(idx) { const f = FLAT[idx]; return f ? `${f.book} ${f.chapter}` : "today's chapter"; }

async function sendTo(who, data, title, body) {
  const tokenInfo = data.tokens && data.tokens[who];
  if (!tokenInfo || !tokenInfo.token) return;
  try {
    await admin.messaging().send({
      token: tokenInfo.token,
      notification: { title, body },
      webpush: { fcmOptions: { link: "/" } }
    });
    console.log(`Sent to ${who}: ${title}`);
  } catch (err) {
    console.error(`Failed to notify ${who}:`, err.message);
  }
}

async function main() {
  const ref = db.collection("workbook").doc("data");
  const snap = await ref.get();
  if (!snap.exists) { console.log("No workbook data yet — skipping."); return; }
  const data = snap.data();

  const idx = data.currentIndex || 0;
  const entry = (data.entries && data.entries[idx]) || {};
  const chapterRef = refFor(idx);

  const now = new Date();
  const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const hour = pacific.getHours();
  const dayOfWeek = pacific.getDay(); // 0 = Sunday
  const dateKey = pacific.toDateString();

  let notifState = data.notifState || {};
  const updates = {};

  // If we've moved to a new chapter since the last run, reset the
  // per-chapter "have I already notified about this" trackers.
  if (notifState.lastSeenChapterIdx !== idx) {
    notifState = { ...notifState, lastSeenRepliesCount: 0, lastSeenReflectionTs: {} };
    updates["notifState.lastSeenChapterIdx"] = idx;
    updates["notifState.lastSeenRepliesCount"] = 0;
    updates["notifState.lastSeenReflectionTs"] = {};
  }

  // 1) Daily nudge — ~10am Pacific window, once per day
  if (hour === 10 && notifState.lastDailyNudge !== dateKey) {
    for (const who of ["savanna", "jack"]) {
      const wrote = entry[who] && entry[who].reflection;
      if (!wrote) await sendTo(who, data, "Today's chapter is waiting", `${chapterRef} — a couple minutes together with it today.`);
    }
    updates["notifState.lastDailyNudge"] = dateKey;
  }

  // 2) Streak-at-risk — ~8pm Pacific window, only if the day isn't closed out
  if (hour === 20 && notifState.lastStreakRisk !== dateKey) {
    if (data.lastAdvancedDate !== dateKey) {
      const streakCount = (data.streak && data.streak.count) || 0;
      for (const who of ["savanna", "jack"]) {
        const wrote = entry[who] && entry[who].reflection;
        if (!wrote) await sendTo(who, data, "Don't lose today", `${chapterRef} is still open, and your ${streakCount}-day streak is riding on it.`);
      }
    }
    updates["notifState.lastStreakRisk"] = dateKey;
  }

  // 3) Weekly recap — ~6pm Pacific on Sundays
  if (dayOfWeek === 0 && hour === 18 && notifState.lastRecap !== dateKey) {
    const weekAgo = Date.now() - 7 * 86400000;
    const chaptersThisWeek = (data.advanceLog || []).filter(e => e.ts >= weekAgo).length;
    const prayersThisWeek = (data.prayers || []).filter(p => p.ts >= weekAgo).length;
    const body = chaptersThisWeek > 0
      ? `${chaptersThisWeek} chapter${chaptersThisWeek === 1 ? "" : "s"} together this week${prayersThisWeek ? `, ${prayersThisWeek} new prayer${prayersThisWeek === 1 ? "" : "s"}` : ""}. Take a minute to look back before the week resets.`
      : `A quiet week in the workbook — no pressure, just an open invitation to pick it back up.`;
    for (const who of ["savanna", "jack"]) await sendTo(who, data, "Your week, together", body);
    updates["notifState.lastRecap"] = dateKey;
  }

  // 4) Partner reflection ping
  const lastSeenTs = notifState.lastSeenReflectionTs || {};
  for (const who of ["savanna", "jack"]) {
    const partner = who === "savanna" ? "jack" : "savanna";
    const ts = entry[who] && entry[who].ts;
    const hasReflection = entry[who] && entry[who].reflection;
    if (hasReflection && ts && ts !== lastSeenTs[who]) {
      await sendTo(partner, data, `${NAMES[who]} just wrote`, `Their reflection on ${chapterRef} is up — go read it.`);
      updates[`notifState.lastSeenReflectionTs.${who}`] = ts;
    }
  }

  // 5a) New reply in the question thread
  const replies = entry.replies || [];
  const lastSeenReplies = notifState.lastSeenRepliesCount || 0;
  if (replies.length > lastSeenReplies) {
    const newest = replies[replies.length - 1];
    const partner = newest.author === "savanna" ? "jack" : "savanna";
    await sendTo(partner, data, `${NAMES[newest.author]} replied`, `On ${chapterRef}: "${(newest.text || "").slice(0, 80)}"`);
    updates["notifState.lastSeenRepliesCount"] = replies.length;
  }

  // 5b) New prayer request
  const prayers = data.prayers || [];
  const lastSeenPrayers = notifState.lastSeenPrayersCount || 0;
  if (prayers.length > lastSeenPrayers) {
    const newest = prayers[prayers.length - 1];
    const partner = newest.author === "savanna" ? "jack" : "savanna";
    await sendTo(partner, data, `${NAMES[newest.author]} added a prayer`, `"${(newest.text || "").slice(0, 80)}"`);
    updates["notifState.lastSeenPrayersCount"] = prayers.length;
  }

  if (Object.keys(updates).length) {
    await ref.update(updates);
    console.log("State updated:", updates);
  } else {
    console.log("Nothing to send this run.");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
