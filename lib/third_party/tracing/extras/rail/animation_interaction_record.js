/**
Copyright (c) 2015 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("../../base/statistics.js");
require("../chrome/chrome_process_helper.js");
require("./rail_interaction_record.js");

'use strict';

/**
 * @fileoverview The Animation phase of RAIL.
 */
global.tr.exportTo('tr.e.rail', function() {
  // The computeNormalizedComfort regions are delineated at these FPS values.
  var COMFORT_FPS_REGIONS = [60, 40, 30, 10];

  // A frame is long if it starts more than this much time after the previous
  // frame.
  var LONG_FRAME_MS = 50;

  // The computeNormalizedComfort regions are delineated at these relative
  // discrepancy values.
  var COMFORT_JANK_REGIONS = [0.05, 0.1, 0.2, 0.3];

  function AnimationInteractionRecord(parentModel, start, duration) {
    tr.e.rail.RAILInteractionRecord.call(
        this, parentModel, 'Animation', 'rail_animate',
        start, duration);
    this.frameEvents_ = undefined;
  }

  AnimationInteractionRecord.prototype = {
    __proto__: tr.e.rail.RAILInteractionRecord.prototype,

    get frameEvents() {
      if (this.frameEvents_)
        return this.frameEvents_;

      this.frameEvents_ = new tr.model.EventSet();

      this.associatedEvents.forEach(function(event) {
        if (event.title === tr.e.audits.IMPL_RENDERING_STATS)
          this.frameEvents_.push(event);
      }, this);

      return this.frameEvents_;
    },

    get normalizedUserComfort() {
      return tr.e.rail.weightedAverage2(
          this.normalizedJankComfort, this.normalizedFPSComfort);
    },

    get normalizedFPSComfort() {
      var durationSeconds = this.duration / 1000;
      var avgSpf = durationSeconds / this.frameEvents.length;
      return 1 - tr.e.rail.computeNormalizedComfort(avgSpf, {
        minValueExponential: 1 / COMFORT_FPS_REGIONS[0],
        minValueLinear: 1 / COMFORT_FPS_REGIONS[1],
        minValueLogarithmic: 1 / COMFORT_FPS_REGIONS[2],
        maxValue: 1 / COMFORT_FPS_REGIONS[3]
      });
    },

    get normalizedJankComfort() {
      var frameTimestamps = this.frameEvents.toArray().map(function(event) {
        return event.start;
      });
      var absolute = false;
      var discrepancy = tr.b.Statistics.timestampsDiscrepancy(
          frameTimestamps, absolute);
      return 1 - tr.e.rail.computeNormalizedComfort(discrepancy, {
        minValueExponential: COMFORT_JANK_REGIONS[0],
        minValueLinear: COMFORT_JANK_REGIONS[1],
        minValueLogarithmic: COMFORT_JANK_REGIONS[2],
        maxValue: COMFORT_JANK_REGIONS[3]
      });
    }
  };

  return {
    AnimationInteractionRecord: AnimationInteractionRecord
  };
});
