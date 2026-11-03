// Signing in, and the password reset (SessionModel in the iPhone app). The calls themselves are in data.js.
'use strict';

function authScreen(mode = 'in', err = '') {
  $('#tabs').classList.add('hidden');
  $('#app').innerHTML = `<div class="auth"><img src="icons/icon-192.png" alt="" width="72" height="72" style="border-radius:16px"><h1 style="margin:12px 0 4px">Semester Catch-Up</h1><p style="color:var(--label2);margin:0 0 20px">Sign in with the same account as the iPhone app.</p>
  <form id="auth"><div class="group"><div class="row"><input type="email" name="email" placeholder="Email" autocomplete="email" required></div><div class="row"><input type="password" name="password" placeholder="Password" autocomplete="current-password" required></div></div>
  ${err ? `<div class="err">${esc(err)}</div>` : ''}<button class="pill primary wide" style="width:100%">Sign in</button></form>
  <button style="margin-top:14px;color:var(--accent);font-size:15px" id="forgot">Forgot password?</button></div>`;
  $('#auth').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target);
    const { error } = await signIn(f.get('email'), f.get('password')); if (error) authScreen('in', error.message); };
  $('#forgot').onclick = async () => { const email = $('#auth').email.value; if (!email) return authScreen('in', 'Type your email first.');
    const { error } = await resetPassword(email); authScreen('in', error ? error.message : 'Check your email for a reset link.'); };
}
