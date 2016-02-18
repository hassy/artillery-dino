/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

var EventEmitter = require('events').EventEmitter;
var _ = require('lodash');
var debug = require('debug')('runner');
var debugPerf = require('debug')('perf');
var uuid = require('node-uuid');
var Stats = require('./stats2');
var createPhaser = require('./phases');
var engineUtil = require('./engine_util');
var wl = require('./weighted-pick');

var Engines = {
  http: {},
  ws: {}
};

module.exports = {
  runner: runner
};

// Only one runner can execute at a time when used as a library.

var pendingRequests = 0;
var pendingScenarios = 0;

var compiledScenarios = undefined;
var scenarioEvents = undefined;
var picker = undefined;

var Report = {
  intermediate: [],
  aggregate: {}
};

var plugins = [];
var engines = [];

function runner(script, payload, options) {

  var opts = _.assign({
    periodicStats: script.config.statsInterval || 10,
    mode: script.config.mode || 'uniform'
  }, options);

  _.each(script.config.phases, function (phaseSpec) {
    phaseSpec.mode = phaseSpec.mode || script.config.mode;
  });

  if (payload) {
    if (_.isArray(payload[0])) {
      script.config.payload = [{
        fields: script.config.payload.fields,
        data: payload
      }];
    } else {
      script.config.payload = payload;
    }
  } else {
    script.config.payload = null;
  }

  var runnableScript = _.cloneDeep(script);

  if (opts.environment) {
    _.merge(runnableScript.config, script.config.environments[opts.environment]);
  }

  compiledScenarios = null;
  scenarioEvents = null;

  var ee = new EventEmitter();

  //
  // load engines:
  //
  engines = _.map(_extends({}, Engines, script.config.engines), function loadEngine(engineConfig, engineName) {
    var moduleName = 'artillery-engine-' + engineName;
    try {
      if (Engines[engineName]) {
        moduleName = './engine_' + engineName;
      }
      var Engine = require(moduleName);
      var engine = new Engine(script.config, ee);
      engine.__name = engineName;
      return engine;
    } catch (e) {
      console.log(e);
      console.log('WARNING: engine %s specified but module %s could not be loaded', engineName, moduleName);
    }
  });

  //
  // load plugins:
  //
  plugins = _.map(script.config.plugins, function loadPlugin(pluginConfig, pluginName) {
    var moduleName = 'artillery-plugin-' + pluginName;
    try {
      var Plugin = require(moduleName);
      var plugin = new Plugin(script.config, ee);
      plugin.__name = pluginName;
      return plugin;
    } catch (e) {
      console.log('WARNING: plugin %s specified but module %s could not be loaded', pluginName, moduleName);
    }
  });

  ee.run = function () {
    run(runnableScript, ee, opts);
  };
  return ee;
}

function run(script, ee, options) {
  var intermediate = Stats.create();
  var aggregate = Stats.create();

  var phaser = createPhaser(script.config.phases);
  phaser.on('arrival', function () {
    runScenario(script, intermediate, aggregate);
  });
  phaser.on('phaseStarted', function (spec) {
    ee.emit('phaseStarted', spec);
  });
  phaser.on('phaseCompleted', function (spec) {
    ee.emit('phaseCompleted', spec);
  });
  phaser.on('done', function () {
    debug('All phases launched');

    var doneYet = setInterval(function checkIfDone() {
      if (pendingScenarios === 0) {
        if (pendingRequests !== 0) {
          debug('DONE. Pending requests: %s', pendingRequests);
        }

        Report.aggregate = aggregate.report();
        clearInterval(doneYet);
        clearInterval(periodicStatsTimer);
        intermediate.free();
        aggregate.free();

        //
        // Add plugin reports to the final report
        //
        _.each(plugins, function (plugin) {
          if (typeof plugin.report === 'function') {
            var report = plugin.report();
            if (report) {
              if (report.length) {
                _.each(report, function insertIntermediateReport(a) {
                  if (a.timestamp === 'aggregate') {
                    Report.aggregate[plugin.__name] = a.value;
                  } else {
                    var ir = _.findWhere(Report.intermediate, { timestamp: a.timestamp });
                    ir[plugin.__name] = a.value;
                  }
                });
              } else {
                Report.aggregate[plugin.__name] = report;
              }
            }
          }
        });

        return ee.emit('done', Report);
      } else {
        debug('Pending requests: %s', pendingRequests);
        debug('Pending scenarios: %s', pendingScenarios);
      }
    }, 500);
  });

  var periodicStatsTimer = setInterval(function () {
    var report = intermediate.report();
    Report.intermediate.push(report);
    intermediate.reset();
    ee.emit('stats', report);
  }, options.periodicStats * 1000);

  phaser.run();
}

