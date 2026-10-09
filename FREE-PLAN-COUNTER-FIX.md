# Free-plan like/comment counter fix

This patch does **not** use Cloud Functions and does not require upgrading Firebase to Blaze.

## What changed
- `firestore.rules` prevents clients from creating or editing post counter fields. New posts no longer store `likeCount` or `commentCount`.
- `members.js` derives counts from the actual `postLikes` and `postComments` documents, and removes direct counter writes from like, comment, moderation, and account-deletion flows.
- Like IDs are enforced as `postId_uid`, preventing multiple likes by the same account on the same post through custom document IDs.
- Existing counter fields on older posts are left in place but ignored by the updated client.

## Deploy safely
1. Back up your current `firestore.rules` and website files.
2. In Firebase Console → Firestore Database → Rules, replace the rules with the included `firestore.rules`, then publish.
3. Upload the updated `members.js` to the same path in your GitHub repository and commit it.
4. Test sign-in, post creation/edit/delete, like/unlike, comments/replies/edit/delete, report-based comment deletion, account deletion, and the admin privacy scrub tool.

## Free-plan trade-off
To avoid a backend, the client listens to the `postLikes` and `postComments` collections and counts the documents. This uses Firestore reads under your existing free quota. For a small community it can be reasonable; if those collections grow substantially, consider a server-maintained aggregate later. Do not restore direct client writes to `likeCount` or `commentCount`.

## Note
This is a source-level patch. It has not been deployed to Firebase or tested against your live project's data. Check your actual rules in the Firebase Console before publishing.
