/**
Copyright (c) 2015 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("./rail_interaction_record.js");

'use strict';

/**
 * @fileoverview The Load phase of RAIL.
 */
global.tr.exportTo('tr.e.rail', function() {
  // The computeNormalizedComfort regions are delineated at these millisecond
  // latency values.
  var COMFORT_LATENCY_REGIONS = [1000, 5000, 20000, 60000];

  function LoadInteractionRecord(parentModel, start, duration) {
    tr.e.rail.RAILInteractionRecord.call(
        this, parentModel, 'Load', 'rail_load',
        start, duration);

    // |renderProcessId| identifies the renderer process that contains the
    // loading RenderFrame.
    this.renderProcessId = undefined;

    // |routingId| identifies the loading RenderFrame within the renderer
    // process.
    this.routingId = undefined;

    // |parentRoutingId| identifies the RenderFrame that created and contains
    // the loading RenderFrame.
    this.parentRoutingId = undefined;

    // Startup LoadIRs do not have renderProcessId, routingId, or
    // parentRoutingId. Maybe RenderLoadIR should be a separate class?
  }

  LoadInteractionRecord.prototype = {
    __proto__: tr.e.rail.RAILInteractionRecord.prototype,

    get normalizedUserComfort() {
      // https://www.desmos.com/calculator/ddcv31509h
      return 1 - tr.e.rail.computeNormalizedComfort(this.duration, {
        minValueExponential: COMFORT_LATENCY_REGIONS[0],
        minValueLinear: COMFORT_LATENCY_REGIONS[1],
        minValueLogarithmic: COMFORT_LATENCY_REGIONS[2],
        maxValue: COMFORT_LATENCY_REGIONS[3]
      });
    }
  };

  return {
    LoadInteractionRecord: LoadInteractionRecord
  };
});
