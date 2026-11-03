// Settings: the account, how fresh the data is, and display preferences (SettingsModel in the iPhone app).
'use strict';

// ---------- Model ----------
const setPref = (k, v) => optimistic('settings', 'prefs', p => { if (v == null) delete p[k]; else p[k] = v; return p; });
/// A setting's menu changed: "true"/"false" are on and off, "system" is the default (no value saved).
function changePref(k, v) { setPref(k, v === 'true' ? true : v === 'false' ? false : v === 'system' ? null : v); applyTheme(); }

// ---------- Views ----------
function settingsScreen() {
  const fresh = (label, stamp) => { const d = stamp ? new Date(stamp) : null, h = d ? (Date.now() - d) / 36e5 : 1e9; const c = h <= 7 ? 'var(--green)' : h <= 72 ? 'var(--orange)' : 'var(--red)';
    return `<div class="row"><span class="dot" style="width:10px;height:10px;background:${c}"></span><span class="grow">${label}</span><span class="val">${d ? esc(ago(d)) : 'never'}</span></div>`; };
  const sel = (key, opts, def) => `<select data-pref="${key}">${opts.map(([v, l]) => `<option value="${v}" ${String(S.prefs[key] ?? def) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<div class="head"><h1>Settings</h1></div>
  <div class="group-title">Account</div><div class="group"><div class="row"><span class="grow">Signed in as</span><span class="val">${esc(S.user.email)}</span></div><div class="row"><span class="grow" style="color:var(--label2);font-size:15px">Same data as the iPhone app. Changes here show up there after its next sync, and the other way around.</span></div></div>
  <div class="group-title">Data freshness</div><div class="group">${fresh('Calendar sync', S.prefs.lastCalendarSync)}${fresh('Moodle sync', S.prefs.lastMoodleSync)}</div>
  <div class="group-foot">The cloud sync runs every hour, and Claude every evening. Connecting Moodle and the Update now buttons are in the iPhone app.</div>
  <div class="group-title">Display</div><div class="group"><div class="row"><span class="grow">Appearance</span>${sel('appearance', [['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']], 'system')}</div>
    <div class="row"><span class="grow">Dates</span>${sel('dateStyle', ['d/MMM', 'd MMM', 'MMM d', 'd/M', 'd.M'].map(s => [s, s.replace('d', '21').replace('MMM', 'Oct').replace('M', '10')]), 'd/MMM')}</div>
    <div class="row"><span class="grow">Day of the week</span>${sel('showWeekday', [['true', 'On'], ['false', 'Off']], 'true')}</div>
    <div class="row"><span class="grow">Ask how it went</span>${sel('askReflection', [['true', 'On'], ['false', 'Off']], 'true')}</div></div>
  <div class="group"><button class="row" data-go="feed"><span class="grow">Updates and insights</span><span class="chev"></span></button><a class="row" href="legacy.html"><span class="grow" style="color:var(--label)">Old web version</span><span class="chev"></span></a></div>
  <div class="group"><button class="row" data-signout style="color:var(--red)">Sign out</button></div>`;
}
