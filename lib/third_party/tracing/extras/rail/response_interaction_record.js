/**
Copyright (c) 2015 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("./rail_interaction_record.js");

'use strict';

/**
 * @fileoverview The Response phase of RAIL.
 */
global.tr.exportTo('tr.e.rail', function() {
  // The computeNormalizedComfort regions are delineated at these millisecond
  // latency values.
  var COMFORT_LATENCY_REGIONS = [150, 300, 1000, 5000];

  function ResponseInteractionRecord(parentModel, start, duration) {
    tr.e.rail.RAILInteractionRecord.call(
        this, parentModel, 'Response', 'rail_response', start, duration);
  }

  ResponseInteractionRecord.prototype = {
    __proto__: tr.e.rail.RAILInteractionRecord.prototype,

    get normalizedUserComfort() {
      // User comfort is derived from the time between when the user thinks they
      // begin an interation (expectedStart) and the time when the screen first
      // changes to reflect the interaction (actualEnd).  There may be a delay
      // between expectedStart and when chrome first starts processing the
      // interaction (actualStart) if the main thread is busy.  The user doesn't
      // know when actualStart is, they only know when expectedStart is. User
      // comfort, by definition, considers only what the user experiences, so
      // "duration" is defined as actualEnd - expectedStart.

      // https://www.desmos.com/calculator/xa9setwcmf
      return 1 - tr.e.rail.computeNormalizedComfort(this.duration, {
        minValueExponential: COMFORT_LATENCY_REGIONS[0],
        minValueLinear: COMFORT_LATENCY_REGIONS[1],
        minValueLogarithmic: COMFORT_LATENCY_REGIONS[2],
        maxValue: COMFORT_LATENCY_REGIONS[3]
      });
    }
  };

  return {
    ResponseInteractionRecord: ResponseInteractionRecord
  };
});
