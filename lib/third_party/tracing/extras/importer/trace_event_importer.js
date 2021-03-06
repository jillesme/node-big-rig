/**
Copyright (c) 2012 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("../../base/quad.js");
require("../../base/range.js");
require("../../base/units/units.js");
require("../../base/utils.js");
require("./trace_code_entry.js");
require("./trace_code_map.js");
require("./v8/codemap.js");
require("../../importer/importer.js");
require("../../model/attribute.js");
require("../../model/comment_box_annotation.js");
require("../../model/counter_series.js");
require("../../model/flow_event.js");
require("../../model/global_memory_dump.js");
require("../../model/heap_dump.js");
require("../../model/instant_event.js");
require("../../model/memory_allocator_dump.js");
require("../../model/model.js");
require("../../model/process_memory_dump.js");
require("../../model/rect_annotation.js");
require("../../model/slice_group.js");
require("../../model/x_marker_annotation.js");
require("../../ui/base/color_scheme.js");

'use strict';

/**
 * @fileoverview TraceEventImporter imports TraceEvent-formatted data
 * into the provided model.
 */
global.tr.exportTo('tr.e.importer', function() {
  var deepCopy = tr.b.deepCopy;

  function getEventColor(event, opt_customName) {
    if (event.cname)
      return tr.ui.b.getColorIdForReservedName(event.cname);
    else if (opt_customName || event.name) {
      return tr.ui.b.getColorIdForGeneralPurposeString(
          opt_customName || event.name);
    }
  }

  var timestampFromUs = tr.b.u.Units.timestampFromUs;
  var maybeTimestampFromUs = tr.b.u.Units.maybeTimestampFromUs;

  var PRODUCER = 'producer';
  var CONSUMER = 'consumer';
  var STEP = 'step';

  function TraceEventImporter(model, eventData) {
    this.importPriority = 1;
    this.model_ = model;
    this.events_ = undefined;
    this.sampleEvents_ = undefined;
    this.stackFrameEvents_ = undefined;
    this.systemTraceEvents_ = undefined;
    this.battorData_ = undefined;
    this.eventsWereFromString_ = false;
    this.softwareMeasuredCpuCount_ = undefined;

    this.allAsyncEvents_ = [];
    this.allFlowEvents_ = [];
    this.allObjectEvents_ = [];

    this.traceEventSampleStackFramesByName_ = {};

    this.v8ProcessCodeMaps_ = {};
    this.v8ProcessRootStackFrame_ = {};

    // Dump ID -> {global: (event | undefined), process: [events]}
    this.allMemoryDumpEvents_ = {};

    if (typeof(eventData) === 'string' || eventData instanceof String) {
      eventData = eventData.trim();
      // If the event data begins with a [, then we know it should end with a ].
      // The reason we check for this is because some tracing implementations
      // cannot guarantee that a ']' gets written to the trace file. So, we are
      // forgiving and if this is obviously the case, we fix it up before
      // throwing the string at JSON.parse.
      if (eventData[0] === '[') {
        eventData = eventData.replace(/\s*,\s*$/, '');
        if (eventData[eventData.length - 1] !== ']')
          eventData = eventData + ']';
      }

      this.events_ = JSON.parse(eventData);
      this.eventsWereFromString_ = true;
    } else {
      this.events_ = eventData;
    }

    this.traceAnnotations_ = this.events_.traceAnnotations;

    // Some trace_event implementations put the actual trace events
    // inside a container. E.g { ... , traceEvents: [ ] }
    // If we see that, just pull out the trace events.
    if (this.events_.traceEvents) {
      var container = this.events_;
      this.events_ = this.events_.traceEvents;

      // Some trace_event implementations put ftrace_importer traces as a
      // huge string inside container.systemTraceEvents. If we see that, pull it
      // out. It will be picked up by extractSubtraces later on.
      this.systemTraceEvents_ = container.systemTraceEvents;

      // Some trace_event implementations put battor power traces as a
      // huge string inside container.battorLogAsString. If we see that, pull
      // it out. It will be picked up by extractSubtraces later on.
      this.battorData_ = container.battorLogAsString;

      // Sampling data.
      this.sampleEvents_ = container.samples;
      this.stackFrameEvents_ = container.stackFrames;

      // Some implementations specify displayTimeUnit
      if (container.displayTimeUnit) {
        var unitName = container.displayTimeUnit;
        var unit = tr.b.u.TimeDisplayModes[unitName];
        if (unit === undefined) {
          throw new Error('Unit ' + unitName + ' is not supported.');
        }
        this.model_.intrinsicTimeUnit = unit;
      }

      var knownFieldNames = {
        battorLogAsString: true,
        samples: true,
        stackFrames: true,
        systemTraceEvents: true,
        traceAnnotations: true,
        traceEvents: true
      };
      // Any other fields in the container should be treated as metadata.
      for (var fieldName in container) {
        if (fieldName in knownFieldNames)
          continue;
        this.model_.metadata.push({name: fieldName,
          value: container[fieldName]});
      }
    }
  }

  /**
   * @return {boolean} Whether obj is a TraceEvent array.
   */
  TraceEventImporter.canImport = function(eventData) {
    // May be encoded JSON. But we dont want to parse it fully yet.
    // Use a simple heuristic:
    //   - eventData that starts with [ are probably trace_event
    //   - eventData that starts with { are probably trace_event
    // May be encoded JSON. Treat files that start with { as importable by us.
    if (typeof(eventData) === 'string' || eventData instanceof String) {
      eventData = eventData.trim();
      return eventData[0] === '{' || eventData[0] === '[';
    }

    // Might just be an array of events
    if (eventData instanceof Array && eventData.length && eventData[0].ph)
      return true;

    // Might be an object with a traceEvents field in it.
    if (eventData.traceEvents) {
      if (eventData.traceEvents instanceof Array) {
        if (eventData.traceEvents.length && eventData.traceEvents[0].ph)
          return true;
        if (eventData.samples.length && eventData.stackFrames !== undefined)
          return true;
      }
    }

    return false;
  };

  TraceEventImporter.prototype = {
    __proto__: tr.importer.Importer.prototype,

    extractSubtraces: function() {
      var systemEventsTmp = this.systemTraceEvents_;
      var battorDataTmp = this.battorData_;
      this.systemTraceEvents_ = undefined;
      this.battorData_ = undefined;
      var subTraces = systemEventsTmp ? [systemEventsTmp] : [];
      if (battorDataTmp)
        subTraces.push(battorDataTmp);
       return subTraces;
    },

    /**
     * Deep copying is only needed if the trace was given to us as events.
     */
    deepCopyIfNeeded_: function(obj) {
      if (obj === undefined)
        obj = {};
      if (this.eventsWereFromString_)
        return obj;
      return deepCopy(obj);
    },

    /**
     * Always perform deep copying.
     */
    deepCopyAlways_: function(obj) {
      if (obj === undefined)
        obj = {};
      return deepCopy(obj);
    },

    /**
     * Helper to process an async event.
     */
    processAsyncEvent: function(event) {
      var thread = this.model_.getOrCreateProcess(event.pid).
          getOrCreateThread(event.tid);
      this.allAsyncEvents_.push({
        sequenceNumber: this.allAsyncEvents_.length,
        event: event,
        thread: thread
      });
    },

    /**
     * Helper to process a flow event.
     */
    processFlowEvent: function(event, opt_slice) {
      var thread = this.model_.getOrCreateProcess(event.pid).
          getOrCreateThread(event.tid);
      this.allFlowEvents_.push({
        refGuid: tr.b.GUID.getLastGuid(),
        sequenceNumber: this.allFlowEvents_.length,
        event: event,
        slice: opt_slice,  // slice for events that have flow info
        thread: thread
      });
    },

    /**
     * Helper that creates and adds samples to a Counter object based on
     * 'C' phase events.
     */
    processCounterEvent: function(event) {
      var ctr_name;
      if (event.id !== undefined)
        ctr_name = event.name + '[' + event.id + ']';
      else
        ctr_name = event.name;

      var ctr = this.model_.getOrCreateProcess(event.pid)
          .getOrCreateCounter(event.cat, ctr_name);
      var reservedColorId = event.cname ? getEventColor(event) : undefined;

      // Initialize the counter's series fields if needed.
      if (ctr.numSeries === 0) {
        for (var seriesName in event.args) {
          var colorId = reservedColorId ||
              getEventColor(event, ctr.name + '.' + seriesName);
          ctr.addSeries(new tr.model.CounterSeries(seriesName, colorId));
        }

        if (ctr.numSeries === 0) {
          this.model_.importWarning({
            type: 'counter_parse_error',
            message: 'Expected counter ' + event.name +
                ' to have at least one argument to use as a value.'
          });

          // Drop the counter.
          delete ctr.parent.counters[ctr.name];
          return;
        }
      }

      var ts = timestampFromUs(event.ts);
      ctr.series.forEach(function(series) {
        var val = event.args[series.name] ? event.args[series.name] : 0;
        series.addCounterSample(ts, val);
      });
    },

    processObjectEvent: function(event) {
      var thread = this.model_.getOrCreateProcess(event.pid).
          getOrCreateThread(event.tid);
      this.allObjectEvents_.push({
        sequenceNumber: this.allObjectEvents_.length,
        event: event,
        thread: thread});
    },

    processDurationEvent: function(event) {
      var thread = this.model_.getOrCreateProcess(event.pid)
        .getOrCreateThread(event.tid);
      var ts = timestampFromUs(event.ts);
      if (!thread.sliceGroup.isTimestampValidForBeginOrEnd(ts)) {
        this.model_.importWarning({
          type: 'duration_parse_error',
          message: 'Timestamps are moving backward.'
        });
        return;
      }

      if (event.ph === 'B') {
        var slice = thread.sliceGroup.beginSlice(
            event.cat, event.name, timestampFromUs(event.ts),
            this.deepCopyIfNeeded_(event.args),
            timestampFromUs(event.tts), event.argsStripped,
            getEventColor(event));
        slice.startStackFrame = this.getStackFrameForEvent_(event);
      } else if (event.ph === 'I' || event.ph === 'i' || event.ph === 'R') {
        if (event.s !== undefined && event.s !== 't')
          throw new Error('This should never happen');

        thread.sliceGroup.beginSlice(event.cat, event.name,
                                     timestampFromUs(event.ts),
                                     this.deepCopyIfNeeded_(event.args),
                                     timestampFromUs(event.tts),
                                     event.argsStripped,
                                     getEventColor(event));
        var slice = thread.sliceGroup.endSlice(timestampFromUs(event.ts),
                                   timestampFromUs(event.tts));
        slice.startStackFrame = this.getStackFrameForEvent_(event);
        slice.endStackFrame = undefined;
      } else {
        if (!thread.sliceGroup.openSliceCount) {
          this.model_.importWarning({
            type: 'duration_parse_error',
            message: 'E phase event without a matching B phase event.'
          });
          return;
        }

        var slice = thread.sliceGroup.endSlice(timestampFromUs(event.ts),
                                               timestampFromUs(event.tts),
                                               getEventColor(event));
        if (event.name && slice.title != event.name) {
          this.model_.importWarning({
            type: 'title_match_error',
            message: 'Titles do not match. Title is ' +
                slice.title + ' in openSlice, and is ' +
                event.name + ' in endSlice'
          });
        }
        slice.endStackFrame = this.getStackFrameForEvent_(event);

        this.mergeArgsInto_(slice.args, event.args, slice.title);
      }
    },

    mergeArgsInto_: function(dstArgs, srcArgs, eventName) {
      for (var arg in srcArgs) {
        if (dstArgs[arg] !== undefined) {
          this.model_.importWarning({
            type: 'arg_merge_error',
            message: 'Different phases of ' + eventName +
                ' provided values for argument ' + arg + '.' +
                ' The last provided value will be used.'
          });
        }
        dstArgs[arg] = this.deepCopyIfNeeded_(srcArgs[arg]);
      }
    },

    processCompleteEvent: function(event) {
      // Preventing the overhead slices from making it into the model. This
      // only applies to legacy traces, as the overhead traces have been
      // removed from the chromium code.
      if (event.cat !== undefined &&
          event.cat.indexOf('trace_event_overhead') > -1)
        return undefined;

      var thread = this.model_.getOrCreateProcess(event.pid)
          .getOrCreateThread(event.tid);

      if (event.flow_out) {
        if (event.flow_in)
          event.flowPhase = STEP;
        else
          event.flowPhase = PRODUCER;
      } else if (event.flow_in) {
        event.flowPhase = CONSUMER;
      }

      var slice = thread.sliceGroup.pushCompleteSlice(event.cat, event.name,
          timestampFromUs(event.ts),
          maybeTimestampFromUs(event.dur),
          maybeTimestampFromUs(event.tts),
          maybeTimestampFromUs(event.tdur),
          this.deepCopyIfNeeded_(event.args),
          event.argsStripped,
          getEventColor(event),
          event.bind_id);
      slice.startStackFrame = this.getStackFrameForEvent_(event);
      slice.endStackFrame = this.getStackFrameForEvent_(event, true);

      return slice;
    },

    processMetadataEvent: function(event) {
      // The metadata events aren't useful without args.
      if (event.argsStripped)
        return;

      if (event.name === 'process_name') {
        var process = this.model_.getOrCreateProcess(event.pid);
        process.name = event.args.name;
      } else if (event.name === 'process_labels') {
        var process = this.model_.getOrCreateProcess(event.pid);
        var labels = event.args.labels.split(',');
        for (var i = 0; i < labels.length; i++)
          process.addLabelIfNeeded(labels[i]);
      } else if (event.name === 'process_sort_index') {
        var process = this.model_.getOrCreateProcess(event.pid);
        process.sortIndex = event.args.sort_index;
      } else if (event.name === 'thread_name') {
        var thread = this.model_.getOrCreateProcess(event.pid).
            getOrCreateThread(event.tid);
        thread.name = event.args.name;
      } else if (event.name === 'thread_sort_index') {
        var thread = this.model_.getOrCreateProcess(event.pid).
            getOrCreateThread(event.tid);
        thread.sortIndex = event.args.sort_index;
      } else if (event.name === 'num_cpus') {
        var n = event.args.number;
        // Not all render processes agree on the cpu count in trace_event. Some
        // processes will report 1, while others will report the actual cpu
        // count. To deal with this, take the max of what is reported.
        if (this.softwareMeasuredCpuCount_ !== undefined)
          n = Math.max(n, this.softwareMeasuredCpuCount_);
        this.softwareMeasuredCpuCount_ = n;
      } else if (event.name === 'stackFrames') {
        var stackFrames = event.args.stackFrames;
        if (stackFrames === undefined) {
          this.model_.importWarning({
            type: 'metadata_parse_error',
            message: 'No stack frames found in a \'' + event.name +
                '\' metadata event'
          });
        } else {
          this.importStackFrames_(
              stackFrames, 'p' + event.pid + ':', true /* addRootFrame */);
        }
      } else {
        this.model_.importWarning({
          type: 'metadata_parse_error',
          message: 'Unrecognized metadata name: ' + event.name
        });
      }
    },

    processJitCodeEvent: function(event) {
      if (this.v8ProcessCodeMaps_[event.pid] === undefined)
        this.v8ProcessCodeMaps_[event.pid] = new tr.e.importer.TraceCodeMap();
      var map = this.v8ProcessCodeMaps_[event.pid];

      var data = event.args.data;
      if (event.name === 'JitCodeMoved')
        map.moveEntry(data.code_start, data.new_code_start, data.code_len);
      else
        map.addEntry(data.code_start, data.code_len, data.name, data.script_id);
    },

    processInstantEvent: function(event) {
      // V8 JIT events are logged as phase 'I' so we need to separate them out
      // and handle specially.
      //
      // TODO(dsinclair): There are _a lot_ of JitCode events so I'm skipping
      // the display for now. Can revisit later if we want to show them.
      if (event.name === 'JitCodeAdded' || event.name === 'JitCodeMoved') {
        this.processJitCodeEvent(event);
        return;
      }

      // Thread-level instant events are treated as zero-duration slices.
      if (event.s === 't' || event.s === undefined) {
        this.processDurationEvent(event);
        return;
      }

      var constructor;
      switch (event.s) {
        case 'g':
          constructor = tr.model.GlobalInstantEvent;
          break;
        case 'p':
          constructor = tr.model.ProcessInstantEvent;
          break;
        default:
          this.model_.importWarning({
            type: 'instant_parse_error',
            message: 'I phase event with unknown "s" field value.'
          });
          return;
      }

      var instantEvent = new constructor(event.cat, event.name,
          getEventColor(event), timestampFromUs(event.ts),
          this.deepCopyIfNeeded_(event.args));

      switch (instantEvent.type) {
        case tr.model.InstantEventType.GLOBAL:
          this.model_.pushInstantEvent(instantEvent);
          break;

        case tr.model.InstantEventType.PROCESS:
          var process = this.model_.getOrCreateProcess(event.pid);
          process.pushInstantEvent(instantEvent);
          break;

        default:
          throw new Error('Unknown instant event type: ' + event.s);
      }
    },

    processV8Sample: function(event) {
      var data = event.args.data;

      // As-per DevTools, the backend sometimes creates bogus samples. Skip it.
      if (data.vm_state === 'js' && !data.stack.length)
        return;

      var rootStackFrame = this.v8ProcessRootStackFrame_[event.pid];
      if (!rootStackFrame) {
        rootStackFrame = new tr.model.StackFrame(
            undefined /* parent */, 'v8-root-stack-frame' /* id */,
            'v8-root-stack-frame' /* title */, 0 /* colorId */);
        this.v8ProcessRootStackFrame_[event.pid] = rootStackFrame;
      }

      function findChildWithEntryID(stackFrame, entryID) {
        return tr.b.findFirstInArray(stackFrame.children, function(child) {
          return child.entryID === entryID;
        });
      }

      var model = this.model_;
      function addStackFrame(lastStackFrame, entry) {
        var childFrame = findChildWithEntryID(lastStackFrame, entry.id);
        if (childFrame)
          return childFrame;

        var frame = new tr.model.StackFrame(
            lastStackFrame, tr.b.GUID.allocate(), entry.name,
            tr.ui.b.getColorIdForGeneralPurposeString(entry.name),
            entry.sourceInfo);

        frame.entryID = entry.id;
        model.addStackFrame(frame);
        return frame;
      }

      var lastStackFrame = rootStackFrame;

      // There are several types of v8 sample events, gc, native, compiler, etc.
      // Some of these types have stacks and some don't, we handle those two
      // cases differently. For types that don't have any stack frames attached
      // we synthesize one based on the type of thing that's happening so when
      // we view all the samples we'll see something like 'external' or 'gc'
      // as a fraction of the time spent.
      if (data.stack.length > 0 && this.v8ProcessCodeMaps_[event.pid]) {
        var map = this.v8ProcessCodeMaps_[event.pid];

        // Stacks have the leaf node first, flip them around so the root
        // comes first.
        data.stack.reverse();

        for (var i = 0; i < data.stack.length; i++) {
          var entry = map.lookupEntry(data.stack[i]);
          if (entry === undefined) {
            entry = {
              id: 'unknown',
              name: 'unknown',
              sourceInfo: undefined
            };
          }

          lastStackFrame = addStackFrame(lastStackFrame, entry);
        }
      } else {
        var entry = {
          id: data.vm_state,
          name: data.vm_state,
          sourceInfo: undefined
        };
        lastStackFrame = addStackFrame(lastStackFrame, entry);
      }

      var thread = this.model_.getOrCreateProcess(event.pid)
        .getOrCreateThread(event.tid);

      var sample = new tr.model.Sample(
          undefined /* cpu */, thread, 'V8 Sample',
          timestampFromUs(event.ts), lastStackFrame, 1 /* weight */,
          this.deepCopyIfNeeded_(event.args));
      this.model_.samples.push(sample);
    },

    processTraceSampleEvent: function(event) {
      if (event.name === 'V8Sample') {
        this.processV8Sample(event);
        return;
      }

      var stackFrame = this.getStackFrameForEvent_(event);
      if (stackFrame === undefined) {
        stackFrame = this.traceEventSampleStackFramesByName_[
            event.name];
      }
      if (stackFrame === undefined) {
        var id = 'te-' + tr.b.GUID.allocate();
        stackFrame = new tr.model.StackFrame(
            undefined, id, event.name,
            tr.ui.b.getColorIdForGeneralPurposeString(event.name));
        this.model_.addStackFrame(stackFrame);
        this.traceEventSampleStackFramesByName_[event.name] = stackFrame;
      }

      var thread = this.model_.getOrCreateProcess(event.pid)
        .getOrCreateThread(event.tid);

      var sample = new tr.model.Sample(
          undefined, thread, 'Trace Event Sample',
          timestampFromUs(event.ts), stackFrame, 1,
          this.deepCopyIfNeeded_(event.args));
      this.model_.samples.push(sample);
    },

    getOrCreateMemoryDumpEvents_: function(dumpId) {
      if (this.allMemoryDumpEvents_[dumpId] === undefined) {
        this.allMemoryDumpEvents_[dumpId] = {
          global: undefined,
          process: []
        };
      }
      return this.allMemoryDumpEvents_[dumpId];
    },

    processMemoryDumpEvent: function(event) {
      if (event.id === undefined) {
        this.model_.importWarning({
          type: 'memory_dump_parse_error',
          message: event.ph + ' phase event without a dump ID.'
        });
        return;
      }
      var events = this.getOrCreateMemoryDumpEvents_(event.id);

      if (event.ph === 'v') {
        // Add a process memory dump.
        events.process.push(event);
      } else if (event.ph === 'V') {
        // Add a global memory dump (unless already present).
        if (events.global !== undefined) {
          this.model_.importWarning({
            type: 'memory_dump_parse_error',
            message: 'Multiple V phase events with the same dump ID.'
          });
          return;
        }
        events.global = event;
      } else {
        throw new Error('Invalid memory dump event phase "' + event.ph + '".');
      }
    },

    /**
     * Walks through the events_ list and outputs the structures discovered to
     * model_.
     */
    importEvents: function() {
      var csr = new tr.ClockSyncRecord('ftrace_importer', 0, {});
      this.model_.clockSyncRecords.push(csr);
      if (this.stackFrameEvents_) {
        this.importStackFrames_(
            this.stackFrameEvents_, 'g', false /* addRootFrame */);
      }

      if (this.traceAnnotations_)
        this.importAnnotations_();

      var events = this.events_;
      for (var eI = 0; eI < events.length; eI++) {
        var event = events[eI];
        if (event.args === '__stripped__') {
          event.argsStripped = true;
          event.args = undefined;
        }

        if (event.ph === 'B' || event.ph === 'E') {
          this.processDurationEvent(event);

        } else if (event.ph === 'X') {
          var slice = this.processCompleteEvent(event);
          // TODO(yuhaoz): If Chrome supports creating other events with flow,
          // we will need to call processFlowEvent for them also.
          // https://github.com/catapult-project/catapult/issues/1259
          if (slice !== undefined && event.bind_id !== undefined)
            this.processFlowEvent(event, slice);

        } else if (event.ph === 'b' || event.ph === 'e' || event.ph === 'n' ||
                   event.ph === 'S' || event.ph === 'F' || event.ph === 'T' ||
                   event.ph === 'p') {
          this.processAsyncEvent(event);

        // Note, I is historic. The instant event marker got changed, but we
        // want to support loading old trace files so we have both I and i.
        } else if (event.ph === 'I' || event.ph === 'i' || event.ph === 'R') {
          this.processInstantEvent(event);

        } else if (event.ph === 'P') {
          this.processTraceSampleEvent(event);

        } else if (event.ph === 'C') {
          this.processCounterEvent(event);

        } else if (event.ph === 'M') {
          this.processMetadataEvent(event);

        } else if (event.ph === 'N' || event.ph === 'D' || event.ph === 'O') {
          this.processObjectEvent(event);

        } else if (event.ph === 's' || event.ph === 't' || event.ph === 'f') {
          this.processFlowEvent(event);

        } else if (event.ph === 'v' || event.ph === 'V') {
          this.processMemoryDumpEvent(event);

        } else {
          this.model_.importWarning({
            type: 'parse_error',
            message: 'Unrecognized event phase: ' +
                event.ph + ' (' + event.name + ')'
          });
        }
      }

      // Remove all the root stack frame children as they should
      // already be added.
      tr.b.iterItems(this.v8ProcessRootStackFrame_, function(name, frame) {
        frame.removeAllChildren();
      });
    },

    importStackFrames_: function(rawStackFrames, idPrefix, addRootFrame) {
      var model = this.model_;

      var rootStackFrame;
      if (addRootFrame) {
        // In certain cases (heap dumps), we need to be able to distinguish
        // between an empty and an undefined stack trace. To this end, we add
        // an auxiliary root stack frame which is common to all stack frames
        // in a process. An empty stack trace is then represented by setting
        // the root stack frame as the leaf stack frame (of the relevant model
        // object with an associated empty stack trace, e.g. HeapEntry in the
        // case of heap dumps).
        rootStackFrame = new tr.model.StackFrame(
            undefined /* parentFrame */, idPrefix, undefined /* title */,
            undefined /* colorId */);
        model.addStackFrame(rootStackFrame);
      } else {
        rootStackFrame = undefined;
      }

      for (var id in rawStackFrames) {
        var rawStackFrame = rawStackFrames[id];
        var fullId = idPrefix + id;
        var textForColor = rawStackFrame.category ?
            rawStackFrame.category : rawStackFrame.name;
        var stackFrame = new tr.model.StackFrame(
            undefined /* parentFrame */, fullId, rawStackFrame.name,
            tr.ui.b.getColorIdForGeneralPurposeString(textForColor));
        model.addStackFrame(stackFrame);
      }

      for (var id in rawStackFrames) {
        var fullId = idPrefix + id;
        var stackFrame = model.stackFrames[fullId];
        if (stackFrame === undefined)
          throw new Error('Internal error');

        var rawStackFrame = rawStackFrames[id];
        var parentId = rawStackFrame.parent;
        var parentStackFrame;
        if (parentId === undefined) {
          parentStackFrame = rootStackFrame;
        } else {
          var parentFullId = idPrefix + parentId;
          parentStackFrame = model.stackFrames[parentFullId];
          if (parentStackFrame === undefined) {
            this.model_.importWarning({
              type: 'metadata_parse_error',
              message: 'Missing parent frame with ID ' + parentFullId +
                  ' for stack frame \'' + stackFrame.name + '\' (ID ' + fullId +
                  ').'
            });
            parentStackFrame = rootStackFrame;
          }
        }
        stackFrame.parentFrame = parentStackFrame;
      }
    },

    importAnnotations_: function() {
      for (var id in this.traceAnnotations_) {
        var annotation = tr.model.Annotation.fromDictIfPossible(
           this.traceAnnotations_[id]);
        if (!annotation) {
          this.model_.importWarning({
            type: 'annotation_warning',
            message: 'Unrecognized traceAnnotation typeName \"' +
                this.traceAnnotations_[id].typeName + '\"'
          });
          continue;
        }
        this.model_.addAnnotation(annotation);
      }
    },

    /**
     * Called by the Model after all other importers have imported their
     * events.
     */
    finalizeImport: function() {
      if (this.softwareMeasuredCpuCount_ !== undefined) {
        this.model_.kernel.softwareMeasuredCpuCount =
            this.softwareMeasuredCpuCount_;
      }
      this.createAsyncSlices_();
      this.createFlowSlices_();
      this.createExplicitObjects_();
      this.createImplicitObjects_();
      this.createMemoryDumps_();
    },

    /* Events can have one or more stack frames associated with them, but
     * that frame might be encoded either as a stack trace of program counters,
     * or as a direct stack frame reference. This handles either case and
     * if found, returns the stackframe.
     */
    getStackFrameForEvent_: function(event, opt_lookForEndEvent) {
      var sf;
      var stack;
      if (opt_lookForEndEvent) {
        sf = event.esf;
        stack = event.estack;
      } else {
        sf = event.sf;
        stack = event.stack;
      }
      if (stack !== undefined && sf !== undefined) {
        this.model_.importWarning({
          type: 'stack_frame_and_stack_error',
          message: 'Event at ' + event.ts +
              ' cannot have both a stack and a stackframe.'
        });
        return undefined;
      }

      if (stack !== undefined)
        return this.model_.resolveStackToStackFrame_(event.pid, stack);
      if (sf === undefined)
        return undefined;

      var stackFrame = this.model_.stackFrames['g' + sf];
      if (stackFrame === undefined) {
        this.model_.importWarning({
          type: 'sample_import_error',
          message: 'No frame for ' + sf
        });
        return;
      }
      return stackFrame;
    },

    resolveStackToStackFrame_: function(pid, stack) {
      // TODO(alph,fmeawad): Add codemap resolution code here.
      return undefined;
    },

    importSampleData: function() {
      if (!this.sampleEvents_)
        return;
      var m = this.model_;

      // If this is the only importer, then fake-create the threads.
      var events = this.sampleEvents_;
      if (this.events_.length === 0) {
        for (var i = 0; i < events.length; i++) {
          var event = events[i];
          m.getOrCreateProcess(event.tid).getOrCreateThread(event.tid);
        }
      }

      var threadsByTid = {};
      m.getAllThreads().forEach(function(t) {
        threadsByTid[t.tid] = t;
      });

      for (var i = 0; i < events.length; i++) {
        var event = events[i];
        var thread = threadsByTid[event.tid];
        if (thread === undefined) {
          m.importWarning({
            type: 'sample_import_error',
            message: 'Thread ' + events.tid + 'not found'
          });
          continue;
        }

        var cpu;
        if (event.cpu !== undefined)
          cpu = m.kernel.getOrCreateCpu(event.cpu);

        var stackFrame = this.getStackFrameForEvent_(event);

        var sample = new tr.model.Sample(
            cpu, thread,
            event.name,
            timestampFromUs(event.ts),
            stackFrame,
            event.weight);
        m.samples.push(sample);
      }
    },

    /**
     * Called by the model to join references between objects, after final model
     * bounds have been computed.
     */
    joinRefs: function() {
      this.joinObjectRefs_();
    },

    createAsyncSlices_: function() {
      if (this.allAsyncEvents_.length === 0)
        return;

      this.allAsyncEvents_.sort(function(x, y) {
        var d = x.event.ts - y.event.ts;
        if (d !== 0)
          return d;
        return x.sequenceNumber - y.sequenceNumber;
      });

      var legacyEvents = [];
      // Group nestable async events by ID. Events with the same ID should
      // belong to the same parent async event.
      var nestableAsyncEventsByKey = {};
      for (var i = 0; i < this.allAsyncEvents_.length; i++) {
        var asyncEventState = this.allAsyncEvents_[i];
        var event = asyncEventState.event;
        if (event.ph === 'S' || event.ph === 'F' || event.ph === 'T' ||
            event.ph === 'p') {
          legacyEvents.push(asyncEventState);
          continue;
        }
        if (event.cat === undefined) {
          this.model_.importWarning({
            type: 'async_slice_parse_error',
            message: 'Nestable async events (ph: b, e, or n) require a ' +
                'cat parameter.'
          });
          continue;
        }

        if (event.name === undefined) {
          this.model_.importWarning({
            type: 'async_slice_parse_error',
            message: 'Nestable async events (ph: b, e, or n) require a ' +
                'name parameter.'
          });
          continue;
        }

        if (event.id === undefined) {
          this.model_.importWarning({
            type: 'async_slice_parse_error',
            message: 'Nestable async events (ph: b, e, or n) require an ' +
                'id parameter.'
          });
          continue;
        }
        var key = event.cat + ':' + event.id;
        if (nestableAsyncEventsByKey[key] === undefined)
           nestableAsyncEventsByKey[key] = [];
        nestableAsyncEventsByKey[key].push(asyncEventState);
      }
      // Handle legacy async events.
      this.createLegacyAsyncSlices_(legacyEvents);

      // Parse nestable async events into AsyncSlices.
      for (var key in nestableAsyncEventsByKey) {
        var eventStateEntries = nestableAsyncEventsByKey[key];
        // Stack of enclosing BEGIN events.
        var parentStack = [];
        for (var i = 0; i < eventStateEntries.length; ++i) {
          var eventStateEntry = eventStateEntries[i];
          // If this is the end of an event, match it to the start.
          if (eventStateEntry.event.ph === 'e') {
            // Walk up the parent stack to find the corresponding BEGIN for
            // this END.
            var parentIndex = -1;
            for (var k = parentStack.length - 1; k >= 0; --k) {
              if (parentStack[k].event.name === eventStateEntry.event.name) {
                parentIndex = k;
                break;
              }
            }
            if (parentIndex === -1) {
              // Unmatched end.
              eventStateEntry.finished = false;
            } else {
              parentStack[parentIndex].end = eventStateEntry;
              // Pop off all enclosing unmatched BEGINs util parentIndex.
              while (parentIndex < parentStack.length) {
                parentStack.pop();
              }
            }
          }
          // Inherit the current parent.
          if (parentStack.length > 0)
            eventStateEntry.parentEntry = parentStack[parentStack.length - 1];
          if (eventStateEntry.event.ph === 'b')
            parentStack.push(eventStateEntry);
        }
        var topLevelSlices = [];
        for (var i = 0; i < eventStateEntries.length; ++i) {
          var eventStateEntry = eventStateEntries[i];
          // Skip matched END, as its slice will be created when we
          // encounter its corresponding BEGIN.
          if (eventStateEntry.event.ph === 'e' &&
              eventStateEntry.finished === undefined) {
            continue;
          }
          var startState = undefined;
          var endState = undefined;
          var sliceArgs = eventStateEntry.event.args || {};
          var sliceError = undefined;
          if (eventStateEntry.event.ph === 'n') {
            startState = eventStateEntry;
            endState = eventStateEntry;
          } else if (eventStateEntry.event.ph === 'b') {
            if (eventStateEntry.end === undefined) {
              // Unmatched BEGIN. End it when last event with this ID ends.
              eventStateEntry.end =
                  eventStateEntries[eventStateEntries.length - 1];
              sliceError =
                  'Slice has no matching END. End time has been adjusted.';
              this.model_.importWarning({
                type: 'async_slice_parse_error',
                message: 'Nestable async BEGIN event at ' +
                    eventStateEntry.event.ts + ' with name=' +
                    eventStateEntry.event.name +
                    ' and id=' + eventStateEntry.event.id + ' was unmatched.'
              });
            } else {
              // Include args for both END and BEGIN for a matched pair.
              function concatenateArguments(args1, args2) {
                if (args1.params === undefined || args2.params === undefined)
                  return tr.b.concatenateObjects(args1, args2);
                // Make an argument object to hold the combined params.
                var args3 = {};
                args3.params = tr.b.concatenateObjects(args1.params,
                                                       args2.params);
                return tr.b.concatenateObjects(args1, args2, args3);
              }
              var endArgs = eventStateEntry.end.event.args || {};
              sliceArgs = concatenateArguments(sliceArgs, endArgs);
            }
            startState = eventStateEntry;
            endState = eventStateEntry.end;
          } else {
            // Unmatched END. Start it at the first event with this ID starts.
            sliceError =
                'Slice has no matching BEGIN. Start time has been adjusted.';
            this.model_.importWarning({
              type: 'async_slice_parse_error',
              message: 'Nestable async END event at ' +
                  eventStateEntry.event.ts + ' with name=' +
                  eventStateEntry.event.name +
                  ' and id=' + eventStateEntry.event.id + ' was unmatched.'
            });
            startState = eventStateEntries[0];
            endState = eventStateEntry;
          }

          var isTopLevel = (eventStateEntry.parentEntry === undefined);
          var asyncSliceConstructor =
             tr.model.AsyncSlice.getConstructor(
                eventStateEntry.event.cat,
                eventStateEntry.event.name);

          var thread_start = undefined;
          var thread_duration = undefined;
          if (startState.event.tts && startState.event.use_async_tts) {
            thread_start = timestampFromUs(startState.event.tts);
            if (endState.event.tts) {
              var thread_end = timestampFromUs(endState.event.tts);
              thread_duration = thread_end - thread_start;
            }
          }

          var slice = new asyncSliceConstructor(
              eventStateEntry.event.cat,
              eventStateEntry.event.name,
              getEventColor(endState.event),
              timestampFromUs(startState.event.ts),
              sliceArgs,
              timestampFromUs(endState.event.ts - startState.event.ts),
              isTopLevel,
              thread_start,
              thread_duration,
              startState.event.argsStripped);

          slice.startThread = startState.thread;
          slice.endThread = endState.thread;

          slice.startStackFrame = this.getStackFrameForEvent_(startState.event);
          slice.endStackFrame = this.getStackFrameForEvent_(endState.event);

          slice.id = key;
          if (sliceError !== undefined)
            slice.error = sliceError;
          eventStateEntry.slice = slice;
          // Add the slice to the topLevelSlices array if there is no parent.
          // Otherwise, add the slice to the subSlices of its parent.
          if (isTopLevel) {
            topLevelSlices.push(slice);
          } else if (eventStateEntry.parentEntry.slice !== undefined) {
            eventStateEntry.parentEntry.slice.subSlices.push(slice);
          }
        }
        for (var si = 0; si < topLevelSlices.length; si++) {
          topLevelSlices[si].startThread.asyncSliceGroup.push(
              topLevelSlices[si]);
        }
      }
    },

    createLegacyAsyncSlices_: function(legacyEvents) {
      if (legacyEvents.length === 0)
        return;

      legacyEvents.sort(function(x, y) {
        var d = x.event.ts - y.event.ts;
        if (d != 0)
          return d;
        return x.sequenceNumber - y.sequenceNumber;
      });

      var asyncEventStatesByNameThenID = {};

      for (var i = 0; i < legacyEvents.length; i++) {
        var asyncEventState = legacyEvents[i];

        var event = asyncEventState.event;
        var name = event.name;
        if (name === undefined) {
          this.model_.importWarning({
            type: 'async_slice_parse_error',
            message: 'Async events (ph: S, T, p, or F) require a name ' +
                ' parameter.'
          });
          continue;
        }

        var id = event.id;
        if (id === undefined) {
          this.model_.importWarning({
            type: 'async_slice_parse_error',
            message: 'Async events (ph: S, T, p, or F) require an id parameter.'
          });
          continue;
        }

        // TODO(simonjam): Add a synchronous tick on the appropriate thread.

        if (event.ph === 'S') {
          if (asyncEventStatesByNameThenID[name] === undefined)
            asyncEventStatesByNameThenID[name] = {};
          if (asyncEventStatesByNameThenID[name][id]) {
            this.model_.importWarning({
              type: 'async_slice_parse_error',
              message: 'At ' + event.ts + ', a slice of the same id ' + id +
                  ' was alrady open.'
            });
            continue;
          }
          asyncEventStatesByNameThenID[name][id] = [];
          asyncEventStatesByNameThenID[name][id].push(asyncEventState);
        } else {
          if (asyncEventStatesByNameThenID[name] === undefined) {
            this.model_.importWarning({
              type: 'async_slice_parse_error',
              message: 'At ' + event.ts + ', no slice named ' + name +
                  ' was open.'
            });
            continue;
          }
          if (asyncEventStatesByNameThenID[name][id] === undefined) {
            this.model_.importWarning({
              type: 'async_slice_parse_error',
              message: 'At ' + event.ts + ', no slice named ' + name +
                  ' with id=' + id + ' was open.'
            });
            continue;
          }
          var events = asyncEventStatesByNameThenID[name][id];
          events.push(asyncEventState);

          if (event.ph === 'F') {
            // Create a slice from start to end.
            var asyncSliceConstructor =
               tr.model.AsyncSlice.getConstructor(
                  events[0].event.cat,
                  name);
            var slice = new asyncSliceConstructor(
                events[0].event.cat,
                name,
                getEventColor(events[0].event),
                timestampFromUs(events[0].event.ts),
                tr.b.concatenateObjects(events[0].event.args,
                                      events[events.length - 1].event.args),
                timestampFromUs(event.ts - events[0].event.ts),
                true, undefined, undefined, events[0].event.argsStripped);
            slice.startThread = events[0].thread;
            slice.endThread = asyncEventState.thread;
            slice.id = id;

            var stepType = events[1].event.ph;
            var isValid = true;

            // Create subSlices for each step. Skip the start and finish events,
            // which are always first and last respectively.
            for (var j = 1; j < events.length - 1; ++j) {
              if (events[j].event.ph === 'T' || events[j].event.ph === 'p') {
                isValid = this.assertStepTypeMatches_(stepType, events[j]);
                if (!isValid)
                  break;
              }

              if (events[j].event.ph === 'S') {
                this.model_.importWarning({
                  type: 'async_slice_parse_error',
                  message: 'At ' + event.event.ts + ', a slice named ' +
                      event.event.name + ' with id=' + event.event.id +
                      ' had a step before the start event.'
                });
                continue;
              }

              if (events[j].event.ph === 'F') {
                this.model_.importWarning({
                  type: 'async_slice_parse_error',
                  message: 'At ' + event.event.ts + ', a slice named ' +
                      event.event.name + ' with id=' + event.event.id +
                      ' had a step after the finish event.'
                });
                continue;
              }

              var startIndex = j + (stepType === 'T' ? 0 : -1);
              var endIndex = startIndex + 1;

              var subName = events[j].event.name;
              if (!events[j].event.argsStripped &&
                  (events[j].event.ph === 'T' || events[j].event.ph === 'p'))
                subName = subName + ':' + events[j].event.args.step;

              var asyncSliceConstructor =
                 tr.model.AsyncSlice.getConstructor(
                    events[0].event.cat,
                    subName);
              var subSlice = new asyncSliceConstructor(
                  events[0].event.cat,
                  subName,
                  getEventColor(event, subName + j),
                  timestampFromUs(events[startIndex].event.ts),
                  this.deepCopyIfNeeded_(events[j].event.args),
                  timestampFromUs(
                    events[endIndex].event.ts - events[startIndex].event.ts),
                      undefined, undefined,
                      events[startIndex].event.argsStripped);
              subSlice.startThread = events[startIndex].thread;
              subSlice.endThread = events[endIndex].thread;
              subSlice.id = id;

              slice.subSlices.push(subSlice);
            }

            if (isValid) {
              // Add |slice| to the start-thread's asyncSlices.
              slice.startThread.asyncSliceGroup.push(slice);
            }

            delete asyncEventStatesByNameThenID[name][id];
          }
        }
      }
    },

    assertStepTypeMatches_: function(stepType, event) {
      if (stepType != event.event.ph) {
        this.model_.importWarning({
          type: 'async_slice_parse_error',
          message: 'At ' + event.event.ts + ', a slice named ' +
              event.event.name + ' with id=' + event.event.id +
              ' had both begin and end steps, which is not allowed.'
        });
        return false;
      }
      return true;
    },

    createFlowSlices_: function() {
      if (this.allFlowEvents_.length === 0)
        return;

      var that = this;

      function validateFlowEvent() {
        if (event.name === undefined) {
          that.model_.importWarning({
            type: 'flow_slice_parse_error',
            message: 'Flow events (ph: s, t or f) require a name parameter.'
          });
          return false;
        }

        // Support Flow API v1.
        if (event.ph === 's' || event.ph === 'f' || event.ph === 't') {
          if (event.id === undefined) {
            that.model_.importWarning({
              type: 'flow_slice_parse_error',
              message: 'Flow events (ph: s, t or f) require an id parameter.'
            });
            return false;
          }
          return true;
        }

        // Support Flow API v2.
        if (event.bind_id) {
          if (event.flow_in === undefined && event.flow_out === undefined) {
            that.model_.importWarning({
              type: 'flow_slice_parse_error',
              message: 'Flow producer or consumer require flow_in or flow_out.'
            });
            return false;
          }
          return true;
        }

        return false;
      }

      function createFlowEvent(thread, event, opt_slice) {
        var startSlice, flowId, flowStartTs;

        if (event.bind_id) {
          // Support Flow API v2.
          startSlice = opt_slice;
          flowId = event.bind_id;
          flowStartTs = timestampFromUs(event.ts + event.dur);
        } else {
          // Support Flow API v1.
          var ts = timestampFromUs(event.ts);
          startSlice = thread.sliceGroup.findSliceAtTs(ts);
          if (startSlice === undefined)
            return undefined;
          flowId = event.id;
          flowStartTs = ts;
        }

        var flowEvent = new tr.model.FlowEvent(
            event.cat,
            flowId,
            event.name,
            getEventColor(event),
            flowStartTs,
            that.deepCopyAlways_(event.args));
        flowEvent.startSlice = startSlice;
        flowEvent.startStackFrame = that.getStackFrameForEvent_(event);
        flowEvent.endStackFrame = undefined;
        startSlice.outFlowEvents.push(flowEvent);
        return flowEvent;
      }

      function finishFlowEventWith(flowEvent, thread, event,
                                   refGuid, bindToParent, opt_slice) {
        var endSlice;

        if (event.bind_id) {
          // Support Flow API v2.
          endSlice = opt_slice;
        } else {
          // Support Flow API v1.
          var ts = timestampFromUs(event.ts);
          if (bindToParent) {
            endSlice = thread.sliceGroup.findSliceAtTs(ts);
          } else {
            endSlice = thread.sliceGroup.findNextSliceAfter(ts, refGuid);
          }
          if (endSlice === undefined)
            return false;
        }

        endSlice.inFlowEvents.push(flowEvent);
        flowEvent.endSlice = endSlice;
        flowEvent.duration = timestampFromUs(event.ts) - flowEvent.start;
        flowEvent.endStackFrame = that.getStackFrameForEvent_(event);
        that.mergeArgsInto_(flowEvent.args, event.args, flowEvent.title);
        return true;
      }

      function processFlowConsumer(flowIdToEvent, sliceGuidToEvent, event,
          slice) {
        var flowEvent = flowIdToEvent[event.bind_id];
        if (flowEvent === undefined) {
          that.model_.importWarning({
              type: 'flow_slice_ordering_error',
              message: 'Flow consumer ' + event.bind_id + ' does not have ' +
                  'a flow producer'});
          return false;
        } else if (flowEvent.endSlice) {
          // One flow producer can have more than one flow consumers.
          // In this case, create a new flow event using the flow producer.
          var flowProducer = flowEvent.startSlice;
          flowEvent = createFlowEvent(undefined,
              sliceGuidToEvent[flowProducer.guid], flowProducer);
        }

        var ok = finishFlowEventWith(flowEvent, undefined, event,
                                     refGuid, undefined, slice);
        if (ok) {
          that.model_.flowEvents.push(flowEvent);
        } else {
          that.model_.importWarning({
              type: 'flow_slice_end_error',
              message: 'Flow consumer ' + event.bind_id + ' does not end ' +
                  'at an actual slice, so cannot be created.'});
          return false;
        }

        return true;
      }

      function processFlowProducer(flowIdToEvent, flowStatus, event, slice) {
        if (flowIdToEvent[event.bind_id] &&
            flowStatus[event.bind_id]) {
          // Can't open the same flow again while it's still open.
          // This is essentially the multi-producer case which we don't support
          that.model_.importWarning({
              type: 'flow_slice_start_error',
              message: 'Flow producer ' + event.bind_id + ' already seen'});
          return false;
        }

        var flowEvent = createFlowEvent(undefined, event, slice);
        if (!flowEvent) {
          that.model_.importWarning({
              type: 'flow_slice_start_error',
              message: 'Flow producer ' + event.bind_id + ' does not start' +
                  'a flow'});
          return false;
        }
        flowIdToEvent[event.bind_id] = flowEvent;

        return;
      }

      // Actual import.
      this.allFlowEvents_.sort(function(x, y) {
        var d = x.event.ts - y.event.ts;
        if (d != 0)
          return d;
        return x.sequenceNumber - y.sequenceNumber;
      });

      var flowIdToEvent = {};
      var sliceGuidToEvent = {};
      var flowStatus = {}; // true: open; false: closed.
      for (var i = 0; i < this.allFlowEvents_.length; ++i) {
        var data = this.allFlowEvents_[i];
        var refGuid = data.refGuid;
        var event = data.event;
        var thread = data.thread;
        if (!validateFlowEvent(event))
          continue;

        // Support for Flow API v2.
        if (event.bind_id) {
          var slice = data.slice;
          sliceGuidToEvent[slice.guid] = event;

          if (event.flowPhase === PRODUCER) {
            if (!processFlowProducer(flowIdToEvent, flowStatus, event, slice))
              continue;
            flowStatus[event.bind_id] = true; // open the flow.
          }
          else {
            if (!processFlowConsumer(flowIdToEvent, sliceGuidToEvent,
                event, slice))
              continue;
            flowStatus[event.bind_id] = false; // close the flow.

            if (event.flowPhase === STEP) {
              if (!processFlowProducer(flowIdToEvent, flowStatus,
                  event, slice))
                continue;
              flowStatus[event.bind_id] = true; // open the flow again.
            }
          }
          continue;
        }

        // Support for Flow API v1.
        var flowEvent;
        if (event.ph === 's') {
          if (flowIdToEvent[event.id]) {
            this.model_.importWarning({
              type: 'flow_slice_start_error',
              message: 'event id ' + event.id + ' already seen when ' +
                  'encountering start of flow event.'});
            continue;
          }
          flowEvent = createFlowEvent(thread, event);
          if (!flowEvent) {
            this.model_.importWarning({
              type: 'flow_slice_start_error',
              message: 'event id ' + event.id + ' does not start ' +
                  'at an actual slice, so cannot be created.'});
            continue;
          }
          flowIdToEvent[event.id] = flowEvent;

        } else if (event.ph === 't' || event.ph === 'f') {
          flowEvent = flowIdToEvent[event.id];
          if (flowEvent === undefined) {
            this.model_.importWarning({
              type: 'flow_slice_ordering_error',
              message: 'Found flow phase ' + event.ph + ' for id: ' + event.id +
                  ' but no flow start found.'
            });
            continue;
          }

          var bindToParent = event.ph === 't';

          if (event.ph === 'f') {
            if (event.bp === undefined) {
              // TODO(yuhaoz): In flow V2, there is no notion of binding point.
              // Removal of binding point is tracked in
              // https://github.com/google/trace-viewer/issues/991.
              if (event.cat.indexOf('input') > -1)
                bindToParent = true;
              else if (event.cat.indexOf('ipc.flow') > -1)
                bindToParent = true;
            } else {
              if (event.bp !== 'e') {
                this.model_.importWarning({
                 type: 'flow_slice_bind_point_error',
                 message: 'Flow event with invalid binding point (event.bp).'
                });
                continue;
              }
              bindToParent = true;
            }
          }

          var ok = finishFlowEventWith(flowEvent, thread, event,
                                       refGuid, bindToParent);
          if (ok) {
            that.model_.flowEvents.push(flowEvent);
          } else {
            this.model_.importWarning({
              type: 'flow_slice_end_error',
              message: 'event id ' + event.id + ' does not end ' +
                  'at an actual slice, so cannot be created.'});
          }
          flowIdToEvent[event.id] = undefined;

          // If this is a step, then create another flow event.
          if (ok && event.ph === 't') {
            flowEvent = createFlowEvent(thread, event);
            flowIdToEvent[event.id] = flowEvent;
          }
        }
      }
    },

    /**
     * This function creates objects described via the N, D, and O phase
     * events.
     */
    createExplicitObjects_: function() {
      if (this.allObjectEvents_.length === 0)
        return;

      function processEvent(objectEventState) {
        var event = objectEventState.event;
        var thread = objectEventState.thread;
        if (event.name === undefined) {
          this.model_.importWarning({
            type: 'object_parse_error',
            message: 'While processing ' + JSON.stringify(event) + ': ' +
                'Object events require an name parameter.'
          });
        }

        if (event.id === undefined) {
          this.model_.importWarning({
            type: 'object_parse_error',
            message: 'While processing ' + JSON.stringify(event) + ': ' +
                'Object events require an id parameter.'
          });
        }
        var process = thread.parent;
        var ts = timestampFromUs(event.ts);
        var instance;
        if (event.ph === 'N') {
          try {
            instance = process.objects.idWasCreated(
                event.id, event.cat, event.name, ts);
          } catch (e) {
            this.model_.importWarning({
              type: 'object_parse_error',
              message: 'While processing create of ' +
                  event.id + ' at ts=' + ts + ': ' + e
            });
            return;
          }
        } else if (event.ph === 'O') {
          if (event.args.snapshot === undefined) {
            this.model_.importWarning({
              type: 'object_parse_error',
              message: 'While processing ' + event.id + ' at ts=' + ts + ': ' +
                  'Snapshots must have args: {snapshot: ...}'
            });
            return;
          }
          var snapshot;
          try {
            var args = this.deepCopyIfNeeded_(event.args.snapshot);
            var cat;
            if (args.cat) {
              cat = args.cat;
              delete args.cat;
            } else {
              cat = event.cat;
            }

            var baseTypename;
            if (args.base_type) {
              baseTypename = args.base_type;
              delete args.base_type;
            } else {
              baseTypename = undefined;
            }
            snapshot = process.objects.addSnapshot(
                event.id, cat, event.name, ts,
                args, baseTypename);
            snapshot.snapshottedOnThread = thread;
          } catch (e) {
            this.model_.importWarning({
              type: 'object_parse_error',
              message: 'While processing snapshot of ' +
                  event.id + ' at ts=' + ts + ': ' + e
            });
            return;
          }
          instance = snapshot.objectInstance;
        } else if (event.ph === 'D') {
          try {
            process.objects.idWasDeleted(event.id, event.cat, event.name, ts);
            var instanceMap = process.objects.getOrCreateInstanceMap_(event.id);
            instance = instanceMap.lastInstance;
          } catch (e) {
            this.model_.importWarning({
              type: 'object_parse_error',
              message: 'While processing delete of ' +
                  event.id + ' at ts=' + ts + ': ' + e
            });
            return;
          }
        }

        if (instance)
          instance.colorId = getEventColor(event, instance.typeName);
      }

      this.allObjectEvents_.sort(function(x, y) {
        var d = x.event.ts - y.event.ts;
        if (d != 0)
          return d;
        return x.sequenceNumber - y.sequenceNumber;
      });

      var allObjectEvents = this.allObjectEvents_;
      for (var i = 0; i < allObjectEvents.length; i++) {
        var objectEventState = allObjectEvents[i];
        try {
          processEvent.call(this, objectEventState);
        } catch (e) {
          this.model_.importWarning({
            type: 'object_parse_error',
            message: e.message
          });
        }
      }
    },

    createImplicitObjects_: function() {
      tr.b.iterItems(this.model_.processes, function(pid, process) {
        this.createImplicitObjectsForProcess_(process);
      }, this);
    },

    // Here, we collect all the snapshots that internally contain a
    // Javascript-level object inside their args list that has an "id" field,
    // and turn that into a snapshot of the instance referred to by id.
    createImplicitObjectsForProcess_: function(process) {

      function processField(referencingObject,
                            referencingObjectFieldName,
                            referencingObjectFieldValue,
                            containingSnapshot) {
        if (!referencingObjectFieldValue)
          return;

        if (referencingObjectFieldValue instanceof
            tr.model.ObjectSnapshot)
          return null;
        if (referencingObjectFieldValue.id === undefined)
          return;

        var implicitSnapshot = referencingObjectFieldValue;

        var rawId = implicitSnapshot.id;
        var m = /(.+)\/(.+)/.exec(rawId);
        if (!m)
          throw new Error('Implicit snapshots must have names.');
        delete implicitSnapshot.id;
        var name = m[1];
        var id = m[2];
        var res;

        var cat;
        if (implicitSnapshot.cat !== undefined)
          cat = implicitSnapshot.cat;
        else
          cat = containingSnapshot.objectInstance.category;

        var baseTypename;
        if (implicitSnapshot.base_type)
          baseTypename = implicitSnapshot.base_type;
        else
          baseTypename = undefined;

        try {
          res = process.objects.addSnapshot(
              id, cat,
              name, containingSnapshot.ts,
              implicitSnapshot, baseTypename);
        } catch (e) {
          this.model_.importWarning({
            type: 'object_snapshot_parse_error',
            message: 'While processing implicit snapshot of ' +
                rawId + ' at ts=' + containingSnapshot.ts + ': ' + e
          });
          return;
        }
        res.objectInstance.hasImplicitSnapshots = true;
        res.containingSnapshot = containingSnapshot;
        res.snapshottedOnThread = containingSnapshot.snapshottedOnThread;
        referencingObject[referencingObjectFieldName] = res;
        if (!(res instanceof tr.model.ObjectSnapshot))
          throw new Error('Created object must be instanceof snapshot');
        return res.args;
      }

      /**
       * Iterates over the fields in the object, calling func for every
       * field/value found.
       *
       * @return {object} If the function does not want the field's value to be
       * iterated, return null. If iteration of the field value is desired, then
       * return either undefined (if the field value did not change) or the new
       * field value if it was changed.
       */
      function iterObject(object, func, containingSnapshot, thisArg) {
        if (!(object instanceof Object))
          return;

        if (object instanceof Array) {
          for (var i = 0; i < object.length; i++) {
            var res = func.call(thisArg, object, i, object[i],
                                containingSnapshot);
            if (res === null)
              continue;
            if (res)
              iterObject(res, func, containingSnapshot, thisArg);
            else
              iterObject(object[i], func, containingSnapshot, thisArg);
          }
          return;
        }

        for (var key in object) {
          var res = func.call(thisArg, object, key, object[key],
                              containingSnapshot);
          if (res === null)
            continue;
          if (res)
            iterObject(res, func, containingSnapshot, thisArg);
          else
            iterObject(object[key], func, containingSnapshot, thisArg);
        }
      }

      // TODO(nduca): We may need to iterate the instances in sorted order by
      // creationTs.
      process.objects.iterObjectInstances(function(instance) {
        instance.snapshots.forEach(function(snapshot) {
          if (snapshot.args.id !== undefined)
            throw new Error('args cannot have an id field inside it');
          iterObject(snapshot.args, processField, snapshot, this);
        }, this);
      }, this);
    },

    createMemoryDumps_: function() {
      tr.b.iterItems(this.allMemoryDumpEvents_, function(id, events) {
        // Calculate the range of the global memory dump.
        var range = new tr.b.Range();
        if (events.global !== undefined)
          range.addValue(timestampFromUs(events.global.ts));
        for (var i = 0; i < events.process.length; i++)
          range.addValue(timestampFromUs(events.process[i].ts));

        // Create the global memory dump.
        var globalMemoryDump = new tr.model.GlobalMemoryDump(
            this.model_, range.min);
        globalMemoryDump.duration = range.range;
        this.model_.globalMemoryDumps.push(globalMemoryDump);

        // Create individual process memory dumps.
        if (events.process.length === 0) {
          this.model_.importWarning({
              type: 'memory_dump_parse_error',
              message: 'No process memory dumps associated with global memory' +
                  ' dump ' + id + '.'
          });
        }

        var allMemoryAllocatorDumpsByGuid = {};
        var globalMemoryAllocatorDumpsByFullName = {};

        var LEVELS_OF_DETAIL = [undefined, 'light', 'detailed'];
        var globalLevelOfDetailIndex = undefined;

        events.process.forEach(function(processEvent) {
          var pid = processEvent.pid;
          if (pid in globalMemoryDump.processMemoryDumps) {
            this.model_.importWarning({
              type: 'memory_dump_parse_error',
              message: 'Multiple process memory dumps with pid=' + pid +
                  ' for dump id ' + id + '.'
            });
            return;
          }

          var dumps = processEvent.args.dumps;
          if (dumps === undefined) {
            this.model_.importWarning({
                type: 'memory_dump_parse_error',
                message: 'dumps not found in process memory dump for ' +
                    'pid=' + pid + ' and dump id=' + id + '.'
            });
            return;
          }

          var process = this.model_.getOrCreateProcess(pid);
          var processMemoryDump = new tr.model.ProcessMemoryDump(
              globalMemoryDump, process,
              timestampFromUs(processEvent.ts));

          // Determine the level of detail of the dump.
          var processLevelOfDetail = dumps.level_of_detail;
          var processLevelOfDetailIndex = LEVELS_OF_DETAIL.indexOf(
              processLevelOfDetail);
          if (processLevelOfDetailIndex < 0) {
            this.model_.importWarning({
              type: 'memory_dump_parse_error',
              message: 'unknown level of detail \'' + processLevelOfDetail +
                  '\' of process memory dump for pid=' + pid +
                  ' and dump id=' + id + '.'
            });
          } else {
            processMemoryDump.levelOfDetail = processLevelOfDetail;
            if (globalLevelOfDetailIndex === undefined) {
              globalLevelOfDetailIndex = processLevelOfDetailIndex;
            } else if (globalLevelOfDetailIndex !== processLevelOfDetailIndex) {
              // If the process memory dumps have different levels of detail,
              // show a warning and use the highest level.
              this.model_.importWarning({
                type: 'memory_dump_parse_error',
                message: 'diffent levels of detail of process memory dumps ' +
                    'for dump id=' + id + '.'
              });
              globalLevelOfDetailIndex = Math.max(
                  globalLevelOfDetailIndex, processLevelOfDetailIndex);
            }
          }

          // Parse the totals.
          var rawTotals = dumps.process_totals;
          if (rawTotals !== undefined) {
            processMemoryDump.totals = {};

            // Total resident bytes (mandatory).
            if (rawTotals.resident_set_bytes !== undefined) {
              processMemoryDump.totals.residentBytes = parseInt(
                  rawTotals.resident_set_bytes, 16);
            }

            // Peak resident bytes (optional).
            if (rawTotals.peak_resident_set_bytes !== undefined) {
              if (rawTotals.is_peak_rss_resetable === undefined) {
                this.model_.importWarning({
                    type: 'memory_dump_parse_error',
                    message: 'Optional field peak_resident_set_bytes found' +
                        ' but is_peak_rss_resetable not found in' +
                        ' process memory dump for pid=' + pid +
                        ' and dump id=' + id + '.'
                });
              }
              processMemoryDump.totals.peakResidentBytes = parseInt(
                  rawTotals.peak_resident_set_bytes, 16);
            }
            if (rawTotals.is_peak_rss_resetable !== undefined) {
              if (rawTotals.peak_resident_set_bytes === undefined) {
                this.model_.importWarning({
                    type: 'memory_dump_parse_error',
                    message: 'Optional field is_peak_rss_resetable found' +
                        ' but peak_resident_set_bytes not found in' +
                        ' process memory dump for pid=' + pid +
                        ' and dump id=' + id + '.'
                });
              }
              processMemoryDump.totals.arePeakResidentBytesResettable =
                  !!rawTotals.is_peak_rss_resetable;
            }
          }
          if (processMemoryDump.totals === undefined ||
              processMemoryDump.totals.residentBytes === undefined) {
            this.model_.importWarning({
                type: 'memory_dump_parse_error',
                message: 'Mandatory field resident_set_bytes not found in' +
                    ' process memory dump for pid=' + pid +
                    ' and dump id=' + id + '.'
            });
          }

          // Populate the vmRegions, if present.
          if (dumps.process_mmaps && dumps.process_mmaps.vm_regions) {
            function parseByteStat(rawValue) {
              if (rawValue === undefined)
                return undefined;
              return parseInt(rawValue, 16);
            }

            processMemoryDump.vmRegions = dumps.process_mmaps.vm_regions.map(
              function(rawRegion) {
                // See //base/trace_event/process_memory_maps.cc in Chromium.
                var byteStats = new tr.model.VMRegionByteStats(
                  parseByteStat(rawRegion.bs.pc),
                  parseByteStat(rawRegion.bs.pd),
                  parseByteStat(rawRegion.bs.sc),
                  parseByteStat(rawRegion.bs.sd),
                  parseByteStat(rawRegion.bs.pss),
                  parseByteStat(rawRegion.bs.sw)
                );
                return new tr.model.VMRegion(
                    parseInt(rawRegion.sa, 16),  // startAddress
                    parseInt(rawRegion.sz, 16),  // sizeInBytes
                    rawRegion.pf,  // protectionFlags
                    rawRegion.mf,  // mappedFile
                    byteStats
                );
              }
            );
          }

          // Gather the process and global memory allocator dumps, if present.
          var processMemoryAllocatorDumpsByFullName = {};
          if (dumps.allocators !== undefined) {
            // Construct the MemoryAllocatorDump objects without parent links
            // and add them to the processMemoryAllocatorDumpsByName and
            // globalMemoryAllocatorDumpsByName indices appropriately.
            tr.b.iterItems(dumps.allocators,
                function(fullName, rawAllocatorDump) {
              // Every memory allocator dump should have a GUID. If not, then
              // it cannot be associated with any edges.
              var guid = rawAllocatorDump.guid;
              if (guid === undefined) {
                this.model_.importWarning({
                  type: 'memory_dump_parse_error',
                  message: 'Memory allocator dump ' + fullName +
                      ' from pid=' + pid + ' does not have a GUID.'
                });
              }

              // Determine if this is a global memory allocator dump (check if
              // it's prefixed with 'global/').
              var GLOBAL_MEMORY_ALLOCATOR_DUMP_PREFIX = 'global/';
              var containerMemoryDump;
              var dstIndex;
              if (fullName.startsWith(GLOBAL_MEMORY_ALLOCATOR_DUMP_PREFIX)) {
                // Global memory allocator dump.
                fullName = fullName.substring(
                    GLOBAL_MEMORY_ALLOCATOR_DUMP_PREFIX.length);
                containerMemoryDump = globalMemoryDump;
                dstIndex = globalMemoryAllocatorDumpsByFullName;
              } else {
                // Process memory allocator dump.
                containerMemoryDump = processMemoryDump;
                dstIndex = processMemoryAllocatorDumpsByFullName;
              }

              // Construct or retrieve a memory allocator dump with the provided
              // GUID.
              var allocatorDump = allMemoryAllocatorDumpsByGuid[guid];
              if (allocatorDump === undefined) {
                if (fullName in dstIndex) {
                  this.model_.importWarning({
                    type: 'memory_dump_parse_error',
                    message: 'Multiple GUIDs provided for' +
                        ' memory allocator dump ' + fullName + ': ' +
                        dstIndex[fullName].guid + ', ' + guid + ' (ignored).'
                  });
                  return;
                }
                allocatorDump = new tr.model.MemoryAllocatorDump(
                    containerMemoryDump, fullName, guid);
                dstIndex[fullName] = allocatorDump;
                if (guid !== undefined)
                  allMemoryAllocatorDumpsByGuid[guid] = allocatorDump;
              } else {
                // A memory allocator dump with this GUID has already been
                // dumped (so we will only add new attributes). Check that it
                // belonged to the same process or was also global.
                if (allocatorDump.containerMemoryDump !== containerMemoryDump) {
                  this.model_.importWarning({
                  type: 'memory_dump_parse_error',
                  message: 'Memory allocator dump ' + fullName +
                      ' (GUID=' + guid + ') dumped in different contexts.'
                  });
                  return;
                }
                // Check that the names of the memory allocator dumps match.
                if (allocatorDump.fullName !== fullName) {
                  this.model_.importWarning({
                  type: 'memory_dump_parse_error',
                  message: 'Memory allocator dump with GUID=' + guid +
                      ' has multiple names: ' + allocatorDump.fullName +
                      ', ' + fullName + ' (ignored).'
                  });
                  return;
                }
              }

              // Add all new attributes to the memory allocator dump.
              var attributes = rawAllocatorDump.attrs;
              if (attributes === undefined) {
                this.model_.importWarning({
                  type: 'memory_dump_parse_error',
                  message: 'Memory allocator dump ' + fullName +
                      ' from pid=' + pid + ' (GUID=' + guid + ') does not' +
                      ' have attributes.'
                });
                attributes = {};
              }

              tr.b.iterItems(attributes, function(attrName, attrArgs) {
                if (attrName in allocatorDump.attributes) {
                  // Skip existing attributes of the memory allocator dump.
                  this.model_.importWarning({
                  type: 'memory_dump_parse_error',
                  message: 'Multiple values provided for attribute ' +
                      attrName + ' of memory allocator dump ' + fullName +
                      ' (GUID=' + guid + ').'
                  });
                  return;
                }
                var attrValue =
                    tr.model.Attribute.fromDictIfPossible(attrArgs);
                allocatorDump.addAttribute(attrName, attrValue);
              }, this);
            }, this);
          }

          // Find the root allocator dumps and establish the parent links of
          // the process memory dump.
          processMemoryDump.memoryAllocatorDumps =
              this.inferMemoryAllocatorDumpTree_(
                  processMemoryAllocatorDumpsByFullName);

          // Parse heap dumps (if present).
          if (dumps.heaps !== undefined) {
            processMemoryDump.heapDumps = tr.b.mapItems(dumps.heaps,
                this.parseHeapDump_.bind(this, processMemoryDump));
          }

          process.memoryDumps.push(processMemoryDump);
          globalMemoryDump.processMemoryDumps[pid] = processMemoryDump;
        }, this);

        globalMemoryDump.levelOfDetail =
            LEVELS_OF_DETAIL[globalLevelOfDetailIndex];

        // Find the root allocator dumps and establish the parent links of
        // the global memory dump.
        globalMemoryDump.memoryAllocatorDumps =
            this.inferMemoryAllocatorDumpTree_(
                globalMemoryAllocatorDumpsByFullName);

        // Set up edges between memory allocator dumps.
        events.process.forEach(function(processEvent) {
          var dumps = processEvent.args.dumps;
          if (dumps === undefined)
            return;

          var edges = dumps.allocators_graph;
          if (edges === undefined)
            return;

          edges.forEach(function(rawEdge) {
            var sourceGuid = rawEdge.source;
            var sourceDump = allMemoryAllocatorDumpsByGuid[sourceGuid];
            if (sourceDump === undefined) {
              this.model_.importWarning({
                type: 'memory_dump_parse_error',
                message: 'Edge is missing source memory allocator dump (GUID=' +
                    sourceGuid + ')'
              });
              return;
            }

            var targetGuid = rawEdge.target;
            var targetDump = allMemoryAllocatorDumpsByGuid[targetGuid];
            if (targetDump === undefined) {
              this.model_.importWarning({
                type: 'memory_dump_parse_error',
                message: 'Edge is missing target memory allocator dump (GUID=' +
                    targetGuid + ')'
              });
              return;
            }

            var importance = rawEdge.importance;
            var edge = new tr.model.MemoryAllocatorDumpLink(
                sourceDump, targetDump, importance);

            switch (rawEdge.type) {
              case 'ownership':
                if (sourceDump.owns !== undefined) {
                  this.model_.importWarning({
                    type: 'memory_dump_parse_error',
                    message: 'Memory allocator dump ' + sourceDump.fullName +
                        ' (GUID=' + sourceGuid + ') already owns a memory' +
                        ' allocator dump (' +
                        sourceDump.owns.target.fullName + ').'
                  });
                  return;
                }
                sourceDump.owns = edge;
                targetDump.ownedBy.push(edge);
                break;

              case 'retention':
                sourceDump.retains.push(edge);
                targetDump.retainedBy.push(edge);
                break;

              default:
                this.model_.importWarning({
                  type: 'memory_dump_parse_error',
                  message: 'Invalid edge type: ' + rawEdge.type +
                      ' (source=' + sourceGuid + ', target=' + targetGuid +
                      ', importance=' + importance + ').'
                });
            }
          }, this);
        }, this);
      }, this);
    },

    inferMemoryAllocatorDumpTree_: function(memoryAllocatorDumpsByFullName) {
      var rootAllocatorDumps = [];

      var fullNames = Object.keys(memoryAllocatorDumpsByFullName);
      fullNames.sort();
      fullNames.forEach(function(fullName) {
        var allocatorDump = memoryAllocatorDumpsByFullName[fullName];

        // This is a loop because we might need to build implicit
        // ancestors in case they were not present in the trace.
        while (true) {
          var lastSlashIndex = fullName.lastIndexOf('/');
          if (lastSlashIndex === -1) {
            // If the dump is a root, add it to the top-level
            // rootAllocatorDumps list.
            rootAllocatorDumps.push(allocatorDump);
            break;
          }

          // If the dump is not a root, find its parent.
          var parentFullName = fullName.substring(0, lastSlashIndex);
          var parentAllocatorDump =
              memoryAllocatorDumpsByFullName[parentFullName];

          // If the parent dump does not exist yet, we build an implicit
          // one and continue up the ancestor chain.
          var parentAlreadyExisted = true;
          if (parentAllocatorDump === undefined) {
            parentAlreadyExisted = false;
            parentAllocatorDump = new tr.model.MemoryAllocatorDump(
                allocatorDump.containerMemoryDump, parentFullName);
            memoryAllocatorDumpsByFullName[parentFullName] =
                parentAllocatorDump;
          }

          // Setup the parent <-> children relationships
          allocatorDump.parent = parentAllocatorDump;
          parentAllocatorDump.children.push(allocatorDump);

          // If the parent already existed, then its ancestors were/will be
          // constructed in another iteration of the forEach loop.
          if (parentAlreadyExisted)
            break;

          fullName = parentFullName;
          allocatorDump = parentAllocatorDump;
        }
      }, this);

      return rootAllocatorDumps;
    },

    parseHeapDump_: function(processMemoryDump, allocatorName, rawHeapDump) {
      var pid = processMemoryDump.process.pid;
      var entries = rawHeapDump.entries;
      if (entries === undefined) {
        this.model_.importWarning({
          type: 'memory_dump_parse_error',
          message: 'Missing heap entries in a ' + allocatorName +
              ' heap dump for pid=' + pid + '.'
        });
        return undefined;
      }

      var model = this.model_;
      var heapDump = new tr.model.HeapDump(processMemoryDump, allocatorName);
      var idPrefix = 'p' + pid + ':';

      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var size = parseInt(entry.size, 16);
        var leafStackFrameIndex = entry.bt;
        var leafStackFrame;
        if (leafStackFrameIndex === undefined) {
          leafStackFrame = undefined;
        } else {
          var leafStackFrameId = idPrefix + leafStackFrameIndex;
          leafStackFrame = model.stackFrames[leafStackFrameId];
          if (leafStackFrame === undefined) {
            this.model_.importWarning({
              type: 'memory_dump_parse_error',
              message: 'Missing leaf stack frame (ID ' + leafStackFrameId +
                  ') of heap entry ' + i + ' (size ' + size + ') in a ' +
                  allocatorName + ' heap dump for pid=' + pid + '.'
            });
            continue;
          }
        }
        heapDump.addEntry(leafStackFrame, size);
      }
      return heapDump;
    },

    joinObjectRefs_: function() {
      tr.b.iterItems(this.model_.processes, function(pid, process) {
        this.joinObjectRefsForProcess_(process);
      }, this);
    },

    joinObjectRefsForProcess_: function(process) {
      // Iterate the world, looking for id_refs
      var patchupsToApply = [];
      tr.b.iterItems(process.threads, function(tid, thread) {
        thread.asyncSliceGroup.slices.forEach(function(item) {
          this.searchItemForIDRefs_(
              patchupsToApply, process.objects, 'start', item);
        }, this);
        thread.sliceGroup.slices.forEach(function(item) {
          this.searchItemForIDRefs_(
              patchupsToApply, process.objects, 'start', item);
        }, this);
      }, this);
      process.objects.iterObjectInstances(function(instance) {
        instance.snapshots.forEach(function(item) {
          this.searchItemForIDRefs_(
              patchupsToApply, process.objects, 'ts', item);
        }, this);
      }, this);

      // Change all the fields pointing at id_refs to their real values.
      patchupsToApply.forEach(function(patchup) {
        patchup.object[patchup.field] = patchup.value;
      });
    },

    searchItemForIDRefs_: function(patchupsToApply, objectCollection,
                                   itemTimestampField, item) {
      if (!item.args)
        throw new Error('item is missing its args');

      function handleField(object, fieldName, fieldValue) {
        if (!fieldValue || (!fieldValue.id_ref && !fieldValue.idRef))
          return;

        var id = fieldValue.id_ref || fieldValue.idRef;
        var ts = item[itemTimestampField];
        var snapshot = objectCollection.getSnapshotAt(id, ts);
        if (!snapshot)
          return;

        // We have to delay the actual change to the new value until after all
        // refs have been located. Otherwise, we could end up recursing in
        // ways we definitely didn't intend.
        patchupsToApply.push({object: object,
          field: fieldName,
          value: snapshot});
      }
      function iterObjectFieldsRecursively(object) {
        if (!(object instanceof Object))
          return;

        if ((object instanceof tr.model.ObjectSnapshot) ||
            (object instanceof Float32Array) ||
            (object instanceof tr.b.Quad))
          return;

        if (object instanceof Array) {
          for (var i = 0; i < object.length; i++) {
            handleField(object, i, object[i]);
            iterObjectFieldsRecursively(object[i]);
          }
          return;
        }

        for (var key in object) {
          var value = object[key];
          handleField(object, key, value);
          iterObjectFieldsRecursively(value);
        }
      }

      iterObjectFieldsRecursively(item.args);
    }
  };

  tr.importer.Importer.register(TraceEventImporter);

  return {
    TraceEventImporter: TraceEventImporter
  };
});
