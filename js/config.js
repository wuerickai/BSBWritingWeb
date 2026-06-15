// ────────────────────────────────────────────────────────────────────────────
//  CONFIGURATION  —  this is the only file most people need to edit.
// ────────────────────────────────────────────────────────────────────────────

export const CONFIG = {
  // App title shown in the header.
  appName: 'Science Bowl Question Bank',

  // Which backend to use:
  //   'local'    → browser localStorage. Zero setup, runs instantly, great for a
  //                demo or trying things out. NOT secure and NOT shared between
  //                people/devices. "Email verification" is simulated.
  //   'firebase' → real shared database + secure accounts + real email
  //                verification + password reset. Recommended for actual use.
  //                Fill in the `firebase` block below, then set this to 'firebase'.
  backend: 'firebase',

  // Paste your Firebase web-app config here (Firebase console → Project settings →
  // "Your apps" → Web app → Config). Only needed when backend = 'firebase'.
  firebase: {
    ////
  },

  // Emails listed here are auto-promoted to "admin" the first time they sign up.
  // Admins can manage everyone else's role from the Admin tab.
  adminEmails: [
    'admin@admin.com'
  ],

  // Require a verified email before a user can write or review.
  // Strongly recommended for the firebase backend.
  requireEmailVerification: true,

  // When true, a reviewer cannot review their own questions (they are hidden from
  // that reviewer's queue).
  hideOwnQuestionsFromReviewer: true,

  // Peer review: by default ANY verified user can review others' questions and
  // finalize them. Set this true to allow only 'reviewer'/'admin' roles to send a
  // question to the finalized database (everyone can still leave suggestions).
  restrictFinalizeToReviewers: false,

  // Bulk CSV import (Admin → Import) assigns every imported question to this
  // "main" account (it must be an existing signed-up account). If left blank, or
  // if no matching account exists, the import dialog defaults to the admin doing
  // the import. You can always change the owner in the import dialog.
  mainAccountEmail: '',

  // Duplicate detection thresholds (0–1 similarity).
  duplicate: {
    show: 0.55,    // show possible duplicates at/above this while writing
    confirm: 0.75, // require a confirmation on submit at/above this
  },

  // Automatic local backups (IndexedDB snapshots of all questions).
  backup: {
    intervalMinutes: 10, // how often to snapshot while the app is open
    keep: 20,            // how many snapshots to retain
  },
};
