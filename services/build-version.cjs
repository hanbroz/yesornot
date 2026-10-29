'use strict';
const fs = require('node:fs');
const path = require('node:path');

const TIME_ZONE = 'Asia/Seoul';
const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function formatBuildVersion(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('Invalid build date');
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const version = ['year', 'month', 'day', 'hour', 'minute', 'second'].map(key => parts[key]).join('.');
  if (!/^\d{4}(?:\.\d{2}){5}$/.test(version)) throw new RangeError('Build year must have four digits');
  return version;
}

function createBuildInfo(date = new Date()) {
  return Object.freeze({ schemaVersion: 1, buildVersion: formatBuildVersion(date), builtAt: date.toISOString(), timeZone: TIME_ZONE });
}

// The version belongs to the packaged artifact; startup never substitutes the current time.
function readBuildInfo(appDirectory) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(appDirectory, 'build-info.json'), 'utf8'));
    if (!info || info.schemaVersion !== 1 || info.timeZone !== TIME_ZONE || typeof info.builtAt !== 'string') return null;
    const date = new Date(info.builtAt);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== info.builtAt || formatBuildVersion(date) !== info.buildVersion) return null;
    return createBuildInfo(date);
  } catch {
    return null;
  }
}

module.exports = { formatBuildVersion, createBuildInfo, readBuildInfo };
