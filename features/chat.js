// Claude: the chat (ChatModel in the iPhone app). Claude answers on its next run.
'use strict';

// ---------- Views ----------
// A short thread with Claude. Its replies can carry cards (tasks and lectures) you can tap or add to your plan.
function chatScreen() {
  const msgs = S.chat, draft = S.chatDraft || {};
  const cards = (m) => { const its = (m.items || []).map(item).filter(Boolean); if (!its.length) return '';
    const add = its.filter(i => !inPlan(i.id) && !isHandled(i));
    return `<div class="chat-cards ${m.from === 'claude' ? '' : 'mine'}"><div class="cards">${its.map(i => card(i)).join('')}</div>${m.from === 'claude' && add.length ? `<button class="pill" data-addall="${esc(add.map(i => i.id).join(','))}">${add.length === 1 ? 'Add to your plan' : `Add these ${add.length} to your plan`}</button>` : ''}</div>`; };
  return `<button class="back" data-back>‹ Overview</button><div class="head"><h2>Claude</h2></div>
  ${msgs.length ? '' : '<div class="group pad"><b style="color:#af52de">✦ Talk to Claude</b><p style="color:var(--label2);font-size:15px;margin:6px 0 0">Ask about your semester, or tell Claude what’s useful and what isn’t. It can change your course rules, what matters most, and which tips you get.</p></div>'}
  <div class="chat">${msgs.map(m => `<div class="bubble ${m.from === 'claude' ? 'claude' : 'me'}" dir="auto">${esc(m.text)}</div><div class="when ${m.from === 'claude' ? '' : 'me'}">${m.from === 'claude' ? 'Claude · ' : ''}${esc(ago(m.at))}</div>${cards(m)}`).join('')}</div>
  <div class="composer">${(draft.items || []).length ? `<div class="attached">📎 ${draft.items.length} card${draft.items.length === 1 ? '' : 's'} attached <button data-unattach aria-label="Remove attached cards">✕</button></div>` : ''}
    <div style="display:flex;gap:8px;align-items:flex-end"><textarea rows="${(draft.text || '').length > 30 ? 2 : 1}" placeholder="Message Claude" data-chatdraft dir="auto">${esc(draft.text || '')}</textarea><button class="pill primary" data-chatsend>Send</button></div>
    <div class="group-foot" style="margin:6px 4px 0">Claude answers on its next run: every evening, or within a minute when you send from the iPhone app.</div></div>`;
}

// ---------- Model ----------
async function sendChat() {
  const d = S.chatDraft || {}, text = (d.text || '').trim(); if (!text) return;
  const at = new Date().toISOString(), id = 'm-' + at.replace(/\D/g, '').slice(0, 14);
  const doc = { id, kind: 'chat', from: 'you', text, at, ...(d.items?.length ? { items: d.items } : {}) };
  S.chatDraft = null; S.chat.push(doc); render();
  patch('note', id, () => doc);
}
/// "Ask Claude about it" on a plan slot: a draft about the slot, with its cards attached.
function askAboutSlot(id) { S.chatDraft = { text: `About my plan slot “${slotNames()[id]}”: `, items: slotItems(id).filter(Boolean).map(i => i.id) }; }
function unattachCards() { S.chatDraft = { ...(S.chatDraft || {}), items: [] }; }
function setChatDraftText(text) { S.chatDraft = { ...(S.chatDraft || {}), text }; }
