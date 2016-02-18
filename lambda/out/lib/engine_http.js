/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

var async = require('async');
var _ = require('lodash');
var request = require('request');
//const jsonpath = require('JSONPath');
var jsonpath = {};
var debug = require('debug')('http');
var VERSION = require('../package.json').version;
var USER_AGENT = 'artillery ' + VERSION + ' (https://artillery.io)';
var engineUtil = require('./engine_util');
//const template = engineUtil.template;
var template = function template(o, context) {
  return o;
};
var http = require('http');
var https = require('https');
var fs = require('fs');
// const xml = require('libxmljs');
var xml = {};

module.exports = HttpEngine;

function HttpEngine(config) {
  this.config = config;
}

HttpEngine.prototype.step = function step(requestSpec, ee) {
  var self = this;
  var config = this.config;

  if (requestSpec.loop) {
    var steps = _.map(requestSpec.loop, function (rs) {
      return self.step(rs, ee);
    });

    return engineUtil.createLoopWithCount(requestSpec.count || -1, steps);
  }

  var f = function f(context, callback) {

    var method = _.keys(requestSpec)[0].toUpperCase();
    var params = requestSpec[method.toLowerCase()];
    var uri = maybePrependBase(template(params.url, context), config);
    var tls = config.tls || {};
    var timeout = config.timeout || 10;

    var requestParams = _.cloneDeep(params);
    requestParams = _.extend(requestParams, {
      uri: uri,
      method: method,
      headers: {},
      timeout: timeout * 1000,
      jar: context._jar
    });
    requestParams = _.extend(requestParams, tls);

    if (params.json) {
      requestParams.json = template(params.json, context);
    } else if (params.body) {
      requestParams.body = template(params.body, context);
    }

    // Assign default headers then overwrite as needed
    var defaultHeaders = lowcaseKeys(config.defaults && config.defaults.headers ? config.defaults.headers : { 'user-agent': USER_AGENT });
    requestParams.headers = _.extend(defaultHeaders, lowcaseKeys(params.headers));
    var headers = _.foldl(requestParams.headers, function (acc, v, k) {
      acc[k] = template(v, context);
      return acc;
    }, {});

    requestParams.headers = headers;
    if (params.cookie) {
      _.each(params.cookie, function (v, k) {
        context._jar.setCookie(k + '=' + template(v, context), uri);
      });
    }

    if (config.http2) {
      requestParams.http2 = true;
    } else {
      requestParams.agent = context._agent;
    }

    debug('request: %j', requestParams);

    request(requestParams, function requestCallback(err, res, body) {
      if (err) {
        var errCode = err.code || err.message;
        ee.emit('error', errCode);
        debug(err);
        // this aborts the scenario
        return callback(err, context);
      }

      if (params.capture || params.match) {
        (function () {
          var parser = undefined;
          var extractor = undefined;
          if (isJSON(res)) {
            parser = parseJSON;
            extractor = extractJSONPath;
          } else if (isXML(res)) {
            parser = parseXML;
            extractor = extractXPath;
          } else if (params.capture && params.capture.json || params.match && params.match.json) {
            // TODO: We might want to issue some kind of a warning here
            parser = parseJSON;
            extractor = extractJSONPath;
          } else if (params.capture && params.capture.xpath || params.match && params.match.xpath) {
            // TODO: As above
            parser = parseXML;
            extractor = extractXPath;
          } else {
            // We really don't know what to do here.
            parser = parseJSON;
            extractor = extractJSONPath;
          }

          parser(res.body, function (err2, doc) {
            if (err2) {
              return callback(err2, null);
            }

            if (params.match) {
              var expr = params.match.json || params.match.xpath;
              var result = extractor(doc, expr);
              var expected = template(params.match.value, context);
              debug('match: %s, expected: %s, got: %s', expr, expected, result);
              if (result !== expected) {
                ee.emit('match', false, {
                  expected: expected,
                  got: result,
                  request: requestParams
                });
                if (params.match.strict) {
                  // it's not an error but we finish the scenario
                  return callback(null, context);
                }
              } else {
                ee.emit('match', true);
              }
            }

            if (params.capture) {
              var expr = params.capture.json || params.capture.xpath;
              var result = extractor(doc, expr);
              context.vars[params.capture.as] = result;
              debug('capture: %s = %s', params.capture.as, result);

              if (params.capture.transform) {
                var result2 = engineUtil.evil(context.vars, params.capture.transform);
                context.vars[params.capture.as] = result2;
                debug('transform: %s = %s', params.capture.as, context.vars[params.capture.as]);
              }
            }

            debug('context.vars.$ = %j', doc);
            context.vars.$ = doc;
            context._successCount++;
            context._pendingRequests--;
            return callback(null, context);
          });
        })();
      } else {
        context.vars.$ = res.body;
        context._successCount++;
        context._pendingRequests--;
        return callback(null, context);
      }
    }).on('request', function (req) {
      ee.emit('request');

      var startedAt = process.hrtime();

      req.on('response', function updateLatency(res) {
        var code = res.statusCode;
        var endedAt = process.hrtime(startedAt);
        var delta = endedAt[0] * 1e9 + endedAt[1];
        ee.emit('response', delta, code, context._uid);
      });
    }).on('end', function () {});
  };

  return f;
};

