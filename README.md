# Science Bowl Question Bank

A complete web app for **writing, reviewing, and finalizing Science Bowl questions**, modeled on your Master Sheet workflow. It runs as a static site (no build step), so it deploys straight to GitHub Pages.

## What it does

- **Write** questions through dropdowns (Toss-Up/Bonus, Subject → Subcategory, MC/SA, Difficulty) and a LaTeX editor with a **live preview**.
- **LaTeX is validated automatically** before submission (balanced braces / `$…$` / environments, plus a real KaTeX parse, with `\ce{}` chemistry support) — invalid questions can't be submitted.
- **Duplicate detection** — as you type, the app surfaces similar existing questions with a match %, and warns again before you submit a likely duplicate.
- Each question gets a **numeric ID**, a **writer name + initials**, and a **status equal to the number of times it has been in review**.
- **Review panel**: any reviewer can sort/filter the queue, add comments, and **send a question back to its author**, or **approve it** into the finalized database.
- **Live suggested edits** — reviewers can propose edits to the question text in a Google-Docs / Overleaf “suggesting” style: changes are shown as a live tracked-changes diff, and the author can **Accept** or **Reject** each one. Suggestions appear in real time.
- **Finalized database**: searchable, filterable, sortable, and exportable to **CSV** (same columns as your Master Sheet) or **JSON**.
- **Bulk CSV import** (admin): load a spreadsheet in the same format as your Master Sheet; questions **enter at “in review”** and are assigned to a designated **“main” account**.
- **Automatic backups**: every few minutes the full question set is snapshotted locally (IndexedDB); admins can download or restore any snapshot.
- **Secure, invite-only accounts**: email + password with **email verification** and password reset (via Firebase). New sign-ups are **`pending` and can read/write nothing until an admin approves them** — enforced in the Firestore security rules, not just the UI. Admins approve, decline, or remove access from the Admin panel.

## Two ways to run it

| Mode | Setup | Accounts | Data | Use it for |
|------|-------|----------|------|------------|
| **Local demo** (default) | none | this browser only | this browser only (`localStorage`) | trying it out, screenshots, offline tinkering |
| **Firebase** | ~10 min | real, with email verification | shared cloud database | real use by your writing team |

The backend is chosen in [`js/config.js`](js/config.js) — everything else is identical. The app starts **empty** (no questions are pre-loaded); use the bulk importer to bring in your existing spreadsheet.

---

## Quick start (local demo)

ES modules need to be served over HTTP — opening `index.html` from the file system won't work. From this folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Create an account, click **(Demo) Simulate clicking the email link**, and you're in.

> To reset the demo, clear site data for the page (DevTools → Application → Clear storage).

---

## Loading your existing questions (bulk import)

1. Sign in with an **admin** account (see `adminEmails` below) and open **Admin → Import spreadsheet**.
2. Choose a **CSV** with the same headers as the Master Sheet:
   `TU/B, Subject, Type, Subcat, Question Text, IF SA - Answer Line, W, X, Y, Z, IF MC - Answer, Difficulty, Status, ID, Source, Writer Initials`
3. Pick the **“main” account** to assign them to (defaults to `mainAccountEmail` if that account exists). Every imported question is owned by that account and **enters the review queue** (`in review`, status 1). The original writer initials from the sheet are preserved.
4. The preview shows each row's LaTeX validity; rows with errors can be skipped automatically. Click **Import**.

Duplicate sheet rows that share an `ID` (your sheet repeats a row per review pass) are collapsed to one question, keeping the latest text.

---

## Going live with Firebase (real, secure, shared)

1. **Create a project** at <https://console.firebase.google.com>.
2. **Authentication** → *Sign-in method* → enable **Email/Password**.
3. **Firestore Database** → *Create database* (Production mode is fine — the rules below lock it down).
4. **Project settings → Your apps → Web app** → copy the config object.
5. Paste it into [`js/config.js`](js/config.js) and switch the backend:

   ```js
   backend: 'firebase',
   firebase: { apiKey: '…', authDomain: '…', projectId: '…',
               storageBucket: '…', messagingSenderId: '…', appId: '…' },
   adminEmails: ['you@example.com'],   // these accounts become admins on sign-up
   mainAccountEmail: 'main@example.com', // import target (optional; sign this account up)
   ```

