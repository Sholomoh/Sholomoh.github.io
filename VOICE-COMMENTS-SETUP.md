# Voice-note comments update

This patch adds voice-note recording to the main post-comment form in `members.js`.

Features:
- Record a voice comment in the browser.
- Recording automatically stops at 2 minutes (reuses `MAX_VOICE_MS`).
- Stop or cancel before posting.
- Optional text can accompany the voice note.
- Voice comments render with an audio player.
- Uploads use the existing Cloudinary unsigned upload configuration and existing 20 MB client-side cap.
- No Firebase Cloud Functions are added.

## Apply safely
1. Back up the current repository files.
2. Copy `members.js` and `styles.css` into the root of the GitHub Pages repository.
3. Review `firestore.rules` carefully against the rules currently in Firebase Console. This version permits optional `attachmentURL`, `attachmentType`, and `attachmentName` on `postComments`, but restricts the URL to `https://res.cloudinary.com/d98pty0j/` and type `audio`. If your Cloudinary cloud name differs, change that rule to your actual cloud name before publishing.
4. Publish the reviewed rules in Firebase Console > Firestore Database > Rules.
5. Run `node --check members.js` and `git diff --check`.
6. Test text-only comments, voice-only comments, text + voice comments, cancel recording, the 2-minute stop, audio playback, and deleting comments.

Important: the 2-minute recording limit is enforced by the browser code, not a trusted server. The existing unsigned Cloudinary upload preset should also have sensible upload restrictions configured in Cloudinary.
