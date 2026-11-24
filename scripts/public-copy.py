#!/usr/bin/env python3
"""Write HEAD to a new folder with a fresh git history, for publishing.

usage: python3 scripts/public-copy.py <target-dir>

The repo keeps deployment details out of tracked files (gateway/targets.local.yml and CLAUDE.local.md are
gitignored), but its history still has them, so a public repo should start from this copy. Nothing is
published. Lines that still look like private identifiers are listed, and so are the screenshots, which need
a human look.
"""
import io
import re
import subprocess
import sys
import tarfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Workspace ids, internal links, personal emails and cloud hostnames
SUSPECT = re.compile(r'\b\d{16}\b|go/[a-z]|@databricks\.com|ec2-\d|\.cloud\.databricks\.(com|us)\b|azuredatabricks\.net|gcp\.databricks\.com|atlassian\.net|\.slack\.com|-\d{6,}[\w.-]*\.databricksapps\.(com|us)', re.I)
# Placeholders and public docs are fine
ALLOWED = re.compile(r'<[^>]+>\.cloud\.databricks\.(com|us)|[\w-]*(<[^>]+>|1234567890\d*|…)[\w.<>…-]*\.databricksapps\.(com|us)|\bapp\d?\.databricksapps\.com|geolakelayers-1234567890123456|example\.cloud|test\.cloud|docs\.databricks\.com|9007199254740881')


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    target = Path(sys.argv[1]).expanduser().resolve()
    if target.exists():
        sys.exit(f'{target} exists; pick a new directory')
    if REPO in target.parents or target == REPO:
        sys.exit('Write the copy outside the repo')

    archive = subprocess.run(['git', '-C', str(REPO), 'archive', '--format=tar', 'HEAD'], check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(target, filter='data')

    suspects, images = [], []
    for path in sorted(p for p in target.rglob('*') if p.is_file()):
        rel = path.relative_to(target)
        if path.suffix.lower() in {'.png', '.jpg', '.jpeg', '.gif', '.webp'}:
            images.append(str(rel))
            continue
        try:
            text = path.read_text('utf-8')
        except UnicodeDecodeError:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if SUSPECT.search(ALLOWED.sub('', line)):
                suspects.append(f'{rel}:{i}: {line.strip()[:160]}')

    subprocess.run(['git', 'init', '-q', '-b', 'main', str(target)], check=True)
    print(f'Wrote {target} (fresh repo, nothing committed).')
    print(f'\nStill looks private ({len(suspects)}):' if suspects else '\nNothing looks private.')
    for s in suspects:
        print('  ' + s)
    print(f'\nScreenshots to check by eye ({len(images)}):')
    for s in images:
        print('  ' + s)


if __name__ == '__main__':
    main()