function runScenario(script, intermediate, aggregate) {
  var start = process.hrtime();

  //
  // Compile scenarios if needed
  //
  if (!compiledScenarios) {
    _.each(script.scenarios, function (scenario) {
      if (!scenario.weight) {
        scenario.weight = 1;
      }
    });

    picker = wl(script.scenarios);

    scenarioEvents = new EventEmitter();
    scenarioEvents.on('started', function () {
      pendingScenarios++;
    });
    scenarioEvents.on('error', function (errCode) {
      intermediate.addError(errCode);
      aggregate.addError(errCode);
    });
    scenarioEvents.on('request', function () {
      intermediate.newRequest();
      aggregate.newRequest();

      pendingRequests++;
    });
    scenarioEvents.on('match', function () {
      intermediate.addMatch();
      aggregate.addMatch();
    });
    scenarioEvents.on('response', function (delta, code, uid) {
      intermediate.completedRequest();
      intermediate.addLatency(delta);
      intermediate.addCode(code);

      var entry = [Date.now(), uid, delta, code];
      intermediate.addEntry(entry);
      aggregate.addEntry(entry);

      aggregate.completedRequest();
      aggregate.addLatency(delta);
      aggregate.addCode(code);

      pendingRequests--;
    });

    compiledScenarios = _.map(script.scenarios, function (scenarioSpec) {
      var name = scenarioSpec.engine || 'http';
      var engine = _.find(engines, function (e) {
        return e.__name === name;
      });
      var tasks = _.map(scenarioSpec.flow, function (rs) {
        if (rs.think) {
          return engineUtil.createThink(rs);
        }
        return engine.step(rs, scenarioEvents);
      });
      return engine.compile(tasks, scenarioSpec.flow, scenarioEvents);
    });
  }

  intermediate.newScenario();
  aggregate.newScenario();

  var i = picker()[0];

  debug('picking scenario %s (%s) weight = %s', i, script.scenarios[i].name, script.scenarios[i].weight);

  var scenarioStartedAt = process.hrtime();
  var scenarioContext = createContext(script);
  var finish = process.hrtime(start);
  var runScenarioDelta = finish[0] * 1e9 + finish[1];
  debugPerf('runScenarioDelta: %s', Math.round(runScenarioDelta / 1e6 * 100) / 100);
  compiledScenarios[i](scenarioContext, function (err, context) {
    pendingScenarios--;
    if (err) {
      debug(err);
    } else {
      var scenarioFinishedAt = process.hrtime(scenarioStartedAt);
      var delta = scenarioFinishedAt[0] * 1e9 + scenarioFinishedAt[1];
      intermediate.addScenarioLatency(delta);
      aggregate.addScenarioLatency(delta);
      intermediate.completedScenario();
      aggregate.completedScenario();
    }
  });
}

/**
 * Create initial context for a scenario.
 */
function createContext(script) {
  var INITIAL_CONTEXT = {
    vars: {
      target: script.config.target
    },
    funcs: {
      $randomNumber: $randomNumber,
      $randomString: $randomString
    }
  };
  var result = _.cloneDeep(INITIAL_CONTEXT);

  //
  // variables from payloads
  //
  if (script.config.payload) {
    _.each(script.config.payload, function (el) {
      var i = _.random(0, el.data.length - 1);
      var row = el.data[i];
      _.each(el.fields, function (fieldName, j) {
        result.vars[fieldName] = row[j];
      });
    });
  }

  //
  // inline variables
  //
  if (script.config.variables) {
    _.each(script.config.variables, function (v, k) {
      var val = undefined;
      if (_.isArray(v)) {
        val = _.sample(v);
      } else {
        val = v;
      }
      result.vars[k] = val;
    });
  }

  result._uid = uuid.v4();
  return result;
}

//
// Generator functions for template strings:
//
function $randomNumber(min, max) {
  return _.random(min, max);
}

function $randomString(length) {
  return Math.random().toString(36).substr(2, length);
}
