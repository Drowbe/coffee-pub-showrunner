'use strict';

// Backups of Showrunner's settings.
//
// A backup is a dated folder under <user data>/backups holding copies of the
// small files that make up a setup: the config, the saved passwords and
// trust records, the Automations certificates, the recordings list and the
// renamed-source list. The browser cache and site data are not included.
//
// One is made automatically before the config is migrated to a new format
// (an older build cannot read the new one), one on demand, and one just
// before a restore so a restore can itself be undone.

const fs = require('fs');
const path = require('path');

const BACKUP_FILES = /^(config\.json|recordings\.json|source-renames\.json|[a-z]+-(?:secret|trust)\.bin|automations-.*\.(?:pem|srl))$/;
const META_FILE = 'backup.json';
const KEEP = 20; // newest backups kept; migration backups are never pruned

function backupsDir(userData) {
  return path.join(userData, 'backups');
}

function two(n) {
  return String(n).padStart(2, '0');
}

// 2026-11-19T13-08-00-123, local time, safe in a file name.
function stamp(date) {
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}-${ms}`;
}

function slug(reason) {
  return String(reason || 'manual').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'manual';
}

function settingsFiles(userData) {
  let names = [];
  try {
    names = fs.readdirSync(userData);
  } catch (err) {
    return [];
  }
  return names.filter((name) => BACKUP_FILES.test(name) && fs.statSync(path.join(userData, name)).isFile());
}

function readInfo(dir, id) {
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8'));
  } catch (err) {
    // A folder without its record still lists, from its name and files.
  }
  const files = fs.readdirSync(dir).filter((name) => name !== META_FILE);
  const bytes = files.reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
  return {
    id,
    created: typeof meta.created === 'string' ? meta.created : null,
    reason: typeof meta.reason === 'string' ? meta.reason : 'manual',
    files: files.length,
    bytes,
  };
}

// Newest first.
function list(userData) {
  const root = backupsDir(userData);
  let ids = [];
  try {
    ids = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    return [];
  }
  return ids
    .map((id) => readInfo(path.join(root, id), id))
    .sort((a, b) => {
      const byTime = (b.created || '').localeCompare(a.created || '');
      return byTime || b.id.localeCompare(a.id, undefined, { numeric: true });
    });
}

// Drops the oldest backups beyond KEEP, never a migration backup and never
// the one just made.
function prune(userData, keepId) {
  const removable = list(userData).filter((b) => !b.reason.startsWith('migrate'));
  for (const old of removable.slice(KEEP)) {
    if (old.id === keepId) continue;
    fs.rmSync(path.join(backupsDir(userData), old.id), { recursive: true, force: true });
  }
}

// Copies the settings files into a new backup folder. Returns its info, or
// null when there is no config to back up yet.
function create(userData, reason = 'manual') {
  const files = settingsFiles(userData);
  if (!files.includes('config.json')) return null;
  const root = backupsDir(userData);
  const base = `${stamp(new Date())}-${slug(reason)}`;
  let id = base;
  for (let n = 2; fs.existsSync(path.join(root, id)); n++) id = `${base}-${n}`;
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of files) fs.copyFileSync(path.join(userData, name), path.join(dir, name));
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify({ created: new Date().toISOString(), reason: String(reason), files }, null, 2));
  prune(userData, id);
  return readInfo(dir, id);
}

// Puts a backup's files back. The current settings are backed up first, so a
// restore can be undone. The caller restarts the app afterwards: the running
// app still holds the old settings in memory.
function restore(userData, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('Unknown backup.');
  const dir = path.join(backupsDir(userData), id);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('That backup no longer exists.');
  const files = fs.readdirSync(dir).filter((name) => name !== META_FILE && BACKUP_FILES.test(name));
  if (!files.includes('config.json')) throw new Error('That backup has no config file.');
  const safety = create(userData, 'before-restore');
  for (const name of files) {
    const target = path.join(userData, name);
    const tmp = `${target}.restoring`;
    fs.copyFileSync(path.join(dir, name), tmp);
    fs.renameSync(tmp, target);
  }
  return { restored: id, safety: safety ? safety.id : null };
}

module.exports = { backupsDir, create, list, restore, BACKUP_FILES, KEEP };
