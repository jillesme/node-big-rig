/**
Copyright (c) 2015 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("../../base/base.js");
require("../../base/statistics.js");
require("../../core/auditor.js");
require("../../model/model.js");
require("../../base/range_utils.js");
require("../chrome/chrome_model_helper.js");

'use strict';

/**
 * @fileoverview Base class for trace data Auditors.
 */
global.tr.exportTo('tr.e.rail', function() {
  // When computing an IR's RAIL score, the IR's comfort and efficiency are
  // averaged together such that the lower score has a higher weight.
  // Without knowing which sub-score is lower, comfort is
  // theoretically twice as important as efficiency. If the entire web were to
  // eventually achieve relatively high comfort scores such that comfort was
  // less of a concern than efficiency, then this number could be lowered. If
  // further thought suggests that comfort is even more than twice as important
  // as efficiency, then this number could be raised.
  // Must be greater than 0.
  var COMFORT_IMPORTANCE = 2;

  // We need an up-front list of all IR types in order to keep various groupings
  // stable, in presence of only a portion of interactions in a given trace.
  var ALL_RAIL_TYPE_NAMES = [
    'rail_response',
    'rail_animate',
    'rail_idle',
    'rail_load'
  ];

  var DOES_RAIL_TYPE_NAME_EXIST = {};
  ALL_RAIL_TYPE_NAMES.forEach(function(railTypeName) {
    DOES_RAIL_TYPE_NAME_EXIST[railTypeName] = true;
  });

  var RAIL_ORDER = [];
  ALL_RAIL_TYPE_NAMES.forEach(function(railTypeName) {
    RAIL_ORDER.push(railTypeName.toUpperCase());
    RAIL_ORDER.push(userFriendlyRailTypeName(railTypeName).toUpperCase());
  });



  function RAILInteractionRecord(
      parentModel, title, railTypeName, start, duration) {
    if (!DOES_RAIL_TYPE_NAME_EXIST[railTypeName])
      throw new Error(railTypeName + ' is not listed in ALL_RAIL_TYPE_NAMES');

    var colorId = tr.ui.b.getColorIdForReservedName(railTypeName);
    this.railTypeName_ = railTypeName;
    this.name = '';
    tr.model.InteractionRecord.call(
        this, parentModel, title, colorId, start, duration);
  }

  RAILInteractionRecord.prototype = {
    __proto__: tr.model.InteractionRecord.prototype,

    updateArgs: function() {
      var args = {};

      var layoutSlices = this.associatedEvents.filter(function(event) {
        return event.title === 'FrameView::layout';
      });
      var timeInLayout = tr.b.Statistics.sum(layoutSlices, function(event) {
        return event.duration;
      });

      args['layoutInfo'] = {
        'timeInLayout': timeInLayout
      };

      this.args = args;
    },

    get railTypeName() {
      return this.railTypeName_;
    },

    /**
     * Returns the overall rail score, from 0 to 1.
     *
     * RAILScore for an interaction merges the user's comfort with the
     * efficiency, in order to create a perception-oriented measure
     * of how users percieve speed during this interaction.
     *
     *  0 means a bad user experience.
     *  1 means a perfect user experience.
     */
    get railScore() {
      var comfort = this.normalizedUserComfort;
      var efficiency = this.normalizedEfficiency;
      return weightedAverage2(comfort, efficiency, COMFORT_IMPORTANCE);
    },

    /**
     * Measures the comfort the user experienced, from 0 to 1.
     *
     * A user performs an interaction with an expectation in mind.
     * When we meet their expectations, we get perfect comfort.
     * When we don't live up to their expectations, comfort goes down.
     */
    get normalizedUserComfort() {
      throw new Error('Not implemented');
    },

    /**
     * Returns the sum of the number of CPU ms spent by this IR.
     */
    get rawCpuMs() {
      var cpuMs = 0;
      this.associatedEvents.forEach(function(event) {
        if (event.cpuSelfTime)
          cpuMs += event.cpuSelfTime;
      });
      return cpuMs;
    },

    /**
     * Returns a number between 0 and 1 representing how efficiently this IR
     * used CPU resources. 0 is maximally in-efficient, 1 is maximally
     * efficient.
     */
    get normalizedCpuEfficiency() {
      var minCpuMs = this.duration * this.minCpuFraction;
      var maxCpuMs = this.duration * this.maxCpuFraction;
      var normalizedCpu = tr.b.normalize(this.rawCpuMs, minCpuMs, maxCpuMs);
      return 1 - tr.b.clamp(normalizedCpu, 0, 1);
    },

    /**
     * The minimum fraction of a CPU that can be spent on this IR before the
     * efficiency score will be impacted.
     * If less CPU ms than this is spent on this IR, then
     * normalizedCpuEfficiency will be 1.
     */
    get minCpuFraction() {
      return 0.5;
    },

    /**
     * The maximum fraction of a CPU that can be spent on this IR.
     * If more CPU ms than this is spent on this IR, then
     * normalizedCpuEfficiency will be 0.
     */
    get maxCpuFraction() {
      return 1.5;
    },

    /**
     * Measures the efficiency of the interaction from 0 to 1.
     *
     * Efficiency is a notion of how well we used the machine's limited
     * resources in service of this interaction. If we used it perfectly,
     * we would get a 1.0. If we used everything that there was to use ---
     * power, memory, cpu, then we'd get a zero.
     */
    get normalizedEfficiency() {
      return this.normalizedCpuEfficiency;
    }
  };

  // The following functions are useful for sub-classes to override
  // normalizedUserComfort.

  // Any computable value related to an IR can be used to define the comfort of
  // that IR: its duration, its FPS, etc.
  // computeNormalizedComfort maps from that arbitrary value to a score between
  // 0 and 1, allowing the caller to customize the exponential, linear, and
  // logarithmic regions of the mapping function.
  function computeNormalizedComfort(value, opts) {
    if (typeof value !== 'number')
      throw new Error('value must be a number');

    opts.exponentialBase = opts.exponentialBase || 10;
    if (opts.exponentialBase <= 1)
      throw new Error('exponentialBase must be greater than 1');

    opts.minComfortLinear = opts.minComfortLinear || 0.2;
    if (opts.minComfortLinear <= 0 || opts.minComfortLinear >= 1)
      throw new Error('minComfortLinear must be between 0 and 1 exclusive');

    opts.maxComfortLinear = opts.maxComfortLinear || 0.9;
    if (opts.maxComfortLinear <= 0 || opts.maxComfortLinear >= 1)
      throw new Error('maxComfortLinear must be between 0 and 1 exclusive');

    opts.logarithmicScale = opts.logarithmicScale || 100;
    if (opts.logarithmicScale <= 0)
      throw new Error('logarithmicScale must be positive');

    if (opts.minValueExponential >= opts.minValueLinear)
      throw new Error('minValueExponential must be less than minValueLinear');

    if (opts.minValueLinear >= opts.minValueLogarithmic)
      throw new Error('minValueLinear must be less than minValueLogarithmic');

    if (opts.minValueLogarithmic >= opts.maxValue)
      throw new Error('minValueLogarithmic must be less than maxValue');

    [
      'minValueLinear',
      'minValueExponential',
      'minValueLogarithmic',
      'maxValue',
      'exponentialBase',
      'minComfortLinear',
      'maxComfortLinear',
      'logarithmicScale'
    ].forEach(function(opt) {
      if (typeof opts[opt] !== 'number')
        throw new Error(opt + ' must be a number');
    });

    if (value < opts.minValueExponential)
      return 0;

    if (value < opts.minValueLinear) {
      function computeRawComfort(value) {
        return Math.pow(opts.exponentialBase, value);
      }
      return computeNormalizedComfortInternal(
          value, opts.minValueExponential, opts.minValueLinear,
          0, opts.minComfortLinear, computeRawComfort);
    }

    if (value < opts.minValueLogarithmic) {
      function computeRawComfort(value) {
        return value;
      }
      return computeNormalizedComfortInternal(
          value, opts.minValueLinear, opts.minValueLogarithmic,
          opts.minComfortLinear, opts.maxComfortLinear, computeRawComfort);
    }

    if (value < opts.maxValue) {
      function computeRawComfort(value) {
        return Math.log1p(opts.logarithmicScale * value);
      }
      return computeNormalizedComfortInternal(
          value, opts.minValueLogarithmic, opts.maxValue,
          opts.maxComfortLinear, 1, computeRawComfort);
    }

    return 1;
  }

  function computeNormalizedComfortInternal(
      value, minValue, maxValue, minScore, maxScore, computeRawComfort) {
    var normalizedValue = tr.b.normalize(value, minValue, maxValue);
    var rawComfort = computeRawComfort(normalizedValue);
    var minComfort = computeRawComfort(0);
    var maxComfort = computeRawComfort(1);
    var normalizedComfort = tr.b.normalize(rawComfort, minComfort, maxComfort);
    normalizedComfort = tr.b.lerp(normalizedComfort, minScore, maxScore);
    return tr.b.clamp(normalizedComfort, minScore, maxScore);
  }

  // Returns a weighted average of numbers between 0 and 1.
  // The lower input has a higher weight.
  // If the first input should have a higher weight a priori its relationship to
  // the other input, then set opt_apriori > 1.
  // This function is graphed at http://goo.gl/XMWUKA
  function weightedAverage2(x, y, opt_apriori) {
    var numerator = 0;
    var denominator = 0;

    var xWeight = (opt_apriori || 1) * Math.exp(1 - x);
    numerator += xWeight * x;
    denominator += xWeight;

    var yWeight = Math.exp(1 - y);
    numerator += yWeight * y;
    denominator += yWeight;

    return numerator / denominator;
  }

  // A user friendly name is currently formed by dropping the rail_ prefix and
  // capitalizing.
  function userFriendlyRailTypeName(railTypeName) {
    if (railTypeName.length < 6 || railTypeName.indexOf('rail_') != 0)
      return railTypeName;
    return railTypeName[5].toUpperCase() + railTypeName.slice(6);
  }

  // Compare two rail type names or rail user-friendly names so they are sorted
  // in R,A,I,L order. Capitalization is ignore. Non rail names are sorted
  // lexicographically after rail names.
  function railCompare(name1, name2) {
    var i1 = RAIL_ORDER.indexOf(name1.toUpperCase());
    var i2 = RAIL_ORDER.indexOf(name2.toUpperCase());
    if (i1 == -1 && i2 == -1)
      return name1.localeCompare(name2);
    if (i1 == -1)
      return 1;   // i2 is a RAIL name but not i1.
    if (i2 == -1)
      return -1;  // i1 is a RAIL name but not i2.
    // Two rail names.
    return i1 - i2;
  }

  return {
    RAILInteractionRecord: RAILInteractionRecord,
    computeNormalizedComfort: computeNormalizedComfort,
    weightedAverage2: weightedAverage2,
    userFriendlyRailTypeName: userFriendlyRailTypeName,
    railCompare: railCompare,
    ALL_RAIL_TYPE_NAMES: ALL_RAIL_TYPE_NAMES
  };
});
