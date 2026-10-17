# Verification reminders for existing accounts

Use this once, after you've turned on email verification, to remind members who haven't verified yet.
Keep it on your computer. Never upload it to the website or to GitHub.

## One-time setup

1. **Node.js** (version 18 or newer) from https://nodejs.org
2. **Service-account key:** Firebase console → Project settings → Service accounts → *Generate new private key*.
   Save the file somewhere safe outside your website folder, for example `~/firebase-key.json`.
3. **App password for email:** for Gmail, create one at https://myaccount.google.com/apppasswords (2-step verification must be on).
4. In a terminal, in this `admin-tools` folder, run:
   ```
   npm install firebase-admin nodemailer
   ```

## Send the reminders

Replace the example values with yours:

```
GOOGLE_APPLICATION_CREDENTIALS=~/firebase-key.json SMTP_USER=you@gmail.com SMTP_PASS=your-app-password node send-verification-reminders.js
```

On Windows PowerShell:
```
$env:GOOGLE_APPLICATION_CREDENTIALS="$HOME\firebase-key.json"; $env:SMTP_USER="you@gmail.com"; $env:SMTP_PASS="your-app-password"; node send-verification-reminders.js
```

The script prints one line per email and a summary at the end. Gmail allows a few hundred messages a day, so
run it again the next day if you have many accounts.

## Notes

- Each email contains a one-time verification link from Firebase, valid for a limited time.
- Accounts that are already verified are skipped.
- Grandfathered members keep full access even if they never verify. The reminder is a courtesy.
- Delete the key file from your computer when you're finished with this step, or keep it somewhere protected.
