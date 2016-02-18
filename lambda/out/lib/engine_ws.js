/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

var async = require('async');
var _ = require('lodash');
var WebSocket = require('ws');
var debug = require('debug')('ws');
var engineUtil = require('./engine_util');
module.exports = WSEngine;

function WSEngine(config) {
  this.config = config;
}

WSEngine.prototype.step = function (requestSpec, ee) {
  var self = this;

  if (requestSpec.loop) {
    var steps = _.map(requestSpec.loop, function (rs) {
      return self.step(rs, ee);
    });

    return engineUtil.createLoopWithCount(requestSpec.count || -1, steps);
  }

  var f = function f(context, callback) {
    ee.emit('request');
    var startedAt = process.hrtime();
    context.ws.send(requestSpec.send, function (err) {
      if (err) {
        debug(err);
        ee.emit('error', err);
      } else {
        var endedAt = process.hrtime(startedAt);
        var delta = endedAt[0] * 1e9 + endedAt[1];
        ee.emit('response', delta, 0, context._uid);
      }
      return callback(err, context);
    });
  };

  return f;
};

WSEngine.prototype.compile = function (tasks, scenarioSpec, ee) {
  var config = this.config;

  function zero(callback) {
    var ws = new WebSocket(config.target);
    ws.on('open', function () {
      ee.emit('started');
      return callback(null, { ws: ws });
    });
    ws.once('error', function (err) {
      debug(err);
      ee.emit('error', err.code);
      return callback(err, {});
    });
  }

  return function scenario(initialContext, callback) {
    initialContext._successCount = 0;
    initialContext._pendingRequests = _.size(_.reject(scenarioSpec, function (rs) {
      return typeof rs.think === 'number';
    }));

    var steps = _.flatten([zero, tasks]);

    async.waterfall(steps, function scenarioWaterfallCb(err, context) {
      if (err) {
        debug(err);
      }
      if (context.ws) {
        context.ws.close();
      }
      return callback(err, context);
    });
  };
};