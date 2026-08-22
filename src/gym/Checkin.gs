/**
 * STANDALONE Apps Script — create it at script.google.com, NOT from the
 * sheet's Extensions menu (that is greyed out on a file owned by someone
 * else). This script is yours; it opens the coach's sheet by id, using your
 * own edit rights.
 *
 * SETUP
 *   1. script.google.com > New project, paste this over Code.gs.
 *   2. Project Settings > Script Properties > Add:
 *        SECRET   = a long random string
 *        SHEET_ID = the id in the sheet's URL, between /d/ and /edit
 *      Both live here rather than in the code so the script can be shared or
 *      screenshotted without leaking anything.
 *   3. Run > run `test_findsTodaysRow` once. Google will ask for permission to
 *      touch your spreadsheets — that consent is what makes openById work.
 *   4. Deploy > New deployment > Web app
 *        Execute as:     Me
 *        Who has access: Anyone
 *      "Anyone" is why SECRET exists: the URL alone must not be enough.
 *   5. Copy the /exec URL into the bot's .env as GYM_SHEET_URL, and the same
 *      secret as GYM_SHEET_SECRET.
 *
 * After ANY edit here: Deploy > Manage deployments > edit > Version: New.
 * Otherwise the old code keeps answering and nothing appears to change.
 *
 * NOTHING IS HARDCODED about the layout. No A1 ranges, no column letters, no
 * row numbers. The tracker is a merged-cell grid — week blocks, an AVERAGES
 * row between them, dates written as "27 July" — and all of that shifts the
 * first time the coach inserts a row. Every write reads the sheet's own
 * headers and finds its target by label.
 */

var TAB_NAME = 'Check In Tracker';

/** How many rows from the top can hold header labels. The tracker stacks two:
 *  a group row (NUTRITION, TRAINING & RECOVERY) above the real labels. */
var HEADER_DEPTH = 12;

function doPost(e) {
  try {
    var props = PropertiesService.getScriptProperties();
    var body = JSON.parse(e.postData.contents);

    if (body.secret !== props.getProperty('SECRET')) {
      return reply('forbidden');
    }

    var sheet = SpreadsheetApp
      .openById(props.getProperty('SHEET_ID'))
      .getSheetByName(TAB_NAME);

    if (!sheet) return reply('no-tab');

    // Two actions over one endpoint. "read" hands the bot the whole week so
    // its menu can show what is already filled; anything else writes.
    if (body.action === 'read') return readWeek(sheet, body.date);

    var loaded = loadGrid(sheet);
    var grid = loaded.grid;
    var headers = loaded.headers;

    if (headers.dateColumn === -1) return reply('no-date-column');

    var row = findDateRow(grid, headers.dateColumn, body.date);
    if (row === -1) return reply('no-row');

    // One setValue per field. The target columns are scattered across the
    // width of the sheet with merged blocks between them, so a single range
    // write would clobber whatever sits in the gaps.
    var wrote = 0;
    var missed = [];

    for (var label in body.values) {
      var col = matchColumn(headers.byLabel, label);

      if (col === undefined) { missed.push(label); continue; }

      writeCell(sheet, row + 1, col + 1, body.values[label]);
      wrote++;
    }

    // Named, never swallowed. A renamed header looks exactly like this, and it
    // is the one failure the whole match-by-label approach exists to surface.
    if (missed.length) return reply('unmatched: ' + missed.join(', '));
    if (wrote === 0) return reply('nothing-written');

    // The updated week comes back with the write. The menu has to redraw after
    // every tap, and asking for it separately doubled the wait on the one
    // action the user repeats most.
    return readWeek(sheet, body.date);
  } catch (err) {
    return reply('error: ' + err.message);
  }
}

