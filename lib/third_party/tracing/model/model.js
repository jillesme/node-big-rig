/**
Copyright (c) 2012 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("../base/base.js");
require("../base/event.js");
require("../base/interval_tree.js");
require("../base/range.js");
require("../base/task.js");
require("../base/units/units.js");
require("../core/auditor.js");
require("../core/filter.js");
require("./alert.js");
require("./device.js");
require("./flow_event.js");
require("./frame.js");
require("./global_memory_dump.js");
require("./instant_event.js");
require("./interaction_record.js");
require("./kernel.js");
require("./model_indices.js");
require("./process.js");
require("./process_memory_dump.js");
require("./sample.js");
require("./stack_frame.js");
require("../ui/base/overlay.js");

'use strict';

/**
 * @fileoverview Model is a parsed representation of the
 * TraceEvents obtained from base/trace_event in which the begin-end
 * tokens are converted into a hierarchy of processes, threads,
 * subrows, and slices.
 *
 * The building block of the model is a slice. A slice is roughly
 * equivalent to function call executing on a specific thread. As a
 * result, slices may have one or more subslices.
 *
 * A thread contains one or more subrows of slices. Row 0 corresponds to
 * the "root" slices, e.g. the topmost slices. Row 1 contains slices that
 * are nested 1 deep in the stack, and so on. We use these subrows to draw
 * nesting tasks.
 *
 */
