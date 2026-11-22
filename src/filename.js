'use strict';
// File names for the Showrunner Recorder. The session filename format is the same one OBS uses (Session page), so it can hold
// {fields} (resolved by the app) and OBS's date macros (%CCYY-%MM-%DD ...), which are expanded here since there is no OBS to do it.
const path = require('path');
const fs = require('fs');

const pad = (n) => String(n).padStart(2, '0');

// The OBS date and time macros people actually use. Anything else starting with % is left as typed.
function expandDateMacros(text, date = new Date()) {
  const parts = {
    CCYY: String(date.getFullYear()), YY: String(date.getFullYear()).slice(-2),
    MM: pad(date.getMonth() + 1), DD: pad(date.getDate()),
    hh: pad(date.getHours()), mm: pad(date.getMinutes()), ss: pad(date.getSeconds()),
  };
  return text.replace(/%(CCYY|YY|MM|DD|hh|mm|ss)/g, (_m, key) => parts[key]);
}

function defaultName(date = new Date()) {
  return `Showrunner ${expandDateMacros('%CCYY-%MM-%DD %hh-%mm-%ss', date)}`;
}

// A name that is safe as one file name: no folders, no reserved characters, no dots or spaces at the ends, not absurdly long.
function safeName(text) {
  return String(text)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s]+$/g, '')
    .slice(0, 150);
}

// folder + name + ".mp4" (or the chosen extension), numbered ("... 2.mp4") when a file of that name is already there, so nothing is overwritten.
function uniquePath(folder, name, exists = fs.existsSync, ext = 'mp4') {
  let candidate = path.join(folder, `${name}.${ext}`);
  for (let n = 2; exists(candidate) && n < 1000; n += 1) candidate = path.join(folder, `${name} ${n}.${ext}`);
  return candidate;
}

// `resolved` is the template with {fields} already filled in (blank values leave gaps, which are tidied here).
function nameFromTemplate(resolved, date = new Date()) {
  const tidy = safeName(expandDateMacros(resolved, date).replace(/(\s*-\s*){2,}/g, ' - ').replace(/^\s*-\s*|\s*-\s*$/g, ''));
  return tidy || defaultName(date);
}

module.exports = { expandDateMacros, defaultName, safeName, uniquePath, nameFromTemplate };
