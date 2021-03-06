/**
Copyright (c) 2013 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("./slice.js");

'use strict';

/**
 * @fileoverview Provides the Thread class.
 */
global.tr.exportTo('tr.model', function() {
  var Slice = tr.model.Slice;

  /**
   * A ThreadSlice represents an interval of time on a thread resource
   * with associated nesting slice information.
   *
   * ThreadSlices are typically associated with a specific trace event pair on a
   * specific thread.
   * For example,
   *   TRACE_EVENT_BEGIN1("x","myArg", 7) at time=0.1ms
   *   TRACE_EVENT_END0()                 at time=0.3ms
   * This results in a single slice from 0.1 with duration 0.2 on a
   * specific thread.
   *
   * @constructor
   */
  function ThreadSlice(cat, title, colorId, start, args, opt_duration,
                       opt_cpuStart, opt_cpuDuration, opt_argsStripped,
                       opt_bind_id) {
    Slice.call(this, cat, title, colorId, start, args, opt_duration,
               opt_cpuStart, opt_cpuDuration, opt_argsStripped, opt_bind_id);
    // Do not modify this directly.
    // subSlices is configured by SliceGroup.rebuildSubRows_.
    this.subSlices = [];
  }

  ThreadSlice.prototype = {
    __proto__: Slice.prototype,

    getProcess: function() {
      var thread = this.parentContainer;
      if (thread && thread.getProcess)
        return thread.getProcess();
      return undefined;
    }
  };

  tr.model.EventRegistry.register(
      ThreadSlice,
      {
        name: 'slice',
        pluralName: 'slices',
        singleViewElementName: 'tr-ui-a-single-thread-slice-sub-view',
        multiViewElementName: 'tr-ui-a-multi-thread-slice-sub-view'
      });

  return {
    ThreadSlice: ThreadSlice
  };
});
