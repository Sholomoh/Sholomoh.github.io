/* Sends a "please verify your email" message to every account whose email isn't verified yet.
   Run this on YOUR computer (never on the website). See README.md.

   You need: Node.js 18+, the Firebase service-account key (see README), and an email account with an
   app password (Gmail: https://myaccount.google.com/apppasswords).

   Set these before running:
     GOOGLE_APPLICATION_CREDENTIALS = path to your service-account .json file
     SMTP_USER                      = the email address you send from
     SMTP_PASS                      = the app password for that address
*/
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const PAUSE_MS = 1500;   // be gentle with the email provider
const SITE = 'https://sholomoh.github.io/members.html';

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS, SMTP_USER and SMTP_PASS first (see README.md).');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const transport = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let pageToken, sent = 0, skipped = 0, failed = 0;
  do {
    const page = await admin.auth().listUsers(500, pageToken);
    pageToken = page.pageToken;
    for (const u of page.users) {
      if (!u.email || u.emailVerified) { skipped++; continue; }
      try {
        const link = await admin.auth().generateEmailVerificationLink(u.email, { url: SITE });
        const name = u.displayName ? ' ' + u.displayName : '';
        await transport.sendMail({
          from: process.env.SMTP_USER,
          to: u.email,
          subject: 'Please verify your email address',
          text:
`Hello${name},

Please verify your email address so your account stays secure. Open this link:

${link}

After verifying, you can keep using the site as usual. If you didn't create an account, you can ignore this message.
`
        });
        sent++;
        console.log('sent to', u.email);
        await sleep(PAUSE_MS);
      } catch (err) {
        failed++;
        console.log('failed for', u.email, '-', err.message);
      }
    }
  } while (pageToken);
  console.log(`Done. Sent: ${sent}  Already verified or no email: ${skipped}  Failed: ${failed}`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
