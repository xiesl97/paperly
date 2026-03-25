#!/usr/bin/env python3
"""Generate daily AI digest for each subscribed topic and write to data branch."""

import base64
import json
import os
import re
import sys
from datetime import datetime, timezone

import requests

AI_BASE_URL = os.environ.get('AI_BASE_URL', 'https://api.openai.com/v1').rstrip('/')
AI_API_KEY = os.environ.get('AI_API_KEY', '')
AI_MODEL = os.environ.get('AI_MODEL', 'gpt-4o-mini')
REPO_OWNER = os.environ.get('REPO_OWNER', '')
REPO_NAME = os.environ.get('REPO_NAME', '')
GH_TOKEN = os.environ.get('GH_TOKEN', '')

DATA_BRANCH = 'data'
RAW_BASE = f'https://raw.githubusercontent.com/{REPO_OWNER}/{REPO_NAME}/{DATA_BRANCH}'
API_BASE = f'https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}'
GH_HEADERS = {
    'Authorization': f'Bearer {GH_TOKEN}',
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
}

DIGEST_PROMPT = """You are a research journalist writing for an AI/ML research community. Given a list of papers, produce a comprehensive, detailed technical digest.

Output format (strict markdown):
# [Your generated title here]

Write a 2-sentence overview of today's research landscape.

## [Section 1 title]

## [Section 2 title]

(4-5 thematic sections total)

For each paper, write 3-4 sentences: what problem it addresses, the core technical approach, key results or contributions, and why it matters. Do not skip any paper.

End with:
## Key Takeaways
- 5-7 bullet points capturing the most important insights across all papers."""


def get_subscription_topics():
    url = f'{RAW_BASE}/subscription-topics.json'
    r = requests.get(url, timeout=15)
    if r.status_code == 404:
        return []
    r.raise_for_status()
    return r.json()


def get_latest_papers():
    r = requests.get(f'{RAW_BASE}/assets/file-list.txt', timeout=15)
    r.raise_for_status()
    files = [f.strip() for f in r.text.strip().split('\n') if f.strip()]
    date_files = sorted(
        [f for f in files if re.match(r'\d{4}-\d{2}-\d{2}\.jsonl$', f)],
        reverse=True,
    )
    if not date_files:
        return [], None

    latest = date_files[0]
    date = latest.replace('.jsonl', '')
    r = requests.get(f'{RAW_BASE}/data/{latest}', timeout=30)
    r.raise_for_status()

    papers = []
    seen = set()
    for line in r.text.strip().split('\n'):
        line = line.strip()
        if not line:
            continue
        try:
            p = json.loads(line)
            pid = p.get('id', '')
            if pid and pid not in seen:
                seen.add(pid)
                papers.append(p)
        except json.JSONDecodeError:
            pass
    return papers, date


def filter_papers_for_topic(papers, topic):
    """Simple keyword match: topic words appear in title/abstract."""
    keywords = topic.lower().split()
    matched = []
    seen = set()
    for p in papers:
        pid = p.get('id', '')
        if pid in seen:
            continue
        text = ' '.join(filter(None, [
            p.get('title', ''),
            p.get('summary', ''),
            p.get('details', ''),
        ])).lower()
        if any(re.search(r'\b' + re.escape(kw), text) for kw in keywords):
            matched.append(p)
            seen.add(pid)
    return matched


def generate_digest(papers, topic, date):
    papers_text = '\n\n'.join(
        f'[{i+1}] Title: "{p.get("title", "")}"\n'
        f'Authors: {p.get("authors", "")}\n'
        f'Abstract: {(p.get("summary") or p.get("details", ""))[:600]}'
        for i, p in enumerate(papers)
    )
    prompt = (
        f'{DIGEST_PROMPT}\n\nTopic focus: {topic}\nDate: {date}'
        f'\n\n---\n\nPapers:\n\n{papers_text}'
    )
    r = requests.post(
        f'{AI_BASE_URL}/chat/completions',
        headers={'Authorization': f'Bearer {AI_API_KEY}', 'Content-Type': 'application/json'},
        json={
            'model': AI_MODEL,
            'messages': [{'role': 'user', 'content': prompt}],
            'max_tokens': 8000,
        },
        timeout=120,
    )
    r.raise_for_status()
    return r.json()['choices'][0]['message']['content']


def write_to_data_branch(file_path, content_str, commit_message):
    api_url = f'{API_BASE}/contents/{file_path}'

    sha = None
    get_res = requests.get(f'{api_url}?ref={DATA_BRANCH}', headers=GH_HEADERS, timeout=15)
    if get_res.ok:
        sha = get_res.json().get('sha')

    encoded = base64.b64encode(content_str.encode('utf-8')).decode('ascii')
    body = {'message': commit_message, 'content': encoded, 'branch': DATA_BRANCH}
    if sha:
        body['sha'] = sha

    put_res = requests.put(api_url, headers=GH_HEADERS, json=body, timeout=30)
    put_res.raise_for_status()


def main():
    if not AI_API_KEY:
        print('AI_API_KEY not set. Exiting.')
        sys.exit(1)

    print('Reading subscription topics...')
    topics = get_subscription_topics()
    if not topics:
        print('No subscribed topics found. Exiting.')
        return
    print(f'Topics: {topics}')

    print('Fetching latest papers...')
    papers, date = get_latest_papers()
    if not papers:
        print('No papers found. Exiting.')
        return
    print(f'{len(papers)} papers for {date}.')

    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    if date != today:
        print(f'WARNING: Latest papers are from {date}, not today ({today}). Generating anyway.')

    results = []
    for topic in topics:
        print(f'\nProcessing topic: "{topic}"')
        matched = filter_papers_for_topic(papers, topic)
        if not matched:
            print(f'  No papers matched. Skipping.')
            continue
        print(f'  {len(matched)} papers matched. Generating digest...')
        try:
            markdown = generate_digest(matched, topic, date)
            results.append({
                'topic': topic,
                'date': date,
                'paperCount': len(matched),
                'markdown': markdown,
            })
            print(f'  Done.')
        except Exception as e:
            print(f'  ERROR: {e}')

    if not results:
        print('\nNo digests generated.')
        return

    output_path = f'daily-digests/{date}.json'
    print(f'\nWriting {len(results)} digest(s) to {output_path}...')
    write_to_data_branch(
        output_path,
        json.dumps(results, ensure_ascii=False, indent=2),
        f'digest: {date} ({len(results)} topics)',
    )
    print('Done.')


if __name__ == '__main__':
    main()
