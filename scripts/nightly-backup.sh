#!/usr/bin/env bash
# Nightly off-host database backup (RR-09).
#
# Dumps the friday database from the friday-pg container in custom format and
# pushes it to the PRIVATE github.com:skytech45/friday-one-backups repo. Git
# history on that repo IS the retention policy: every nightly dump is a commit;
# the working tree keeps only the most recent KEEP dumps to stay small, while
# older ones remain recoverable from history.
#
# Restore procedure (drilled 2026-10-25, see docs/BASELINE_AUDIT.md):
#   sudo -n docker exec -i friday-pg pg_restore -U friday --clean --if-exists \
#     -d friday < dumps/<file>.dump        # in-place restore, server should be DOWN
# or restore to a scratch database first:
#   sudo -n docker exec -i friday-pg createdb -U friday friday_restore
#   sudo -n docker exec -i friday-pg pg_restore -U friday -d friday_restore < dumps/<file>.dump
#
# Cron entry runs this nightly; output goes to logs/backup.log.
set -euo pipefail

STAMP="$(date -u +%Y%m%d-%H%M)"
REPO_DIR="$HOME/friday-one-db-backups"
KEEP=14

# Part 1: push the source repo off-host (whatever is committed by 04:35).
echo "nightly-backup: pushing friday-one repo..."
git -C "$HOME/friday-one" push origin master --tags \
  || echo "nightly-backup: WARNING - repo push failed"

# Part 2: database dump -> private backups repo.

mkdir -p "$REPO_DIR"
cd "$REPO_DIR"

if [ ! -d .git ]; then
  git init -q
  git remote add origin git@github-friday-backups:skytech45/friday-one-backups.git
  git fetch -q origin master 2>/dev/null || true
  git checkout -q -B master 2>/dev/null || true
fi

# Freshen the clone so we never build on a stale history.
git fetch -q origin master 2>/dev/null || true
git reset -q --hard origin/master 2>/dev/null || git checkout -q -B master

mkdir -p dumps
# -Fc = custom format, compressed, restorable with pg_restore.
sudo -n docker exec friday-pg pg_dump -U friday -Fc friday > "dumps/friday-$STAMP.dump"
# Always-a-stable-name copy for the restore drill and quick manual restores.
cp "dumps/friday-$STAMP.dump" latest.dump

git add dumps/friday-"$STAMP".dump latest.dump

# Keep the working tree bounded: drop local copies beyond KEEP, but never from
# git history.
ls -1t dumps/friday-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  git rm -q --cached "$old" 2>/dev/null || true
  rm -f "$old"
done

if git diff --cached --quiet; then
  echo "nightly-backup: no changes"
  exit 0
fi

git -c user.name="friday-backup" -c user.email="backup@friday.local" \
  commit -q -m "pg_dump $STAMP"
GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" git push -q origin master

echo "nightly-backup: pushed dumps/friday-$STAMP.dump ($(du -h "dumps/friday-$STAMP.dump" | cut -f1))"
