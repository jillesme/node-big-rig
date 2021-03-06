/**
Copyright (c) 2015 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("../../base/rect.js");

'use strict';

global.tr.exportTo('tr.ui.b', function() {
  function instantiateTemplate(selector, doc) {
    doc = doc || document;
    var el = doc.querySelector(selector);
    if (!el)
      throw new Error('Element not found');
    return el.createInstance();
  }

  function windowRectForElement(element) {
    var position = [element.offsetLeft, element.offsetTop];
    var size = [element.offsetWidth, element.offsetHeight];
    var node = element.offsetParent;
    while (node) {
      position[0] += node.offsetLeft;
      position[1] += node.offsetTop;
      node = node.offsetParent;
    }
    return tr.b.Rect.fromXYWH(position[0], position[1], size[0], size[1]);
  }

  function scrollIntoViewIfNeeded(el) {
    var pr = el.parentElement.getBoundingClientRect();
    var cr = el.getBoundingClientRect();
    if (cr.top < pr.top) {
      el.scrollIntoView(true);
    } else if (cr.bottom > pr.bottom) {
      el.scrollIntoView(false);
    }
  }

  return {
    instantiateTemplate: instantiateTemplate,
    windowRectForElement: windowRectForElement,
    scrollIntoViewIfNeeded: scrollIntoViewIfNeeded
  };
});
