'use strict';

// Turns a teleprompter script (Markdown) into the HTML the teleprompter page shows, and the
// list of cues in it.
//
// Raw HTML in the script is escaped, never rendered, so any file is safe to open and no
// sanitizer is needed. Links and images are shown as their text. A cue is a line of its own:
//     <!-- cue: Be Right Back -->
// A hold is the same line with `hold`; it fires its event and also stops the scrolling until the presenter continues:
//     <!-- hold: Show the map -->
// Showrunner reads those lines itself before the text is rendered, so they never show as content.
// A heading is a cue as well. The page fires an Automations event when the reading line
// reaches one: teleprompter:<slug> for a cue, teleprompter:heading:<slug> for a heading.

const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const CUE_LINE = /^\s*<!--\s*(cue|hold)\s*:\s*(.+?)\s*-->\s*$/i; // `hold` is a cue that also stops the scrolling until the presenter continues

let markedPromise = null;
function loadMarked() {
  // marked is an ES module; the main process is CommonJS, so it is loaded on first use.
  if (!markedPromise) markedPromise = import('marked');
  return markedPromise;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slug(text) {
  const s = String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
  return s || 'cue';
}

async function renderScript(source) {
  const { Marked } = await loadMarked();
  const cues = [];
  // Cue lines become a one-word paragraph that is swapped for a chip after rendering.
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const m = CUE_LINE.exec(line);
    if (!m) return line;
    const hold = m[1].toLowerCase() === 'hold';
    const label = m[2].slice(0, 80);
    cues.push({ kind: hold ? 'hold' : 'cue', label, event: hold ? `teleprompter:hold:${slug(label)}` : `teleprompter:${slug(label)}` });
    return `\n\nSRCUE${cues.length - 1}X\n\n`;
  });

  const parser = new Marked({
    gfm: true,
    renderer: {
      html({ text }) { return escapeHtml(text); },
      link({ tokens }) { return `<span class="link">${this.parser.parseInline(tokens)}</span>`; },
      image({ text }) { return escapeHtml(text || ''); },
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const label = text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
        const cue = { kind: 'heading', label, event: `teleprompter:heading:${slug(label)}` };
        cues.push(cue);
        return `<h${depth} data-cue="${escapeHtml(cue.event)}" data-label="${escapeHtml(label)}" data-kind="heading">${text}</h${depth}>\n`;
      },
    },
  });
  let html = parser.parse(lines.join('\n'));
  html = html.replace(/<p>SRCUE(\d+)X<\/p>/g, (_all, n) => {
    const cue = cues[Number(n)];
    if (!cue) return '';
    return `<div class="cue${cue.kind === 'hold' ? ' hold' : ''}" data-cue="${escapeHtml(cue.event)}" data-label="${escapeHtml(cue.label)}" data-kind="${cue.kind}"><span>${cue.kind === 'hold' ? 'Hold: ' : ''}${escapeHtml(cue.label)}</span></div>\n`;
  });
  return { html, cues: cuesInOrder(html) };
}

// The cues and headings in the order they are read in the script. (Cue lines are found before the text is rendered and
// headings while it is, so the list built along the way is not in reading order; the rendered text is.)
function cuesInOrder(html) {
  const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  const found = [];
  const pattern = /data-cue="([^"]*)" data-label="([^"]*)" data-kind="(heading|cue|hold)"/g;
  let m;
  while ((m = pattern.exec(html))) found.push({ event: unescape(m[1]), label: unescape(m[2]), kind: m[3] });
  return found;
}

module.exports = { renderScript, slug, MAX_SCRIPT_BYTES };