6. **Deploy the security rules** in [`firestore.rules`](firestore.rules):
   - Firebase console → *Firestore → Rules* → paste → **Publish**, or
   - `firebase deploy --only firestore:rules`.

7. **First admins.** The emails in `adminEmails` (`js/config.js`) **and** the matching allowlist in `firestore.rules` (`isBootstrapAdmin()`) become admins automatically — they just sign up and verify their email, no console step. ⚠️ **Keep those two lists identical**; if you add/remove an admin later, update both files (and re-deploy the rules).

8. Sign up your main account (verify its email) and approve it from **Admin → Users**, then bulk-import your spreadsheet from **Admin → Import**.

> Using Firebase? Add your Pages domain under Firebase **Authentication → Settings → Authorized domains**.
> The Firebase *web* config is public by design — security comes from the rules. Don't commit private keys.

---

## Deploy to GitHub Pages

```bash
git init && git add . && git commit -m "Science Bowl Question Bank"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then: **Settings → Pages → Source: Deploy from a branch → `main` / root**. Your site appears at `https://<you>.github.io/<repo>/`.

---

## Backups

- While the app is open, all questions are snapshotted to this browser's IndexedDB every `backup.intervalMinutes` minutes (keeping the last `backup.keep`), and after each change.
- **Admin → Backups** lists snapshots; you can **Download** any as JSON (off-device copy) or **Restore** one.
- With the Firebase backend your data also lives server-side; the local snapshots are an extra safety net. For scheduled server-side exports, see Firestore's managed export/backup.

## Accounts, roles & the review workflow

- **Approval gate.** Roles are `pending` → `writer` / `reviewer` / `admin` (or `rejected`). A new account is `pending` and is blocked from all data until an admin approves it. With the local demo backend, the **first account becomes admin automatically** so you can manage the rest; with Firebase, bootstrap the first admin in the console (step 7 above).
- A question moves: **Draft → In review → (Changes requested / Suggestions → In review …) → Finalized.**
- **Status** = how many times the question has entered review (increments on each submit/resubmit).
- **Peer review by default**: any approved user can review *other people's* questions (never their own) and finalize them. Set `restrictFinalizeToReviewers: true` to limit finalizing to `reviewer`/`admin` roles.
- **Admins** approve/decline/remove members and set roles (Admin → Users — a badge on the Admin tab shows how many are waiting), run imports, and manage backups.

## Customizing the question taxonomy

All dropdown options live in [`js/taxonomy.js`](js/taxonomy.js). Edit that one file and the whole UI updates.

## LaTeX support

Mix text and math the way your sheet already does: `$…$`, `\(…\)`, `$$…$$`, `\[…\]`; `\textbf{}`, `\textit{}`, `\emph{}`, `\underline{}`; chemistry `\ce{H2O}`; plus `$^\circ$`, `\%`, `--`, `---`, `\\`. Validation runs the real KaTeX parser.

## Project structure

```
index.html            App shell; loads KaTeX + mhchem from CDN
css/styles.css        Styling
js/config.js          ← the file you edit (backend, Firebase keys, main account, thresholds)
js/taxonomy.js        Dropdown options
js/latex.js           LaTeX segmenting, rendering, validation
js/text.js            Similarity (duplicate detection) + word-level diff (suggestions)
js/csv.js             CSV parsing/mapping for bulk import
js/backup.js          Periodic IndexedDB snapshots (list / restore / download)
js/ui.js              DOM helpers (elements, modals, toasts)
js/app.js             Router + all views (Write, Mine, Review, Finalized, Admin)
js/store/index.js     Picks the backend from config
js/store/local.js     localStorage backend (demo)
js/store/firebase.js  Firestore + Firebase Auth backend
firestore.rules       Security rules for the Firebase backend
```