HttpEngine.prototype.compile = function compile(tasks, scenarioSpec, ee) {
  var config = this.config;
  var tls = config.tls || {};

  return function scenario(initialContext, callback) {
    //
    // Calculate the number of steps we expect to take.
    //
    initialContext._successCount = 0;
    initialContext._pendingRequests = _.size(_.reject(scenarioSpec, function (rs) {
      return typeof rs.think === 'number';
    }));

    initialContext._jar = request.jar();

    if (!config.http2) {
      var agentOpts = {
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 1,
        maxFreeSockets: 1
      };

      if (/^https/i.test(config.target)) {
        if (tls.pfx) {
          agentOpts.pfx = fs.readFileSync(tls.pfx);
        }
        initialContext._agent = new https.Agent(agentOpts);
      } else {
        initialContext._agent = new http.Agent(agentOpts);
      }
    }

    var steps = _.flatten([function zero(cb) {
      ee.emit('started');
      return cb(null, initialContext);
    }, tasks]);

    async.waterfall(steps, function scenarioWaterfallCb(err, context) {
      return callback(err, context);
    });
  };
};

function maybePrependBase(uri, config) {
  if (_.startsWith(uri, '/')) {
    return config.target + uri;
  } else {
    return uri;
  }
}

/*
 * Given a dictionary, return a dictionary with all keys lowercased.
 */
function lowcaseKeys(h) {
  return _.transform(h, function (result, v, k) {
    result[k.toLowerCase()] = v;
  });
}

/*
 * Given a response object determine if it's JSON
 */
function isJSON(res) {
  debug('isJSON: content-type = %s', res.headers['content-type']);
  return res.headers['content-type'] && /^application\/json/.test(res.headers['content-type']);
}

/*
 * Given a response object determine if it's some kind of XML
 */
function isXML(res) {
  return res.headers['content-type'] && (/^[a-zA-Z]+\/xml/.test(res.headers['content-type']) || /^[a-zA-Z]+\/[a-zA-Z]+\+xml/.test(res.headers['content-type']));
}

/*
 * Wrap JSON.parse in a callback
 */
function parseJSON(body, callback) {
  var r = undefined;
  try {
    if (typeof body === 'string') {
      r = JSON.parse(body);
    } else {
      r = body;
    }
    return callback(null, r);
  } catch (err) {
    return callback(err, null);
  }
}

/*
 * Wrap XML parser in a callback
 */
function parseXML(body, callback) {
  try {
    var doc = xml.parseXml(body);
    return callback(null, doc);
  } catch (err) {
    return callback(err, null);
  }
}

// doc is a JSON object
function extractJSONPath(doc, expr) {
  var result = jsonpath.eval(doc, expr)[0];
  return result;
}

// doc is an libxmljs document object
function extractXPath(doc, expr) {
  var result = doc.get(expr).text();
  return result;
}