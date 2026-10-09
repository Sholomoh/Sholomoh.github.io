# Media messaging and voice notes (free-plan compatible)

This patch adds image, video, audio, and document attachments to direct messages, plus voice-note recording for messages and stories. Voice recording automatically stops at 2:00. The browser uploads recordings using the site's existing unsigned Cloudinary upload preset; Firebase Cloud Functions are not used.

## Deploy

1. Back up your current repository and Firestore rules.
2. Replace the corresponding repository files with the files in this patch. The archive is arranged with website files at the repository root.
3. In Firebase Console → Firestore Database → Rules, publish the included `firestore.rules`. It retains the free-plan client-derived like/comment counter approach and expands message creation rules to allow validated attachment metadata.
4. Commit and push the website files to GitHub Pages.
5. Test with two test accounts: text messages, image, video, PDF/document, record/send/play a voice note, delete your own message, and post a voice note. Check admin tools and ordinary story posts still work.

## Limits and notes

- Voice notes are capped at 120 seconds by the browser recorder. The existing 20 MB upload limit also applies.
- Microphone recording requires HTTPS and browser permission; GitHub Pages is HTTPS. Older browsers without `MediaRecorder` can still send pre-recorded audio files.
- Cloudinary's unsigned upload preset must permit the relevant media formats and have sensible format/size restrictions in Cloudinary settings. Client-side limits are not a security boundary.
- This solution does not require Firebase Cloud Functions or a Firebase plan upgrade. It does use Cloudinary uploads and Firestore reads/writes as the existing app does.
- No live Firebase/Cloudinary deployment test has been performed from this patch environment.