global.tr.exportTo('tr', function() {
  var Process = tr.model.Process;
  var Device = tr.model.Device;
  var Kernel = tr.model.Kernel;
  var GlobalMemoryDump = tr.model.GlobalMemoryDump;
  var GlobalInstantEvent = tr.model.GlobalInstantEvent;
  var FlowEvent = tr.model.FlowEvent;
  var Alert = tr.model.Alert;
  var InteractionRecord = tr.model.InteractionRecord;
  var Sample = tr.model.Sample;

  function ClockSyncRecord(name, ts, args) {
    this.name = name;
    this.ts = ts;
    this.args = args;
  }

  /**
   * @constructor
   */
  function Model() {
    tr.model.EventContainer.call(this);
    tr.b.EventTarget.decorate(this);

    this.timestampShiftToZeroAmount_ = 0;

    this.faviconHue = 'blue'; // Should be a key from favicons.html

    this.device = new Device(this);
    this.kernel = new Kernel(this);
    this.processes = {};
    this.metadata = [];
    this.categories = [];
    this.instantEvents = [];
    this.flowEvents = [];
    this.clockSyncRecords = [];
    this.intrinsicTimeUnit_ = undefined;

    this.stackFrames = {};
    this.samples = [];

    this.alerts = [];
    this.interactionRecords = [];

    this.flowIntervalTree = new tr.b.IntervalTree(
        function(f) { return f.start; },
        function(f) { return f.end; });

    this.globalMemoryDumps = [];

    this.annotationsByGuid_ = {};
    this.modelIndices = undefined;

    this.importWarnings_ = [];
    this.reportedImportWarnings_ = {};
  }

  Model.prototype = {
    __proto__: tr.model.EventContainer.prototype,

    iterateAllEventsInThisContainer: function(eventTypePredicate,
                                              callback, opt_this) {
      if (eventTypePredicate.call(opt_this, GlobalMemoryDump))
        this.globalMemoryDumps.forEach(callback, opt_this);

      if (eventTypePredicate.call(opt_this, GlobalInstantEvent))
        this.instantEvents.forEach(callback, opt_this);

      if (eventTypePredicate.call(opt_this, FlowEvent))
        this.flowEvents.forEach(callback, opt_this);

      if (eventTypePredicate.call(opt_this, Alert))
        this.alerts.forEach(callback, opt_this);

      if (eventTypePredicate.call(opt_this, InteractionRecord))
        this.interactionRecords.forEach(callback, opt_this);

      if (eventTypePredicate.call(opt_this, Sample))
        this.samples.forEach(callback, opt_this);
    },

    iterateAllChildEventContainers: function(callback, opt_this) {
      callback.call(opt_this, this.device);
      callback.call(opt_this, this.kernel);
      for (var pid in this.processes)
        callback.call(opt_this, this.processes[pid]);
    },

    /**
     * Some objects in the model can persist their state in ModelSettings.
     *
     * This iterates through them.
     */
    iterateAllPersistableObjects: function(callback) {
      this.kernel.iterateAllPersistableObjects(callback);
      for (var pid in this.processes)
        this.processes[pid].iterateAllPersistableObjects(callback);
    },

    updateBounds: function() {
      this.bounds.reset();
      var bounds = this.bounds;

      this.iterateAllChildEventContainers(function(ec) {
        ec.updateBounds();
        bounds.addRange(ec.bounds);
      });
      this.iterateAllEventsInThisContainer(
          function(eventConstructor) { return true; },
          function(event) {
            event.addBoundsToRange(bounds);
          });
    },

    shiftWorldToZero: function() {
      var shiftAmount = -this.bounds.min;
      this.timestampShiftToZeroAmount_ = shiftAmount;
      this.iterateAllChildEventContainers(function(ec) {
        ec.shiftTimestampsForward(shiftAmount);
      });
      this.iterateAllEventsInThisContainer(
        function(eventConstructor) { return true; },
        function(event) {
          event.start += shiftAmount;
        });
      this.updateBounds();
    },

    convertTimestampToModelTime: function(sourceClockDomainName, ts) {
      if (sourceClockDomainName !== 'traceEventClock')
        throw new Error('Only traceEventClock is supported.');
      return tr.b.u.Units.timestampFromUs(ts) +
        this.timestampShiftToZeroAmount_;
    },

    get numProcesses() {
      var n = 0;
      for (var p in this.processes)
        n++;
      return n;
    },

    /**
     * @return {Process} Gets a TimelineProcess for a specified pid. Returns
     * undefined if the process doesn't exist.
     */
    getProcess: function(pid) {
      return this.processes[pid];
    },

    /**
     * @return {Process} Gets a TimelineProcess for a specified pid or
     * creates one if it does not exist.
     */
    getOrCreateProcess: function(pid) {
      if (!this.processes[pid])
        this.processes[pid] = new Process(this, pid);
      return this.processes[pid];
    },

    pushInstantEvent: function(instantEvent) {
      this.instantEvents.push(instantEvent);
    },

    addStackFrame: function(stackFrame) {
      if (this.stackFrames[stackFrame.id])
        throw new Error('Stack frame already exists');
      this.stackFrames[stackFrame.id] = stackFrame;
      return stackFrame;
    },

    addInteractionRecord: function(ir) {
      this.interactionRecords.push(ir);
      return ir;
    },

    getClockSyncRecordsNamed: function(name) {
      return this.clockSyncRecords.filter(function(x) {
        return x.name === name;
      });
    },

    /**
     * Generates the set of categories from the slices and counters.
     */
    updateCategories_: function() {
      var categoriesDict = {};
      this.device.addCategoriesToDict(categoriesDict);
      this.kernel.addCategoriesToDict(categoriesDict);
      for (var pid in this.processes)
        this.processes[pid].addCategoriesToDict(categoriesDict);

      this.categories = [];
      for (var category in categoriesDict)
        if (category != '')
          this.categories.push(category);
    },

    getAllThreads: function() {
      var threads = [];
      for (var tid in this.kernel.threads) {
        threads.push(process.threads[tid]);
      }
      for (var pid in this.processes) {
        var process = this.processes[pid];
        for (var tid in process.threads) {
          threads.push(process.threads[tid]);
        }
      }
      return threads;
    },

    /**
     * @return {Array} An array of all processes in the model.
     */
    getAllProcesses: function() {
      var processes = [];
      for (var pid in this.processes)
        processes.push(this.processes[pid]);
      return processes;
    },

    /**
     * @return {Array} An array of all the counters in the model.
     */
    getAllCounters: function() {
      var counters = [];
      counters.push.apply(
          counters, tr.b.dictionaryValues(this.device.counters));
      counters.push.apply(
          counters, tr.b.dictionaryValues(this.kernel.counters));
      for (var pid in this.processes) {
        var process = this.processes[pid];
        for (var tid in process.counters) {
          counters.push(process.counters[tid]);
        }
      }
      return counters;
    },

    getAnnotationByGUID: function(guid) {
      return this.annotationsByGuid_[guid];
    },

    addAnnotation: function(annotation) {
      if (!annotation.guid)
        throw new Error('Annotation with undefined guid given');

      this.annotationsByGuid_[annotation.guid] = annotation;
      tr.b.dispatchSimpleEvent(this, 'annotationChange');
    },

    removeAnnotation: function(annotation) {
      this.annotationsByGuid_[annotation.guid].onRemove();
      delete this.annotationsByGuid_[annotation.guid];
      tr.b.dispatchSimpleEvent(this, 'annotationChange');
    },

    getAllAnnotations: function() {
      return tr.b.dictionaryValues(this.annotationsByGuid_);
    },

    /**
     * @param {String} The name of the thread to find.
     * @return {Array} An array of all the matched threads.
     */
    findAllThreadsNamed: function(name) {
      var namedThreads = [];
      namedThreads.push.apply(
          namedThreads,
          this.kernel.findAllThreadsNamed(name));
      for (var pid in this.processes) {
        namedThreads.push.apply(
            namedThreads,
            this.processes[pid].findAllThreadsNamed(name));
      }
      return namedThreads;
    },

    set importOptions(options) {
      this.importOptions_ = options;
    },

    /**
     * Returns a time unit that is used to format values and determines the
     * precision of the timestamp values.
     */
    get intrinsicTimeUnit() {
      if (this.intrinsicTimeUnit_ === undefined)
        return tr.b.u.TimeDisplayModes.ms;
      return this.intrinsicTimeUnit_;
    },

    set intrinsicTimeUnit(value) {
      if (this.intrinsicTimeUnit_ === value)
        return;
      if (this.intrinsicTimeUnit_ !== undefined)
        throw new Error('Intrinsic time unit already set');
      this.intrinsicTimeUnit_ = value;
    },

    /**
     * @param {Object} data The import warning data. Data must provide two
     *    accessors: type, message. The types are used to determine if we
     *    should output the message, we'll only output one message of each type.
     *    The message is the actual warning content.
     */
    importWarning: function(data) {
      this.importWarnings_.push(data);

      // Only log each warning type once. We may want to add some kind of
      // flag to allow reporting all importer warnings.
      if (this.reportedImportWarnings_[data.type] === true)
        return;

      if (this.importOptions_.showImportWarnings)
        console.warn(data.message);

      this.reportedImportWarnings_[data.type] = true;
    },

    get hasImportWarnings() {
      return (this.importWarnings_.length > 0);
    },

    get importWarnings() {
      return this.importWarnings_;
    },

    autoCloseOpenSlices: function() {
      // Sort the samples.
      this.samples.sort(function(x, y) {
        return x.start - y.start;
      });

      this.updateBounds();
      this.kernel.autoCloseOpenSlices(this.bounds.max);
      for (var pid in this.processes)
        this.processes[pid].autoCloseOpenSlices(this.bounds.max);
    },

    createSubSlices: function() {
      this.kernel.createSubSlices();
      for (var pid in this.processes)
        this.processes[pid].createSubSlices();
    },

    preInitializeObjects: function() {
      for (var pid in this.processes)
        this.processes[pid].preInitializeObjects();
    },

    initializeObjects: function() {
      for (var pid in this.processes)
        this.processes[pid].initializeObjects();
    },

    pruneEmptyContainers: function() {
      this.kernel.pruneEmptyContainers();
      for (var pid in this.processes)
        this.processes[pid].pruneEmptyContainers();
    },

    mergeKernelWithUserland: function() {
      for (var pid in this.processes)
        this.processes[pid].mergeKernelWithUserland();
    },

    computeWorldBounds: function(shiftWorldToZero) {
      this.updateBounds();
      this.updateCategories_();

      if (shiftWorldToZero)
        this.shiftWorldToZero();
    },

    buildFlowEventIntervalTree: function() {
      for (var i = 0; i < this.flowEvents.length; ++i) {
        var flowEvent = this.flowEvents[i];
        this.flowIntervalTree.insert(flowEvent);
      }
      this.flowIntervalTree.updateHighValues();
    },

    cleanupUndeletedObjects: function() {
      for (var pid in this.processes)
        this.processes[pid].autoDeleteObjects(this.bounds.max);
    },

    sortMemoryDumps: function() {
      this.globalMemoryDumps.sort(function(x, y) {
        return x.start - y.start;
      });

      for (var pid in this.processes)
        this.processes[pid].sortMemoryDumps();
    },

    calculateMemoryGraphAttributes: function() {
      this.globalMemoryDumps.forEach(function(dump) {
        dump.calculateGraphAttributes();
      });
    },

    buildEventIndices: function() {
      this.modelIndices = new tr.model.ModelIndices(this);
    },

    sortInteractionRecords: function() {
      this.interactionRecords.sort(function(x, y) {
        return x.start - y.start;
      });
    },

    sortAlerts: function() {
      this.alerts.sort(function(x, y) {
        return x.start - y.start;
      });
    }
  };

  return {
    ClockSyncRecord: ClockSyncRecord,
    Model: Model
  };
});
