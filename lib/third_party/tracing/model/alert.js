/**
Copyright (c) 2015 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("../base/units/time_stamp.js");
require("./event_info.js");
require("./event_set.js");
require("./timed_event.js");

'use strict';

global.tr.exportTo('tr.model', function() {

  function Alert(info, start, opt_associatedEvents, opt_args) {
    tr.model.TimedEvent.call(this, start);
    this.info = info;
    this.args = opt_args || {};
    this.associatedEvents = new tr.model.EventSet(opt_associatedEvents);
    this.associatedEvents.forEach(function(event) {
      event.associatedAlerts.push(this);
    }, this);
  }

  Alert.prototype = {
    __proto__: tr.model.TimedEvent.prototype,

    get title() {
      return this.info.title;
    },

    get colorId() {
      return this.info.colorId;
    },

    get userFriendlyName() {
      return 'Alert ' + this.title + ' at ' +
          tr.b.u.TimeStamp.format(this.start);
    }
  };

  tr.model.EventRegistry.register(
      Alert,
      {
        name: 'alert',
        pluralName: 'alerts',
        singleViewElementName: 'tr-ui-a-alert-sub-view',
        multiViewElementName: 'tr-ui-a-alert-sub-view'
      });

  return {
    Alert: Alert
  };
});
