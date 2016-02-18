/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

var EventEmitter = require('events').EventEmitter;
var async = require('async');
var _ = require('lodash');
var arrivals = require('arrivals');
var debug = require('debug')('phases');

module.exports = phaser;

function phaser(phaseSpecs) {
  var ee = new EventEmitter();

  var tasks = _.map(phaseSpecs, function (spec, i) {
    if (!spec.index) {
      spec.index = i;
    }

    if (spec.arrivalRate && !spec.rampTo) {
      spec.mode = spec.mode || 'uniform';
    }

    if (spec.pause) {
      return createPause(spec, ee);
    } else if (spec.rampTo && spec.arrivalRate) {
      return createRamp(spec, ee);
    } else if (spec.arrivalCount) {
      return createArrivalCount(spec, ee);
    } else if (spec.arrivalRate) {
      return createArrivalRate(spec, ee);
    } else {
      console.log('Unknown phase spec\n%j\nThis should not happen', spec);
    }
  });

  ee.run = function () {
    async.series(tasks, function (err) {
      if (err) {
        debug(err);
      }

      ee.emit('done');
    });
  };

  return ee;
}

function createPause(spec, ee) {
  var duration = spec.pause * 1000;
  var task = function task(callback) {
    ee.emit('phaseStarted', spec);
    setTimeout(function () {
      ee.emit('phaseCompleted', spec);
      return callback(null);
    }, duration);
  };
  return task;
}

function createRamp(spec, ee) {
  var incBy = (spec.rampTo - spec.arrivalRate) / (spec.duration - 1);
  var stepCount = spec.duration;
  var arrivalRate = spec.arrivalRate;

  debug('rampTo: incBy = %s', incBy);
  var steps = _.map(_.range(0, stepCount), function (i) {
    return function (callback) {
      var tick = 1000 / (arrivalRate + i * incBy);
      debug('rampTo: tick = %s', tick);
      var p = arrivals.uniform.process(tick, 1000);
      p.on('arrival', function () {
        ee.emit('arrival');
      });
      p.on('finished', function () {
        return callback(null);
      });
      p.start();
    };
  });

  var task = function task(callback) {
    ee.emit('phaseStarted', spec);
    async.series(steps, function (err) {
      if (err) {
        debug(err);
      }
      ee.emit('phaseCompleted', spec);
      return callback(null);
    });
  };

  return task;
}

function createArrivalCount(spec, ee) {
  var task = function task(callback) {
    ee.emit('phaseStarted', spec);
    var duration = spec.duration * 1000;
    var interval = duration / spec.arrivalCount;
    var p = arrivals.uniform.process(interval, duration);
    p.on('arrival', function () {
      ee.emit('arrival');
    });
    p.on('finished', function () {
      ee.emit('phaseCompleted', spec);
      return callback(null);
    });
    p.start();
  };

  return task;
}

function createArrivalRate(spec, ee) {
  var task = function task(callback) {
    ee.emit('phaseStarted', spec);
    var ar = 1000 / spec.arrivalRate;
    var duration = spec.duration * 1000;
    debug('creating a %s process for arrivalRate', spec.mode);
    var p = arrivals[spec.mode].process(ar, duration);
    p.on('arrival', function () {
      ee.emit('arrival');
    });
    p.on('finished', function () {
      ee.emit('phaseCompleted', spec);
      return callback(null);
    });
    p.start();
  };

  return task;
}
