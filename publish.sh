#!/bin/sh
# Publish the crew ranks: in the app, Settings -> "Copy publish blob", then run this.
set -e
cd "$(dirname "$0")"
pbpaste > ranks.json
python3 -c "import json; d=json.load(open('ranks.json')); print('managers:', ', '.join(d.get('managers', {}).keys()) or 'none')"
git add ranks.json
git commit -m "ranks update"
git push
echo "Published — phones pick it up on next app open (Pages cache ~2-10 min)."
