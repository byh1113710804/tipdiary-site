/*
 * TipDiary "No Tax on Tips" deduction engine — faithful JS port of the TipTally app's
 * TaxEngine/DeductionCalculator.swift (+ DecimalMath.swift). Single source of truth for the
 * numbers on this site: every rule value comes from rules-v1.json (the same file the iOS app
 * consumes as a remote override). No tax magic numbers live in this code.
 *
 * MONEY IS NEVER A FLOAT. All money is carried as BigInt cents. Tax rates (e.g. 0.22) are carried
 * as BigInt integers scaled by 10000 (0.22 -> 2200n), i.e. exact 2-to-4-decimal factors.
 *
 * Rule order mirrors the Swift engine exactly:
 *   rules-stale check -> year coverage -> occupation eligibility -> cap progress ->
 *   MFS hard gate -> SE net-profit limit -> MAGI phase-out (floor per $1000 step) ->
 *   savings band from marginal-rate brackets.
 *
 * Rounding matches DecimalMath: floorToInt = floor (round toward zero on non-negative inputs);
 * round2 = round half away from zero to cents.
 *
 * Dual-environment: no module syntax, ES2020 (BigInt). Attaches to globalThis.TipDiaryEngine.
 */
(function (root) {
  'use strict';

  var RATE_SCALE = 10000n;   // rate 0.22 -> 2200n (exact for <= 4 decimal places)
  var CENTS = 100n;          // dollars -> cents
  var DOLLAR_STEP_CENTS = 100000n; // $1000 expressed in cents (phase-out step size)
  var STALE_THRESHOLD_MS = 180 * 86400 * 1000; // RULES.md: > 180 days since publishedAt -> stale

  // MAGI-unknown default savings band: array *positions* (not rates). Rates come from the JSON.
  var DEFAULT_LOW_BAND_INDEX = 1;   // typically 12%
  var DEFAULT_HIGH_BAND_INDEX = 3;  // typically 24%

  function isNil(v) { return v === null || v === undefined; }
  function bigMax(a, b) { return a > b ? a : b; }
  function bigMin(a, b) { return a < b ? a : b; }

  // ---- money / rate parsing (never touches binary floating point for the money magnitude) ----

  /**
   * Parse a money value to BigInt cents. Accepts:
   *   - null/undefined -> null
   *   - a decimal string ("12000", "12000.50", "$12,000.50")
   *   - a JS number (whole or 2-decimal dollar amount; parsed via its string form)
   * Values with more than 2 decimal places are rounded half away from zero to the nearest cent.
   */
  function toCents(value) {
    if (isNil(value)) return null;
    if (typeof value === 'bigint') return value;
    var s = String(value).trim();
    if (s === '') return null;
    s = s.replace(/[$,\s]/g, '');
    var sign = 1n;
    if (s.charAt(0) === '-') { sign = -1n; s = s.slice(1); }
    else if (s.charAt(0) === '+') { s = s.slice(1); }
    if (s === '') return null;
    var dot = s.indexOf('.');
    var intPart = dot === -1 ? s : s.slice(0, dot);
    var fracPart = dot === -1 ? '' : s.slice(dot + 1);
    if (intPart === '') intPart = '0';
    if (!/^\d+$/.test(intPart) || (fracPart !== '' && !/^\d+$/.test(fracPart))) {
      throw new Error('Invalid money value: ' + value);
    }
    var frac2 = (fracPart + '00').slice(0, 2);
    var cents = BigInt(intPart) * CENTS + BigInt(frac2);
    if (fracPart.length > 2 && fracPart.charAt(2) >= '5') cents += 1n; // round half away from zero
    return sign * cents;
  }

  /** Rule dollar amount (JSON number, whole or 2dp) -> BigInt cents. */
  function ruleMoneyToCents(v) {
    if (isNil(v)) return null;
    // Rule money values are integers/2dp; Math.round(v*100) is exact for those magnitudes.
    return BigInt(Math.round(Number(v) * 100));
  }

  /** Rule rate (JSON number like 0.22) -> BigInt scaled by 10000. Exact for <= 4 dp. */
  function rateToScaled(v) {
    return BigInt(Math.round(Number(v) * Number(RATE_SCALE)));
  }

  /** Format BigInt cents back to an exact minimal decimal string ("800000n" -> "8000"). */
  function centsToString(cents) {
    if (isNil(cents)) return null;
    var neg = cents < 0n;
    var n = neg ? -cents : cents;
    var whole = (n / CENTS).toString();
    var frac = (n % CENTS);
    var out;
    if (frac === 0n) {
      out = whole;
    } else {
      var f = frac.toString();
      if (f.length < 2) f = '0' + f;
      f = f.replace(/0+$/, '');
      out = whole + '.' + f;
    }
    return neg ? '-' + out : out;
  }

  // ---- date handling (deterministic; UTC, matches the Swift DateFormatter) ----

  function toEpochMs(d) {
    if (isNil(d)) return null;
    if (d instanceof Date) return d.getTime();
    if (typeof d === 'number') return d;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
    if (!m) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  // ---- rounding (mirrors DecimalMath) ----

  /** floor(numer/denom) for the non-negative inputs this engine produces. */
  function floorDiv(numer, denom) {
    // BigInt division truncates toward zero; inputs here are >= 0 so this is floor.
    return numer / denom;
  }

  /** round half away from zero of numer/denom (denom > 0). Mirrors NSDecimalRound(.plain). */
  function divRoundHalfAway(numer, denom) {
    var neg = numer < 0n;
    var n = neg ? -numer : numer;
    var q = (n * 2n + denom) / (denom * 2n); // floor(n/denom + 1/2)
    return neg ? -q : q;
  }

  // ---- bracket helpers ----

  /** Normalize a year's bracket array for a filing status into {upToCents, rateScaled} entries. */
  function normalizeBands(yearRules, filingStatusRaw) {
    var brackets = yearRules.brackets || {};
    var raw = brackets[filingStatusRaw];
    if (!raw || !raw.length) return null; // absent / empty -> savings not estimable (2027/2028)
    var bands = [];
    for (var i = 0; i < raw.length; i++) {
      bands.push({
        upToCents: isNil(raw[i].upTo) ? null : ruleMoneyToCents(raw[i].upTo),
        rateScaled: rateToScaled(raw[i].rate)
      });
    }
    return bands;
  }

  /** Marginal rate (scaled) at a given income: first band with income <= upTo; open top band = nil upTo. */
  function marginalRateScaled(bands, incomeCents) {
    for (var i = 0; i < bands.length; i++) {
      var b = bands[i];
      if (b.upToCents !== null) {
        if (incomeCents <= b.upToCents) return b.rateScaled;
      } else {
        return b.rateScaled;
      }
    }
    return bands.length ? bands[bands.length - 1].rateScaled : 0n;
  }

  /** savings = round2(deductibleDollars * rate). In cents: round(D_cents * rateScaled / 10000). */
  function savingsCents(deductibleCents, rateScaled) {
    return divRoundHalfAway(deductibleCents * rateScaled, RATE_SCALE);
  }

  // ---- core: deductible amount (cap -> SE limit -> MAGI phase-out) ----

  function deductibleAmount(qualifiedTipsCents, capCents, yearRules, input, primary, warnings) {
    // SE net-profit limit: qualified-tips deduction cannot exceed the business net profit.
    var base = qualifiedTipsCents;
    var seNet = toCents(input.selfEmploymentNetProfit);
    if (input.isSelfEmployed && seNet !== null && seNet < base) {
      base = bigMax(0n, seNet);
      if (primary) warnings.push('seNetProfitLimited');
    }

    // Cap.
    var capped = bigMin(base, capCents);

    // MAGI phase-out: floor((MAGI - start)/1000) steps, each removing reductionPer1000.
    var rawPhaseOut = 0n;
    var magi = toCents(input.magiEstimate);
    if (magi !== null) {
      var startCents = input.filingStatus === 'marriedJoint'
        ? ruleMoneyToCents(yearRules.phaseOut.startJoint)
        : ruleMoneyToCents(yearRules.phaseOut.startSingle);
      if (magi > startCents) {
        var steps = floorDiv(magi - startCents, DOLLAR_STEP_CENTS);
        rawPhaseOut = steps * ruleMoneyToCents(yearRules.phaseOut.reductionPer1000);
      }
      if (primary && rawPhaseOut > 0n) warnings.push('phaseOutApplies');
    } else if (primary) {
      warnings.push('magiUnknown');
    }

    var phaseOutReduction = bigMin(rawPhaseOut, capped); // deductible never negative
    return { deductible: capped - phaseOutReduction, phaseOutReduction: phaseOutReduction };
  }

  // ---- core: savings range (§9) ----

  function savingsRange(deductibleCents, bands, filingStatus, magiCents) {
    if (deductibleCents <= 0n || !bands) return { low: 0n, high: 0n };
    if (magiCents !== null) {
      var highRate = marginalRateScaled(bands, magiCents);
      var lowRate = marginalRateScaled(bands, bigMax(0n, magiCents - deductibleCents));
      return { low: savingsCents(deductibleCents, lowRate), high: savingsCents(deductibleCents, highRate) };
    }
    // MAGI unknown: default wide band (indexes are structural positions; rates come from JSON).
    var lowBand = bands[DEFAULT_LOW_BAND_INDEX] || bands[0];
    var highBand = bands[DEFAULT_HIGH_BAND_INDEX] || bands[bands.length - 1];
    return {
      low: savingsCents(deductibleCents, lowBand.rateScaled),
      high: savingsCents(deductibleCents, highBand.rateScaled)
    };
  }

  // ---- public: evaluate ----

  /**
   * evaluate(rules, input, referenceDate) -> DeductionResult-shaped object with money as strings.
   *   input: { taxYear:Number, filingStatus:String, qualifiedTipsYTD, projectedAnnualQualifiedTips,
   *            magiEstimate, isSelfEmployed:Bool, selfEmploymentNetProfit, occupationID }
   *   money fields may be decimal strings, numbers, or null.
   *   referenceDate: Date | "YYYY-MM-DD" | epoch ms (used only for the rules-stale check).
   * Returns money fields as exact decimal strings (or null); warnings as camelCase tag strings.
   */
  function evaluate(rules, input, referenceDate) {
    var warnings = [];

    // Rules-stale check (RULES.md appendix). referenceDate supplied by caller (deterministic).
    var pubMs = toEpochMs(rules.publishedAt);
    var refMs = toEpochMs(referenceDate);
    if (pubMs !== null && refMs !== null && (refMs - pubMs) > STALE_THRESHOLD_MS) {
      warnings.push('rulesStale');
    }

    // Year coverage.
    var yearRules = rules.taxYears ? rules.taxYears[String(input.taxYear)] : undefined;
    if (!yearRules) {
      warnings.push('yearNotCovered');
      return result('0', null, null, null, '0', '0', '0', '0', '0', warnings);
    }
    var capCents = ruleMoneyToCents(yearRules.deductionCapPerReturn);

    // Occupation eligibility: not-on-list / unset are warnings only; still compute.
    if (!isNil(input.occupationID)) {
      var occ = yearRules.occupations || [];
      var found = false;
      for (var i = 0; i < occ.length; i++) { if (occ[i].id === input.occupationID) { found = true; break; } }
      if (!found) warnings.push('occupationNotOnList');
    } else {
      warnings.push('occupationUnset');
    }

    // Cap progress (based on gross qualified tips).
    var grossCents = toCents(input.qualifiedTipsYTD);
    if (grossCents === null) grossCents = 0n;
    var cappedGross = bigMin(grossCents, capCents);
    var capRemaining = bigMax(0n, capCents - cappedGross);
    if (grossCents >= capCents) warnings.push('capReached');

    // MFS hard gate: ineligible by statute -> deduction 0 (short-circuits everything else).
    if (input.filingStatus === 'marriedSeparate') {
      warnings.push('mfsIneligible');
      var hasProjection = !isNil(input.projectedAnnualQualifiedTips);
      return result(
        '0',
        hasProjection ? '0' : null,
        hasProjection ? '0' : null,
        hasProjection ? '0' : null,
        centsToString(capCents),
        centsToString(capRemaining),
        '0', '0', '0', warnings
      );
    }

    // SSTB reminder for the self-employed (engine does not adjudicate; prompts verification).
    if (input.isSelfEmployed) warnings.push('sstbMayApply');

    var bands = normalizeBands(yearRules, input.filingStatus);
    var magiCents = toCents(input.magiEstimate);

    // Current (YTD) deductible + savings.
    var current = deductibleAmount(grossCents, capCents, yearRules, input, true, warnings);
    var curSav = savingsRange(current.deductible, bands, input.filingStatus, magiCents);

    // Projection (optional; same pipeline, no duplicate warning collection).
    var projectedDeductible = null, pLow = null, pHigh = null;
    if (!isNil(input.projectedAnnualQualifiedTips)) {
      var projTips = toCents(input.projectedAnnualQualifiedTips);
      if (projTips === null) projTips = 0n;
      var sink = [];
      var projected = deductibleAmount(projTips, capCents, yearRules, input, false, sink);
      projectedDeductible = centsToString(projected.deductible);
      var pSav = savingsRange(projected.deductible, bands, input.filingStatus, magiCents);
      pLow = centsToString(pSav.low);
      pHigh = centsToString(pSav.high);
    }

    return result(
      centsToString(current.deductible),
      projectedDeductible,
      pLow,
      pHigh,
      centsToString(capCents),
      centsToString(capRemaining),
      centsToString(current.phaseOutReduction),
      centsToString(curSav.low),
      centsToString(curSav.high),
      warnings
    );
  }

  function result(deductibleNow, projectedDeductible, projectedSavingsLow, projectedSavingsHigh,
                  capTotal, capRemaining, phaseOutReduction, estimatedSavingsLow, estimatedSavingsHigh,
                  warnings) {
    return {
      deductibleNow: deductibleNow,
      projectedDeductible: projectedDeductible,
      projectedSavingsLow: projectedSavingsLow,
      projectedSavingsHigh: projectedSavingsHigh,
      capTotal: capTotal,
      capRemaining: capRemaining,
      phaseOutReduction: phaseOutReduction,
      estimatedSavingsLow: estimatedSavingsLow,
      estimatedSavingsHigh: estimatedSavingsHigh,
      warnings: warnings
    };
  }

  var api = {
    evaluate: evaluate,
    // exported for reuse/testing:
    _toCents: toCents,
    _centsToString: centsToString,
    _rateToScaled: rateToScaled
  };

  root.TipDiaryEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
