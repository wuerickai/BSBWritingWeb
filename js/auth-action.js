// ────────────────────────────────────────────────────────────────────────────
//  Custom Firebase email-action handler (auth-action.html).
//
//  Why this exists: many email providers (school/corporate mail, Outlook Safe
//  Links, Gmail scanning) pre-fetch every link in an email to scan it. Firebase's
//  DEFAULT handler applies the one-time action code as soon as the page loads, so
//  the scanner's fetch consumes it and the human then sees "expired or already
//  used". This page never consumes the code on load — it requires a real button
//  click, which scanners don't perform.
//
//  Set it up once: Firebase console → Authentication → Templates → (any
//  template) → pencil icon → "Customize action URL" →
//      https://<your-site>/auth-action.html
//  (One setting covers verification + password reset. The domain must also be in
//  Authentication → Settings → Authorized domains.)
// ────────────────────────────────────────────────────────────────────────────

import { CONFIG } from './config.js';

const V = '10.12.2';
const view = document.getElementById('view');

const params = new URLSearchParams(location.search);
const mode = params.get('mode');
const oobCode = params.get('oobCode');

function h(html) { view.innerHTML = `<div class="card center-card">${html}</div>`; }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const appLink = '<p style="margin-top:18px"><a class="btn primary" style="text-decoration:none" href="./">Open the app →</a></p>';

function explain(e) {
  const code = (e && e.code) || '';
  const map = {
    'auth/invalid-action-code': 'This link has already been used or is no longer valid. If you were verifying your email, it may already be verified — open the app and sign in. Otherwise request a fresh email.',
    'auth/expired-action-code': 'This link has expired. Request a fresh email and use it soon after it arrives.',
    'auth/user-disabled': 'This account has been disabled — contact an admin.',
    'auth/user-not-found': 'The account for this link no longer exists.',
    'auth/weak-password': 'Password must be at least 6 characters.',
  };
  return map[code] || (e && e.message) || String(e);
}

async function main() {
  if (!CONFIG.firebase || !CONFIG.firebase.apiKey) {
    h('<h2>Not configured</h2><p>This page needs the Firebase config in js/config.js.</p>');
    return;
  }
  if (!mode || !oobCode) {
    h(`<h2>Nothing to do here</h2>
       <p>This page handles links from account emails (verification, password reset). Open it from one of those emails — or head back to the app.</p>${appLink}`);
    return;
  }

  const appMod = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  const A = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
  const fbApp = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(CONFIG.firebase);
  const auth = A.getAuth(fbApp);

  if (mode === 'verifyEmail') {
    h(`<div class="gate-icon">✉️</div><h2>Confirm your email</h2>
       <p>Click the button below to finish verifying your email address.</p>
       <div class="col-gap"><button id="go" class="btn primary">Confirm my email</button></div>
       <div id="msg" class="form-msg"></div>`);
    document.getElementById('go').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        await A.applyActionCode(auth, oobCode);
        h(`<div class="gate-icon">✅</div><h2>Email verified!</h2>
           <p>You're all set. Open the app and sign in — if you were already signed in, click “I have verified — refresh”.</p>${appLink}`);
      } catch (e) {
        ev.target.disabled = false;
        document.getElementById('msg').className = 'form-msg error';
        document.getElementById('msg').textContent = explain(e);
      }
    });
    return;
  }

  if (mode === 'resetPassword') {
    // verifyPasswordResetCode only CHECKS the code (does not consume it), so it is
    // safe to run on load; the code is consumed by confirmPasswordReset on submit.
    let email = '';
    try { email = await A.verifyPasswordResetCode(auth, oobCode); }
    catch (e) { h(`<div class="gate-icon">⚠️</div><h2>Link problem</h2><p>${esc(explain(e))}</p>${appLink}`); return; }

    h(`<div class="gate-icon">🔑</div><h2>Choose a new password</h2>
       <p>Setting a new password for <strong>${esc(email)}</strong>.</p>
       <div class="col-gap">
         <input id="pw1" class="inp" type="password" placeholder="New password (min 6 characters)" autocomplete="new-password" />
         <input id="pw2" class="inp" type="password" placeholder="Repeat new password" autocomplete="new-password" />
         <button id="go" class="btn primary">Set new password</button>
       </div>
       <div id="msg" class="form-msg"></div>`);
    document.getElementById('go').addEventListener('click', async (ev) => {
      const p1 = document.getElementById('pw1').value, p2 = document.getElementById('pw2').value;
      const msg = document.getElementById('msg');
      msg.className = 'form-msg error';
      if (p1.length < 6) { msg.textContent = 'Password must be at least 6 characters.'; return; }
      if (p1 !== p2) { msg.textContent = 'Passwords don’t match.'; return; }
      ev.target.disabled = true;
      try {
        await A.confirmPasswordReset(auth, oobCode, p1);
        h(`<div class="gate-icon">✅</div><h2>Password updated</h2>
           <p>Your password has been changed. Sign in with the new one.</p>${appLink}`);
      } catch (e) {
        ev.target.disabled = false;
        msg.textContent = explain(e);
      }
    });
    return;
  }

  if (mode === 'recoverEmail' || mode === 'verifyAndChangeEmail') {
    h(`<div class="gate-icon">✉️</div><h2>Confirm this change</h2>
       <p>Click below to apply this account email change.</p>
       <div class="col-gap"><button id="go" class="btn primary">Confirm</button></div>
       <div id="msg" class="form-msg"></div>`);
    document.getElementById('go').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try { await A.applyActionCode(auth, oobCode); h(`<div class="gate-icon">✅</div><h2>Done</h2><p>The change has been applied.</p>${appLink}`); }
      catch (e) { ev.target.disabled = false; const m = document.getElementById('msg'); m.className = 'form-msg error'; m.textContent = explain(e); }
    });
    return;
  }

  h(`<h2>Unknown action</h2><p>This link uses an action ("${esc(mode)}") this page doesn't handle.</p>${appLink}`);
}

main();
