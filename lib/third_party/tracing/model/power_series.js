/**
Copyright (c) 2015 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("../base/range.js");
require("./event_container.js");
require("./power_sample.js");

'use strict';

global.tr.exportTo('tr.model', function() {

  var PowerSample = tr.model.PowerSample;

  /**
   * A container holding a time series of power samples.
   *
   * @constructor
   * @extends {EventContainer}
   */
  function PowerSeries(device) {
    tr.model.EventContainer.call(this);

    this.device_ = device;
    this.samples_ = [];
  }

  PowerSeries.prototype = {
    __proto__: tr.model.EventContainer.prototype,

    get device() {
      return this.device_;
    },

    get samples() {
      return this.samples_;
    },

    get stableId() {
      return this.device_.stableId + '.PowerSeries';
    },

    /**
     * Adds a power sample to the series and returns it.
     *
     * Note: Samples must be added in chronological order.
     */
    addPowerSample: function(ts, val) {
      var sample = new PowerSample(this, ts, val);
      this.samples_.push(sample);
      return sample;
    },

    /**
     * Returns the total energy (in Joules) consumed between the specified
     * start and end timestamps (in milliseconds).
     */
    getEnergyConsumed: function(start, end) {
      var measurementRange = tr.b.Range.fromExplicitRange(start, end);

      var energyConsumed = 0;
      for (var i = 0; i < this.samples.length; i++) {
        var sample = this.samples[i];
        var nextSample = this.samples[i + 1];

        var sampleRange = new tr.b.Range();
        sampleRange.addValue(sample.start);
        sampleRange.addValue(nextSample ? nextSample.start : Infinity);

        var timeIntersection = measurementRange.findIntersection(sampleRange);

        // Divide by 1000 to convert milliseconds to seconds.
        energyConsumed += timeIntersection.duration / 1000 * sample.power;
      }

      return energyConsumed;
    },

    shiftTimestampsForward: function(amount) {
      for (var i = 0; i < this.samples_.length; ++i)
        this.samples_[i].start += amount;
    },

    updateBounds: function() {
      this.bounds.reset();

      if (this.samples_.length === 0)
        return;

      this.bounds.addValue(this.samples_[0].start);
      this.bounds.addValue(this.samples_[this.samples_.length - 1].start);
    },

    iterateAllEventsInThisContainer: function(eventTypePredicate, callback,
                                              opt_this) {
      if (eventTypePredicate.call(opt_this, PowerSample))
        this.samples_.forEach(callback, opt_this);
    },

    iterateAllChildEventContainers: function(callback, opt_this) {
    }
  };

  return {
    PowerSeries: PowerSeries
  };
});
