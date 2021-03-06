/**
Copyright (c) 2015 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("../base/units/time_stamp.js");
require("./attribute.js");
require("./container_memory_dump.js");
require("./memory_allocator_dump.js");

'use strict';

/**
 * @fileoverview Provides the ProcessMemoryDump class.
 */
global.tr.exportTo('tr.model', function() {

  // Names of MemoryAllocatorDump(s) from which tracing overhead should be
  // discounted.
  var DISCOUNTED_ALLOCATOR_NAMES = ['winheap', 'malloc'];

  var SIZE_ATTRIBUTE_NAME = tr.model.MemoryAllocatorDump.SIZE_ATTRIBUTE_NAME;
  var EFFECTIVE_SIZE_ATTRIBUTE_NAME =
      tr.model.MemoryAllocatorDump.EFFECTIVE_SIZE_ATTRIBUTE_NAME;

  /**
   * The ProcessMemoryDump represents a memory dump of a single process.
   * @constructor
   */
  function ProcessMemoryDump(globalMemoryDump, process, start) {
    tr.model.ContainerMemoryDump.call(this, start);
    this.process = process;
    this.globalMemoryDump = globalMemoryDump;

    this.totals = undefined;
    this.vmRegions_ = undefined;

    // Map from allocator names to heap dumps.
    this.heapDumps = undefined;

    this.tracingMemoryDiscounted_ = false;
  };

  ProcessMemoryDump.prototype = {
    __proto__: tr.model.ContainerMemoryDump.prototype,

    get userFriendlyName() {
      return 'Process memory dump at ' +
          tr.b.u.TimeStamp.format(this.start);
    },

    get containerName() {
      return this.process.userFriendlyName;
    },

    get processMemoryDumps() {
      var dumps = {};
      dumps[this.process.pid] = this;
      return dumps;
    },

    get vmRegions() {
      throw new Error(
          'VM regions must be accessed through the mostRecentVmRegions field');
    },

    set vmRegions(vmRegions) {
      this.vmRegions_ = vmRegions;
    },

    get hasOwnVmRegions() {
      return this.vmRegions_ !== undefined;
    },

    getMostRecentTotalVmRegionStat: function(statName) {
      if (this.mostRecentVmRegions === undefined)
        return undefined;

      var total = 0;
      this.mostRecentVmRegions.forEach(function(vmRegion) {
        var statValue = vmRegion.byteStats[statName];
        if (statValue === undefined)
          return;
        total += statValue;
      });
      return total;
    },

    discountTracingOverhead: function(opt_model) {
      // Make sure that calling this method twice won't lead to
      // 'double-discounting'.
      if (this.tracingMemoryDiscounted_)
        return;
      this.tracingMemoryDiscounted_ = true;

      var tracingDump = this.getMemoryAllocatorDumpByFullName('tracing');
      if (tracingDump === undefined)
        return;

      function getDiscountedSize(sizeAttrName) {
        var sizeAttr = tracingDump.getValidSizeAttributeOrUndefined(
            sizeAttrName, opt_model);
        if (sizeAttr === undefined)
          return 0;
        return sizeAttr.value;
      }

      var discountedSize = getDiscountedSize(SIZE_ATTRIBUTE_NAME);
      var discountedEffectiveSize =
          getDiscountedSize(EFFECTIVE_SIZE_ATTRIBUTE_NAME);
      var discountedResidentSize = getDiscountedSize('resident_size');

      // Subtract 'resident_size' from totals and VM regions stats.
      if (discountedResidentSize > 0) {
        // Subtract the tracing size from the totals.
        if (this.totals !== undefined) {
          if (this.totals.residentBytes !== undefined)
            this.totals.residentBytes -= discountedResidentSize;
          if (this.totals.peakResidentBytes !== undefined)
            this.totals.peakResidentBytes -= discountedResidentSize;
        }

        // Subtract the tracing size from VM regions.
        if (this.vmRegions_ !== undefined) {
          this.vmRegions_.push(VMRegion.fromDict({
            mappedFile: '[discounted tracing overhead]',
            byteStats: {
              privateDirtyResident: -discountedResidentSize,
              proportionalResident: -discountedResidentSize
            }
          }));
        }
      }

      // Subtract 'size' and 'effective_size' from the 'winheap' or 'malloc'
      // MemoryAllocatorDump.
      if (discountedSize > 0 || discountedEffectiveSize > 0) {
        function discountSizeAndEffectiveSize(dump) {
          var dumpSizeAttr = dump.getValidSizeAttributeOrUndefined(
              SIZE_ATTRIBUTE_NAME, opt_model);
          if (dumpSizeAttr !== undefined)
            dumpSizeAttr.value -= discountedSize;

          var dumpEffectiveSizeAttr = dump.getValidSizeAttributeOrUndefined(
              EFFECTIVE_SIZE_ATTRIBUTE_NAME, opt_model);
          if (dumpEffectiveSizeAttr !== undefined)
            dumpEffectiveSizeAttr.value -= discountedEffectiveSize;
        }

        var hasDiscountedFromAllocatorDumps = DISCOUNTED_ALLOCATOR_NAMES.some(
            function(allocatorName) {
          // Discount 'size' and 'effective_size' from the allocator root.
          var allocatorDump = this.getMemoryAllocatorDumpByFullName(
              allocatorName);
          if (allocatorDump === undefined)
            return false;  // Allocator doesn't exist, try another one.
          discountSizeAndEffectiveSize(allocatorDump);

          // Discount 'size' and 'effective_size' from allocated objects of the
          // allocator ('<ALLOCATOR>/allocated_objects').
          var allocatedObjectsDumpName = allocatorName + '/allocated_objects';
          var allocatedObjectsDump = this.getMemoryAllocatorDumpByFullName(
              allocatedObjectsDumpName);
          if (allocatedObjectsDump === undefined)
            return true;  // Allocator has unexpected structure, good enough.
          discountSizeAndEffectiveSize(allocatedObjectsDump);

          // Add a child MAD representing the discounted tracing overhead
          // ('<ALLOCATOR>/allocated_objects/discounted_tracing_overhead').
          var discountDumpName =
              allocatedObjectsDumpName + '/discounted_tracing_overhead';
          var discountDump = new tr.model.MemoryAllocatorDump(
              this, discountDumpName);
          discountDump.parent = allocatedObjectsDump;
          discountDump.addAttribute(SIZE_ATTRIBUTE_NAME,
              new tr.model.ScalarAttribute('bytes', -discountedSize));
          discountDump.addAttribute(EFFECTIVE_SIZE_ATTRIBUTE_NAME,
              new tr.model.ScalarAttribute('bytes', -discountedEffectiveSize));
          allocatedObjectsDump.children.push(discountDump);

          return true;
        }, this);

        // Force rebuilding the memory allocator dump index (if we've just added
        // a new memory allocator dump).
        if (hasDiscountedFromAllocatorDumps)
          this.memoryAllocatorDumps = this.memoryAllocatorDumps;
      }
    }
  };

  ProcessMemoryDump.hookUpMostRecentVmRegionsLinks = function(processDumps) {
    var mostRecentVmRegions = undefined;

    processDumps.forEach(function(processDump) {
      // Update the most recent VM regions from the current dump.
      if (processDump.vmRegions_ !== undefined)
        mostRecentVmRegions = processDump.vmRegions_;

      // Set the most recent VM regions of the current dump.
      processDump.mostRecentVmRegions = mostRecentVmRegions;
    });
  };

  /**
   * @constructor
   */
  function VMRegion(startAddress, sizeInBytes, protectionFlags,
      mappedFile, byteStats) {
    this.startAddress = startAddress;
    this.sizeInBytes = sizeInBytes;
    this.protectionFlags = protectionFlags;
    this.mappedFile = mappedFile;
    this.byteStats = byteStats;
  };

  VMRegion.PROTECTION_FLAG_READ = 4;
  VMRegion.PROTECTION_FLAG_WRITE = 2;
  VMRegion.PROTECTION_FLAG_EXECUTE = 1;

  VMRegion.prototype = {
    get protectionFlagsToString() {
      if (this.protectionFlags === undefined)
        return undefined;
      return (
          (this.protectionFlags & VMRegion.PROTECTION_FLAG_READ ? 'r' : '-') +
          (this.protectionFlags & VMRegion.PROTECTION_FLAG_WRITE ? 'w' : '-') +
          (this.protectionFlags & VMRegion.PROTECTION_FLAG_EXECUTE ? 'x' : '-')
      );
    }
  };

  VMRegion.fromDict = function(dict) {
    return new VMRegion(
        dict.startAddress,
        dict.sizeInBytes,
        dict.protectionFlags,
        dict.mappedFile,
        VMRegionByteStats.fromDict(dict.byteStats));
  };

  /**
   * @constructor
   */
  function VMRegionByteStats(privateCleanResident, privateDirtyResident,
                             sharedCleanResident, sharedDirtyResident,
                             proportionalResident, swapped) {
    this.privateCleanResident = privateCleanResident;
    this.privateDirtyResident = privateDirtyResident;
    this.sharedCleanResident = sharedCleanResident;
    this.sharedDirtyResident = sharedDirtyResident;
    this.proportionalResident = proportionalResident;
    this.swapped = swapped;
  }

  VMRegionByteStats.fromDict = function(dict) {
    return new VMRegionByteStats(
        dict.privateCleanResident,
        dict.privateDirtyResident,
        dict.sharedCleanResident,
        dict.sharedDirtyResident,
        dict.proportionalResident,
        dict.swapped);
  }

  tr.model.EventRegistry.register(
      ProcessMemoryDump,
      {
        name: 'processMemoryDump',
        pluralName: 'processMemoryDumps',
        singleViewElementName: 'tr-ui-a-container-memory-dump-sub-view',
        multiViewElementName: 'tr-ui-a-container-memory-dump-sub-view'
      });

  return {
    ProcessMemoryDump: ProcessMemoryDump,
    VMRegion: VMRegion,
    VMRegionByteStats: VMRegionByteStats
  };
});