/** Loads only as much of the sheet as the check-in needs.
 *
 *  getDataRange() pulls EVERY cell, and this tracker is ~300 rows by ~40
 *  columns — most of that width is the weekly reflection text ("Did you face
 *  any challenges...", coaching notes), which no check-in ever touches. At
 *  four seconds a round trip, and a menu that reads on every tap, that waste
 *  is the whole cost of the feature.
 *
 *  So: read the HEADER rows full width (cheap, a dozen rows), work out the
 *  right-most column any field actually lives in, then read the body only that
 *  far. Still nothing hardcoded — the width is derived from where the labels
 *  turned out to be.
 *
 *  getDisplayValues, not getValues: a date cell may hold a real date or the
 *  text "27 July", and the displayed string is what a human matched on. */
function loadGrid(sheet) {
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();

  var header = sheet
    .getRange(1, 1, Math.min(HEADER_DEPTH, lastRow), lastColumn)
    .getDisplayValues();

  var headers = readHeaders(header);

  // The date column plus one, because the DAY name sits beside it.
  var widest = headers.dateColumn + 1;

  for (var i = 0; i < FIELD_LABELS.length; i++) {
    var col = matchColumn(headers.byLabel, FIELD_LABELS[i]);

    if (col !== undefined && col > widest) widest = col;
  }

  return {
    headers: headers,
    grid: sheet.getRange(1, 1, lastRow, widest + 1).getDisplayValues()
  };
}

/** Hands back the week containing `isoDate`: its seven days, whatever is
 *  already filled for each, and the week's shared (merged) values.
 *
 *  The bot's menu needs this to show "Bodyweight 82.5 / Sleep —" rather than a
 *  list of blanks. Reading is done HERE for the same reason writing is: the
 *  sheet knows its own shape, and getDataRange() plus getMergedRanges() answer
 *  in two calls what would otherwise be reconstructed from a rectangle of
 *  strings. */
function readWeek(sheet, isoDate) {
  var loaded = loadGrid(sheet);
  var grid = loaded.grid;
  var headers = loaded.headers;

  if (headers.dateColumn === -1) return reply('no-date-column');

  var row = findDateRow(grid, headers.dateColumn, isoDate);
  if (row === -1) return reply('no-row');

  var year = Number(isoDate.split('-')[0]);
  var block = findBlock(grid, headers.dateColumn, row, year);

  var days = [];
  var daily = {};

  for (var i = 0; i < block.length; i++) {
    var iso = toIso(block[i].date);

    days.push({
      date: iso,
      day: dayName(grid, block[i].row, headers.dateColumn)
    });

    daily[iso] = {};
  }

  var weekly = {};

  // Merged-ness is a property of the COLUMN within this block, not of each
  // cell, so it is asked once per field rather than 8 x 7 times.
  for (var f = 0; f < FIELD_LABELS.length; f++) {
    var label = FIELD_LABELS[f];
    var col = matchColumn(headers.byLabel, label);

    if (col === undefined) continue;

    var first = sheet.getRange(block[0].row + 1, col + 1);
    var merged = first.getMergedRanges();

    if (merged.length > 0) {
      // One value for the whole week. Only the anchor cell holds it;
      // getDisplayValues reports "" for the rest of the merge.
      // Recorded even when blank: the bot's menu needs to know this field is
      // weekly in order to label it, and an empty value is not the same
      // information as an absent key.
      weekly[label] = merged[0].getCell(1, 1).getDisplayValue();

      continue;
    }

    for (var d = 0; d < block.length; d++) {
      var cell = grid[block[d].row][col];

      if (cell !== '' && cell != null) {
        daily[toIso(block[d].date)][label] = cell;
      }
    }
  }

  return json({ ok: true, days: days, daily: daily, weekly: weekly });
}

/** The contiguous run of date rows around `row` — one week block.
 *
 *  Walks outward until the date column stops parsing as a date, which is what
 *  the AVERAGES row and the block's header rows both do. That is why no week
 *  length is assumed: a short first week still comes back whole. */
function findBlock(grid, dateColumn, row, year) {
  var start = row;
  while (start > 0 && parseCell(grid[start - 1][dateColumn], year)) start--;

  var end = row;
  while (end < grid.length - 1 && parseCell(grid[end + 1][dateColumn], year)) end++;

  var block = [];

  for (var r = start; r <= end; r++) {
    block.push({ row: r, date: parseCell(grid[r][dateColumn], year) });
  }

  return block;
}

