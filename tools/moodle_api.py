#!/usr/bin/env python3
"""Reads Moodle through its app API (the token the iPhone app's "Connect Moodle" saves) and prints a snapshot
in the same shape the browser snippet produces, for moodle_sync.py --moodle:

  moodle_api.py > snapshot.json && moodle_sync.py --moodle snapshot.json

Covers assignments and quizzes (dates and whether you submitted), and course announcements.
Recordings (Panopto) aren't part of Moodle's app API, so "panopto" stays empty.
Only reads; it never calls anything that submits or changes Moodle.

The token is read from the app's Supabase data (settings/moodle), or MOODLE_TOKEN in the environment.
Run with TZ=Asia/Jerusalem so dates come out in Israel time.
"""
import datetime as dt
import html
import http.client
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

from supabase_load import SSL, load_cfg, req, user_id

SITE = 'https://moodle.huji.ac.il/2026-27'
# Read-only functions this script may call.
ALLOWED = {
    'core_webservice_get_site_info', 'core_enrol_get_users_courses', 'mod_assign_get_assignments',
    'mod_assign_get_submission_status', 'mod_quiz_get_quizzes_by_courses', 'mod_quiz_get_user_attempts',
    'mod_forum_get_forums_by_courses', 'mod_forum_get_forum_discussions',
}


class TokenError(Exception):
    pass


def flatten(prefix, value, out):
    if isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            flatten(f'{prefix}[{i}]', v, out)
    elif isinstance(value, dict):
        for k, v in value.items():
            flatten(f'{prefix}[{k}]', v, out)
    else:
        out[prefix] = value


def ws(token, function, **args):
    assert function in ALLOWED, function
    form = {}
    for k, v in args.items():
        flatten(k, v, form)
    url = f'{SITE}/webservice/rest/server.php?' + urllib.parse.urlencode({'wstoken': token, 'wsfunction': function, 'moodlewsrestformat': 'json'})
    body = urllib.parse.urlencode(form).encode()
    # HUJI's server sometimes drops a connection; retry a few times before giving up on this call.
    for attempt in range(4):
        try:
            r = urllib.request.Request(url, data=body, headers={'User-Agent': 'SemesterCatchUp/1.0'})
            with urllib.request.urlopen(r, timeout=60, context=SSL) as resp:
                data = json.loads(resp.read().decode() or 'null')
            break
        except (OSError, http.client.HTTPException) as e:
            if attempt == 3:
                raise RuntimeError(f'{function}: connection failed ({e})')
            time.sleep(2 + attempt * 3)
    if isinstance(data, dict) and data.get('exception'):
        if data.get('errorcode') in ('invalidtoken', 'accessexception'):
            raise TokenError(data.get('message', 'invalid token'))
        raise RuntimeError(f"{function}: {data.get('errorcode')}: {data.get('message')}")
    return data


def when(ts):
    """Moodle timestamp -> "22 October 2026, 23:59" (what moodle_sync.activity_dates reads)."""
    return dt.datetime.fromtimestamp(ts).strftime('%d %B %Y, %H:%M') if ts else ''


def text(html_s, n=400):
    s = re.sub(r'<br\s*/?>|</p>|</div>|</li>', '\n', html_s or '', flags=re.I)
    s = html.unescape(re.sub(r'<[^>]+>', '', s))
    s = re.sub(r'\n\s*\n+', '\n', s).strip()
    return s[:n]


def token_from_supabase():
    cfg = load_cfg()
    uid = user_id(cfg)
    rows = req('GET', f"{cfg['url']}/rest/v1/docs?user_id=eq.{uid}&col=eq.settings&id=eq.moodle&select=data", cfg['service_key'])
    return (rows[0]['data'] or {}).get('token') if rows else None


def snapshot(token):
    out = {'fetchedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
           'source': 'api', 'courses': {}, 'activities': {}, 'panopto': {}, 'status': {}, 'announcements': {}, 'errors': []}
    me = ws(token, 'core_webservice_get_site_info')['userid']
    courses = ws(token, 'core_enrol_get_users_courses', userid=me)
    ids = [c['id'] for c in courses]
    for c in courses:
        out['courses'][str(c['id'])] = c.get('fullname', '')
        out['activities'][str(c['id'])] = []

    for course in ws(token, 'mod_assign_get_assignments', courseids=ids).get('courses', []):
        for a in course.get('assignments', []):
            opens, due = a.get('allowsubmissionsfromdate'), a.get('duedate')
            parts = ([f"Opens: {when(opens)}"] if opens else []) + ([f"Due: {when(due)}"] if due else [])
            out['activities'][str(course['id'])].append(['assign', a['name'], str(a['cmid']), ' | '.join(parts)])
            try:
                st = ws(token, 'mod_assign_get_submission_status', assignid=a['id'])
                sub = (st.get('lastattempt') or {}).get('submission') or (st.get('lastattempt') or {}).get('teamsubmission') or {}
                out['status'][str(a['cmid'])] = 'submitted' if sub.get('status') == 'submitted' else 'none'
            except RuntimeError as e:
                out['errors'].append(str(e))

    for q in ws(token, 'mod_quiz_get_quizzes_by_courses', courseids=ids).get('quizzes', []):
        opens, closes = q.get('timeopen'), q.get('timeclose')
        parts = ([f"Opens: {when(opens)}"] if opens else []) + ([f"Closes: {when(closes)}"] if closes else [])
        out['activities'].setdefault(str(q['course']), []).append(['quiz', q['name'], str(q['coursemodule']), ' | '.join(parts)])
        try:
            att = ws(token, 'mod_quiz_get_user_attempts', quizid=q['id'], status='finished').get('attempts', [])
            out['status'][str(q['coursemodule'])] = 'submitted' if att else 'none'
        except RuntimeError as e:
            out['errors'].append(str(e))

    # Announcements: the news forum of each course, latest few posts.
    for f in ws(token, 'mod_forum_get_forums_by_courses', courseids=ids):
        if f.get('type') != 'news':
            continue
        try:
            ds = ws(token, 'mod_forum_get_forum_discussions', forumid=f['id'], sortorder=1, page=0, perpage=5).get('discussions', [])
        except RuntimeError as e:
            out['errors'].append(str(e))
            continue
        out['announcements'][str(f['course'])] = [
            [str(d['discussion']), html.unescape(d.get('name') or d.get('subject') or ''), text(d.get('message')), d.get('timemodified') or d.get('created') or 0,
             f"{SITE}/mod/forum/discuss.php?d={d['discussion']}"]
            for d in ds
        ]
    return out


def main():
    token = os.environ.get('MOODLE_TOKEN') or token_from_supabase()
    if not token:
        print(json.dumps({'error': 'not-connected'}))
        return
    try:
        print(json.dumps(snapshot(token), ensure_ascii=False))
    except TokenError as e:
        print(json.dumps({'error': 'token', 'message': str(e)}))


if __name__ == '__main__':
    main()
