/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/tender-parser.js  —  SKS NSW Labour
// SKS Smartsheet "Open 12m Tenders (State) - NSW" xlsx parser.
//
// Pure logic — no DOM, no Supabase. Parses an xlsx upload into
// normalised tender rows and diffs against existing rows already
// in the tenders table.
//
// Depends on window.XLSX (SheetJS UMD). The xlsx library is NOT
// in the SKS stack today — the import screen that uses this
// parser is responsible for loading SheetJS via <script src> in
// index.html before this file runs. parseTenderXlsx throws a
// clear error if window.XLSX is missing rather than silently
// returning bad data.
//
// Bundle origin: C:\Projects\eq-field-pipeline\src\lib\tender-parser.js
// Ported from ESM + vitest to IIFE for the SKS no-bundler stack.
//
// Column map locked against a real NSW export sampled 2026-05-22
// (323 rows, all 12 expected headers present and exact).
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Column mapping ────────────────────────────────────────
  // Smartsheet header → tender field. Parser fails with "Missing
  // required columns" if any are absent on first row of the sheet.

  var COLUMN_MAP = {
    'SITE / JOB NAME':       'job_name',
    'SKS Quote No':          'external_ref',
    'Due Date':              'due_date',
    'Status':                'tender_status',
    'Project $ Amount':      'quote_value',
    'SKS Estimator':         'estimator',
    'Builder/Client Name':   'client',
    'Market Vertical':       'vertical',
    'SKS Dept':              'department',
    'Site Address':          'site_address',
    'SKS Entity':            'entity',
    'Probability':           '_probability_raw' // parsed into pct + label below
  };

  var REQUIRED_COLUMNS = Object.keys(COLUMN_MAP);

  // ── Stage mapping ─────────────────────────────────────────
  // Probability % → pipeline_stage enum value (matches the
  // tender_pipeline migration's pipeline_stage enum).

  function probabilityToStage(pct) {
    if (pct === null || pct === undefined) return 'tracked';
    if (pct === 100) return 'won';
    if (pct >= 70)   return 'likely';
    if (pct >= 50)   return 'watch';
    return 'tracked'; // 0%, 25%, anything below 50%
  }

  // ── Probability parser ────────────────────────────────────
  // "70% - In Negotiation" → { pct: 70, label: "70% - In Negotiation" }
  // Handles blanks, malformed strings, edge cases.

  function parseProbability(raw) {
    if (raw === null || raw === undefined || raw === '') {
      return { pct: null, label: null };
    }
    var str = String(raw).trim();
    var match = str.match(/^(\d{1,3})\s*%/);
    if (!match) return { pct: null, label: str };
    var pct = parseInt(match[1], 10);
    if (pct < 0 || pct > 100) return { pct: null, label: str };
    return { pct: pct, label: str };
  }

  // ── Excel serial date → ISO date string ───────────────────
  // SheetJS handles dates if cellDates:true is passed, but
  // Smartsheet exports sometimes arrive as raw serials, so we
  // handle both Date objects and numeric serials.

  function excelSerialToIsoDate(serial) {
    if (serial === null || serial === undefined || serial === '') return null;
    // Already a Date object (cellDates:true path)
    if (serial instanceof Date && !isNaN(serial)) {
      return serial.toISOString().slice(0, 10);
    }
    // String date — try parsing
    if (typeof serial === 'string') {
      var d = new Date(serial);
      if (!isNaN(d)) return d.toISOString().slice(0, 10);
      return null;
    }
    // Excel serial (number) — epoch is 1899-12-30 (accounts for
    // the 1900 leap year bug)
    if (typeof serial === 'number' && serial > 0) {
      var epoch = Date.UTC(1899, 11, 30);
      var ms = epoch + serial * 86400 * 1000;
      var dd = new Date(ms);
      if (!isNaN(dd)) return dd.toISOString().slice(0, 10);
    }
    return null;
  }

  // ── Quote value parser ────────────────────────────────────
  // Handles blanks, "0", numeric strings, currency-formatted
  // strings ("$65,000"). Zero or negative returns null so the
  // below_threshold flag fires (a $0 tender is noise).

  function parseQuoteValue(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number') return raw <= 0 ? null : raw;
    if (typeof raw === 'string') {
      var cleaned = raw.replace(/[$,\s]/g, '');
      if (cleaned === '' || cleaned === '0') return null;
      var n = parseFloat(cleaned);
      if (isNaN(n)) return null;
      return n <= 0 ? null : n;
    }
    return null;
  }

  // ── External ref normaliser ───────────────────────────────
  // "SKS - 16404" → "SKS-16404". Trim, uppercase, single dash.
  // Idempotent join key — same input always yields same output.

  function normaliseExternalRef(raw) {
    if (!raw) return null;
    return String(raw).trim().toUpperCase().replace(/\s*-\s*/g, '-');
  }

  // ── Main parser ───────────────────────────────────────────
  // xlsx file → { rows: [...], errors: [...] }
  // Default value floor: $100,000 (flat across all departments,
  // confirmed 2026-05-22 — AV departments intentionally out of
  // scope at this floor).

  async function parseTenderXlsx(file, options) {
    options = options || {};
    var valueFloor = options.valueFloor != null ? options.valueFloor : 100000;
    var errors = [];
    var rows = [];

    if (!window.XLSX || typeof window.XLSX.read !== 'function') {
      errors.push({
        severity: 'fatal',
        message: 'XLSX library not loaded — add <script src="…sheetjs.full.min.js"> to index.html before scripts/tender-parser.js'
      });
      return { rows: rows, errors: errors };
    }
    var XLSX = window.XLSX;

    var workbook;
    try {
      var buffer = await file.arrayBuffer();
      workbook = XLSX.read(buffer, { cellDates: true });
    } catch (e) {
      errors.push({ severity: 'fatal', message: 'Could not read xlsx: ' + (e && e.message ? e.message : String(e)) });
      return { rows: rows, errors: errors };
    }

    // Use first sheet by default — the NSW Smartsheet export
    // puts the data sheet first ("Open 12m Tenders (State) - NSW")
    // and a "Comments" sheet second.
    var sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      errors.push({ severity: 'fatal', message: 'No sheets found in file' });
      return { rows: rows, errors: errors };
    }
    var sheet = workbook.Sheets[sheetName];
    var jsonRows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false, dateNF: 'yyyy-mm-dd' });

    if (jsonRows.length === 0) {
      errors.push({ severity: 'fatal', message: 'Sheet is empty' });
      return { rows: rows, errors: errors };
    }

    // Validate required columns exist
    var firstRow = jsonRows[0];
    var presentColumns = Object.keys(firstRow);
    var missingColumns = REQUIRED_COLUMNS.filter(function (c) { return presentColumns.indexOf(c) === -1; });
    if (missingColumns.length > 0) {
      errors.push({
        severity: 'fatal',
        message: 'Missing required columns: ' + missingColumns.join(', ')
      });
      return { rows: rows, errors: errors };
    }

    // Parse each row
    jsonRows.forEach(function (row, index) {
      var externalRef = normaliseExternalRef(row['SKS Quote No']);
      if (!externalRef) {
        errors.push({
          severity: 'warning',
          rowIndex: index,
          message: 'Row ' + (index + 2) + ': missing SKS Quote No, skipping'
        });
        return;
      }

      var prob = parseProbability(row['Probability']);
      var quoteValue = parseQuoteValue(row['Project $ Amount']);
      var dueDate = excelSerialToIsoDate(row['Due Date']);

      rows.push({
        external_ref:      externalRef,
        job_name:          (row['SITE / JOB NAME'] || '').toString().trim() || null,
        client:            (row['Builder/Client Name'] || '').toString().trim() || null,
        estimator:         (row['SKS Estimator'] || '').toString().trim() || null,
        vertical:          (row['Market Vertical'] || '').toString().trim() || null,
        department:        (row['SKS Dept'] || '').toString().trim() || null,
        entity:            (row['SKS Entity'] || '').toString().trim() || null,
        site_address:      (row['Site Address'] || '').toString().trim() || null,
        quote_value:       quoteValue,
        due_date:          dueDate,
        tender_status:     (row['Status'] || '').toString().trim() || null,
        probability_pct:   prob.pct,
        probability_label: prob.label,
        stage:             probabilityToStage(prob.pct),
        below_threshold:   quoteValue === null || quoteValue < valueFloor,
        _row_index:        index + 2 // 1-indexed + header for error reporting
      });
    });

    return { rows: rows, errors: errors };
  }

  // ── Diff parsed rows against existing tenders ─────────────
  // Returns { new, stageChanged, valueChanged, unchanged, missing }.
  // `existing` is an array of { external_ref, probability_pct,
  // quote_value } objects fetched from the tenders table.

  function diffAgainstExisting(parsedRows, existing) {
    var existingByRef = {};
    existing.forEach(function (e) { existingByRef[e.external_ref] = e; });
    var parsedRefs = {};
    parsedRows.forEach(function (r) { parsedRefs[r.external_ref] = true; });

    var diff = {
      new:          [],
      stageChanged: [],
      valueChanged: [],
      unchanged:    [],
      missing:      [] // in DB but not in parsed file
    };

    parsedRows.forEach(function (row) {
      var prev = existingByRef[row.external_ref];
      if (!prev) { diff.new.push(row); return; }
      var prevPct = prev.probability_pct == null ? null : prev.probability_pct;
      var rowPct  = row.probability_pct  == null ? null : row.probability_pct;
      var prevVal = prev.quote_value     == null ? null : prev.quote_value;
      var rowVal  = row.quote_value      == null ? null : row.quote_value;
      var stageChanged = prevPct !== rowPct;
      var valueChanged = prevVal !== rowVal;
      if (stageChanged && valueChanged) {
        diff.stageChanged.push(Object.assign({}, row, { previous: prev }));
        diff.valueChanged.push(Object.assign({}, row, { previous: prev }));
      } else if (stageChanged) {
        diff.stageChanged.push(Object.assign({}, row, { previous: prev }));
      } else if (valueChanged) {
        diff.valueChanged.push(Object.assign({}, row, { previous: prev }));
      } else {
        diff.unchanged.push(row);
      }
    });

    // Missing = in existing but not in parsed
    existing.forEach(function (prev) {
      if (!parsedRefs[prev.external_ref]) diff.missing.push(prev);
    });

    return diff;
  }

  // ── Summary for tender_import_runs ────────────────────────

  function summariseImport(diff, parsedRows) {
    return {
      rows_total:            parsedRows.length,
      rows_new:              diff.new.length,
      rows_stage_changed:    diff.stageChanged.length,
      rows_value_changed:    diff.valueChanged.length,
      rows_missing:          diff.missing.length,
      rows_below_threshold:  parsedRows.filter(function (r) { return r.below_threshold; }).length
    };
  }

  // ── Exported namespace ────────────────────────────────────

  window.SKS_TENDER_PARSER = {
    parseTenderXlsx:      parseTenderXlsx,
    diffAgainstExisting:  diffAgainstExisting,
    summariseImport:      summariseImport,
    probabilityToStage:   probabilityToStage,
    parseProbability:     parseProbability,
    excelSerialToIsoDate: excelSerialToIsoDate,
    parseQuoteValue:      parseQuoteValue,
    normaliseExternalRef: normaliseExternalRef,
    REQUIRED_COLUMNS:     REQUIRED_COLUMNS,
    COLUMN_MAP:           COLUMN_MAP
  };
})();