/** MON / TUE / ... read from the sheet's own DAY column, one to the right of
 *  the date. Falls back to deriving it if that column is missing. */
function dayName(grid, row, dateColumn) {
  var cell = grid[row][dateColumn + 1];

  return cell ? String(cell).trim() : '';
}

function toIso(date) {
  var month = date.getMonth() + 1;
  var day = date.getDate();

  return date.getFullYear() +
    '-' + (month < 10 ? '0' : '') + month +
    '-' + (day < 10 ? '0' : '') + day;
}

function json(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

/** The labels the bot asks about, so `read` can report all of them without
 *  the request having to list them every time. Kept in step with FIELDS in
 *  src/gym/checkin.js — tests/sheet.test.js asserts they match. */
var FIELD_LABELS = [
  'BODYWEIGHT',
  'Nutrition Compliance',
  'Hydration',
  'Off Plan Meal',
  'Exercise Compliance',
  'Quantity of Sleep',
  'Steps',
  'discomfort'
];

/** Writes one value, following a merge if the target sits inside one.
 *
 *  Not every column in this tracker is daily. The three compliance scores —
 *  Nutrition, Hydration, Exercise — are ONE merged cell spanning the week's
 *  seven rows, because they are a weekly self-assessment. Bodyweight, sleep,
 *  steps and the two free-text columns have a cell per day.
 *
 *  Writing to a non-anchor cell of a merged range does not do what it looks
 *  like: the value lands on the anchor, so "nutrition 4" sent on Saturday
 *  would appear to write to Saturday and actually change the whole week.
 *
 *  This follows the merge deliberately instead, so a weekly field updates the
 *  week and a daily field updates the day — WITHOUT a hardcoded list of which
 *  is which. The sheet already knows; asking it is cheaper than maintaining a
 *  copy that goes stale when the coach restructures a block.
 *
 *  Consequence worth knowing: sending a compliance score twice in one week
 *  overwrites, it does not accumulate. That is what a weekly score means. */
function writeCell(sheet, row, column, value) {
  var range = sheet.getRange(row, column);
  var merged = range.getMergedRanges();

  if (merged.length > 0) {
    merged[0].getCell(1, 1).setValue(value);
    return;
  }

  range.setValue(value);
}

/** Every label in the header rows, mapped to its column index. */
function readHeaders(grid) {
  var byLabel = {};
  var dateColumn = -1;
  var depth = Math.min(HEADER_DEPTH, grid.length);

  for (var r = 0; r < depth; r++) {
    var row = grid[r] || [];

    for (var c = 0; c < row.length; c++) {
      var label = normalise(row[c]);
      if (!label) continue;

      // First occurrence wins. Rows are scanned top-down, so a group heading
      // like NUTRITION would otherwise claim the column its first real label
      // ("Nutrition Compliance") belongs to.
      if (byLabel[label] === undefined) byLabel[label] = c;

      // Matched EXACTLY: "date" appears inside plenty of other headers, and
      // the merged group heading above it reads "DATES". A loose match would
      // send every write to the wrong row.
      if (label === 'date' && dateColumn === -1) dateColumn = c;
    }
  }

  return { byLabel: byLabel, dateColumn: dateColumn };
}

/** Exact match first, then "the header CONTAINS the label".
 *
 *  The containment pass is not a nicety: the coach's headers are longer than
 *  the names worth sending. "Hydration" must find "Hydration/Fluid Intake",
 *  "Off Plan Meal" must find "Off Plan Meal / Deviations", and "discomfort"
 *  must find "Did you face any physical discomfort or pain?".
 *
 *  Shortest match wins, so a label inside two headers picks the more specific
 *  one rather than whichever was scanned first. */
function matchColumn(byLabel, label) {
  var wanted = normalise(label);

  if (byLabel[wanted] !== undefined) return byLabel[wanted];

  var best;
  var bestLength = Infinity;

  for (var header in byLabel) {
    if (header.indexOf(wanted) === -1) continue;

    if (header.length < bestLength) {
      bestLength = header.length;
      best = byLabel[header];
    }
  }

  return best;
}

/** The row whose date cell is the day being written.
 *
 *  Compared on day-and-month only: the sheet shows "27 July" with no year
 *  anywhere, and a tracker never spans more than a few months. */
function findDateRow(grid, dateColumn, isoDate) {
  var parts = isoDate.split('-');
  var year = Number(parts[0]);
  var month = Number(parts[1]) - 1;
  var day = Number(parts[2]);

  for (var r = 0; r < grid.length; r++) {
    var parsed = parseCell(grid[r] ? grid[r][dateColumn] : '', year);
    if (!parsed) continue;

    if (parsed.getMonth() === month && parsed.getDate() === day) return r;
  }

  return -1;
}

/** "27 July" / "27/07/2026" / "2026-07-27" -> Date, or null. */
function parseCell(text, defaultYear) {
  var value = String(text == null ? '' : text).trim();

  // AVERAGES sits in the date column at the foot of every week block. A
  // permissive parser would treat it as a date and put a day's numbers into
  // the week's summary row.
  if (!value || value.toUpperCase().indexOf('AVERAGE') === 0) return null;

  // A bare "27 July" carries no year, so it is read against the year being
  // written rather than whatever the parser would assume.
  var dayMonth = value.match(/^(\d{1,2})\s+([A-Za-z]+)$/);

  if (dayMonth) {
    var d = new Date(dayMonth[2] + ' ' + dayMonth[1] + ', ' + defaultYear);
    return isNaN(d.getTime()) ? null : d;
  }

  var parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/** Lowercase, drop parenthesised notes and punctuation, collapse whitespace —
 *  so "(SCALE 1-5)" never becomes part of a label. */
function normalise(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function reply(text) {
  return ContentService.createTextOutput(text);
}

/**
 * Run this from the editor (Run > test_findsTodaysRow) to grant permission and
 * to see what the script makes of your sheet. It writes nothing.
 */
function test_findsTodaysRow() {
  var props = PropertiesService.getScriptProperties();
  var sheet = SpreadsheetApp
    .openById(props.getProperty('SHEET_ID'))
    .getSheetByName(TAB_NAME);

  if (!sheet) throw new Error('No tab named ' + TAB_NAME);

  var grid = sheet.getDataRange().getDisplayValues();
  var headers = readHeaders(grid);

  Logger.log('date column: %s', headers.dateColumn);
  Logger.log('labels found: %s', Object.keys(headers.byLabel).join(' | '));

  var wanted = ['BODYWEIGHT', 'Nutrition Compliance', 'Hydration',
                'Off Plan Meal', 'Exercise Compliance', 'Quantity of Sleep',
                'Steps', 'discomfort'];

  var today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  var row = findDateRow(grid, headers.dateColumn, today);

  Logger.log("today's row (%s): %s", today, row);

  for (var i = 0; i < wanted.length; i++) {
    var col = matchColumn(headers.byLabel, wanted[i]);

    if (col === undefined) {
      Logger.log('%s -> NO COLUMN MATCHED', wanted[i]);
      continue;
    }

    var where = 'column ' + col;

    if (row !== -1) {
      // Says whether this field is daily or weekly, and exactly which cell a
      // write would land in — the thing that is impossible to tell from a
      // screenshot and expensive to get wrong.
      var range = sheet.getRange(row + 1, col + 1);
      var merged = range.getMergedRanges();

      where = merged.length > 0
        ? 'WEEKLY, writes to ' + merged[0].getCell(1, 1).getA1Notation() +
          ' (merged ' + merged[0].getA1Notation() + ')'
        : 'daily, writes to ' + range.getA1Notation();
    }

    Logger.log('%s -> %s', wanted[i], where);
  }
}
