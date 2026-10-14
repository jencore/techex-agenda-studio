/**
 * TechEx Agenda Parser
 * Handles multiple site structures used across the TechEx / DTX / CyberSecurity Cloud Expo family.
 */

const cheerio = require('cheerio');

const TIME_RE = /(\d{1,2}[:.]\d{2})\s*(?:AM|PM)?\s*[-–—]\s*(\d{1,2}[:.]\d{2})\s*(?:AM|PM)?/i;
const SINGLE_TIME_RE = /^(\d{1,2}[:.]\d{2})\s*(?:AM|PM)?$/i;
const BREAK_RE = /\b(break|lunch|networking|coffee|registration|drinks|exhibition)\b/i;
const TYPE_RE = /^(Panel(?:\s+Discussion)?|Presentation|Fireside Chat|Keynote|Workshop|Roundtable|Interview|Demo|Q&A|Chairperson(?:'s)?\s*(?:Opening|Closing)?\s*(?:Remarks)?)[:\-–]\s*/i;

function fmtTime(t) {
  return t.replace('.', ':').replace(/(\d)(AM|PM)/i, '$1 $2').trim();
}

function fmtTimeRange(tm) {
  return `${fmtTime(tm[1])} – ${fmtTime(tm[2])}`;
}

function splitType(rawTitle) {
  const m = rawTitle.match(TYPE_RE);
  if (m) return { sessionType: m[1].trim(), sessionTitle: rawTitle.slice(m[0].length).trim() };
  if (/^chairperson/i.test(rawTitle)) return { sessionType: rawTitle, sessionTitle: '' };
  return { sessionType: '', sessionTitle: rawTitle };
}

function extractSpeakers($, container) {
  const speakers = [];

  // Pattern A: <a href*="/speaker/"> links
  $(container).find('a[href*="/speaker/"]').each((_, link) => {
    const $link = $(link);
    const name = $link.find('strong, b, h3, h4').first().text().trim()
      || $link.find('[class*="name" i]').first().text().trim();
    const paras = $link.find('p');
    let role = '', company = '';
    if (paras.length >= 2) {
      role = $(paras[0]).text().trim();
      company = $(paras[1]).text().trim();
    } else if (paras.length === 1) {
      const parts = $(paras[0]).text().split(',');
      role = parts[0]?.trim() || '';
      company = parts.slice(1).join(',').trim();
    } else {
      const rest = $link.text().replace(name, '').trim().split(/\n|,/).map(s => s.trim()).filter(Boolean);
      role = rest[0] || '';
      company = rest[1] || '';
    }
    if (name) speakers.push({ name, role, company });
  });

  if (speakers.length) return speakers;

  // Pattern B: elements with speaker class
  $(container).find('[class*="speaker" i]').each((_, el) => {
    const $el = $(el);
    const nameEl = $el.find('strong, b, h3, h4, [class*="name" i]').first();
    const name = nameEl.text().trim();
    if (!name) return;
    const rest = $el.text().replace(name, '').trim().split(/\n|,/).map(s => s.trim()).filter(Boolean);
    speakers.push({ name, role: rest[0] || '', company: rest[1] || '' });
  });

  return speakers;
}

/**
 * Strategy 1: H2 = time, next H2 = title (DTX / digitaltransformation-week.com style)
 */
function parseH2Strategy($) {
  const sessions = [];
  $('h2').each((_, h2) => {
    const raw = $(h2).text().trim();
    const tm = raw.match(TIME_RE);
    if (!tm) return;
    const time = fmtTimeRange(tm);

    // Find next H2 = title
    let titleEl = null;
    let node = $(h2).next();
    while (node.length) {
      if (node.is('h2')) { titleEl = node; break; }
      node = node.next();
    }
    const rawTitle = titleEl ? titleEl.text().trim() : '';
    if (!rawTitle) return;

    const isBreak = BREAK_RE.test(rawTitle);
    const { sessionType, sessionTitle } = splitType(rawTitle);

    let speakers = [];
    if (!isBreak && titleEl) {
      // Collect content between this title h2 and the next time h2
      const collectedHtml = [];
      let n = titleEl.next();
      while (n.length && !(n.is('h2') && TIME_RE.test(n.text()))) {
        collectedHtml.push($.html(n));
        n = n.next();
      }
      if (collectedHtml.length) {
        const $sub = cheerio.load(collectedHtml.join(''));
        speakers = extractSpeakers($sub, $sub.root());
      }
    }
    sessions.push({ time, type: sessionType, title: sessionTitle, speakers, isBreak, rawTitle });
  });
  return sessions;
}

/**
 * Strategy 2: H3/H4 = title, sibling/parent contains time (CyberSecurity Cloud Expo style)
 */
function parseH4Strategy($) {
  const sessions = [];
  const seen = new Set();

  $('h3, h4').each((_, hEl) => {
    const rawTitle = $(hEl).text().trim();
    if (!rawTitle || rawTitle.length < 4 || TIME_RE.test(rawTitle)) return;

    // Walk back through previous siblings to find a time
    let time = '';
    let $sib = $(hEl).prev();
    for (let i = 0; i < 8 && $sib.length; i++) {
      const txt = $sib.text().trim();
      const tm = txt.match(TIME_RE);
      if (tm) { time = fmtTimeRange(tm); break; }
      $sib = $sib.prev();
    }

    // Try parent container text
    if (!time) {
      const $parent = $(hEl).closest('[class*="session" i], [class*="agenda" i], [class*="slot" i], [class*="item" i], [class*="talk" i], article, li');
      if ($parent.length) {
        const parentText = $parent.text();
        const tm = parentText.match(TIME_RE);
        if (tm) time = fmtTimeRange(tm);
      }
    }

    if (!time || seen.has(rawTitle + time)) return;
    seen.add(rawTitle + time);

    const isBreak = BREAK_RE.test(rawTitle);
    const { sessionType, sessionTitle } = splitType(rawTitle);

    // Collect speakers from next siblings until next time element
    const collectedHtml = [];
    let n = $(hEl).next();
    for (let i = 0; i < 20 && n.length; i++) {
      if (TIME_RE.test(n.text()) && (n.is('h2,h3,h4,p,div'))) break;
      collectedHtml.push($.html(n));
      n = n.next();
    }
    let speakers = [];
    if (!isBreak && collectedHtml.length) {
      const $sub = cheerio.load(collectedHtml.join(''));
      speakers = extractSpeakers($sub, $sub.root());
    }

    sessions.push({ time, type: sessionType, title: sessionTitle, speakers, isBreak, rawTitle });
  });
  return sessions;
}

/**
 * Strategy 3: Look for session container elements with time + title inside
 */
function parseContainerStrategy($) {
  const sessions = [];
  const seen = new Set();
  const containers = $('[class*="session" i], [class*="agenda-item" i], [class*="schedule-item" i], [class*="talk" i], [class*="slot" i]');

  containers.each((_, el) => {
    const $el = $(el);
    const fullText = $el.text();
    const tm = fullText.match(TIME_RE);
    if (!tm) return;
    const time = fmtTimeRange(tm);

    const titleEl = $el.find('h2,h3,h4,h5,[class*="title" i],[class*="name" i]').first();
    const rawTitle = titleEl.text().trim() || $el.find('strong').first().text().trim();
    if (!rawTitle || rawTitle.length < 4 || seen.has(rawTitle + time)) return;
    seen.add(rawTitle + time);

    const isBreak = BREAK_RE.test(rawTitle);
    const { sessionType, sessionTitle } = splitType(rawTitle);
    const speakers = isBreak ? [] : extractSpeakers($, el);

    sessions.push({ time, type: sessionType, title: sessionTitle, speakers, isBreak, rawTitle });
  });
  return sessions;
}

/**
 * Strategy 4: Generic — walk all text, find times, grab next heading-like text
 */
function parseGenericStrategy($) {
  const sessions = [];
  const seen = new Set();
  const allEls = $('*').toArray();

  for (let i = 0; i < allEls.length; i++) {
    const el = allEls[i];
    const $el = $(el);
    const children = $el.children();
    if (children.length > 0) continue; // only leaf nodes
    const txt = $el.text().trim();
    if (txt.length > 40) continue;
    const tm = txt.match(TIME_RE);
    if (!tm) continue;
    const time = fmtTimeRange(tm);
    if (seen.has(time)) continue;

    // Scan forward for a non-time text element
    for (let j = i + 1; j < Math.min(i + 10, allEls.length); j++) {
      const $next = $(allEls[j]);
      if ($next.children().length > 0) continue;
      const t = $next.text().trim();
      if (t.length > 4 && !TIME_RE.test(t) && !seen.has(t + time)) {
        const isBreak = BREAK_RE.test(t);
        const { sessionType, sessionTitle } = splitType(t);
        seen.add(t + time);
        seen.add(time);
        sessions.push({ time, type: sessionType, title: sessionTitle, speakers: [], isBreak, rawTitle: t });
        break;
      }
    }
  }
  return sessions;
}

/**
 * Main parse entry point — tries strategies in order, returns first that yields results.
 */
function parseAgendaHtml(html) {
  const $ = cheerio.load(html);

  let sessions = parseH2Strategy($);
  if (sessions.length) return { sessions, strategy: 'h2' };

  sessions = parseH4Strategy($);
  if (sessions.length) return { sessions, strategy: 'h4' };

  sessions = parseContainerStrategy($);
  if (sessions.length) return { sessions, strategy: 'container' };

  sessions = parseGenericStrategy($);
  return { sessions, strategy: 'generic' };
}

/**
 * Try to auto-fill metadata from the page.
 */
function autofillMeta(html, url) {
  const $ = cheerio.load(html);
  const meta = {};

  const dayM = url.match(/day[- _]?(\d)/i) || html.match(/DAY\s+(\d)/);
  if (dayM) meta.dayLabel = `DAY ${dayM[1]}`;

  const h1 = $('h1').first().text().trim();
  if (h1) meta.subtitle = h1;

  const trM = html.match(/(GOLD|SILVER|BRONZE|PLATINUM|TEAL|EMERALD|SAPPHIRE)\s+TRACK/i);
  if (trM) meta.trackName = trM[1].toUpperCase() + ' TRACK';

  // Try page <title>
  const title = $('title').text().trim();
  if (title) meta.pageTitle = title;

  return meta;
}

module.exports = { parseAgendaHtml, autofillMeta };
