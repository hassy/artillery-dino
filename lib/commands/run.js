/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

var url = require('url');
var util = require('util');
var uuid = require('node-uuid');
var aws = require('aws-sdk');
var debug = require('debug')('run');
var debugV = require('debug')('runV');
var L = require('lodash');
var sl = require('stats-lite');

var config;

module.exports = run;

var template = {
  config: {
    target: '',
    phases: [
      { duration: 1, arrivalRate: 1 }
    ],
    statsInterval: 2
  },
  scenarios: [
    {
      flow: [
        {
          loop: [
            {
              get: {
                url: '/'
              }
            }
          ],
          count: 1
        }
      ]
    }
  ]
};

aws.config.apiVersions = {
  lambda: '2015-03-31'
};

aws.config.update({
  region: process.env.AWS_REGION || 'eu-west-1'
});

var lambda = new aws.Lambda();
var interval = null;

var sns = new aws.SNS();
var sqs = new aws.SQS();

var currentUuid;
var totalSent = 0;
var numLambdas = 0;
var lambdasFinished = 0;
var maxRequests = 0;
var reports = [];
var errors = [];
var codes = [];
var finalStats = [];
var steps = 0;
var seen = [];
var startedAt;

function run(yargs, argv) {
  var argv2 = yargs
        .usage('Usage: $0 run [options] <target>')
        .option('t', {description: 'target - target URL', type: 'string'})
        .demand('t')
        .option('n', {description: 'requests - number of requests to send', type: 'number'})
        .demand('n')
        .option('c', {description: 'connections - number of connections to open', type: 'number'})
        .option('l', {description: 'lambdas - number of lambdas to run (between 1 and 100)', type: 'number'})
        .demand('l')
        .option('k', {description: 'insecure - turn off TLS verification', type: 'boolean'})
        .help('help')
        .epilog('Example:\n  $0 run -c 10 -n 500 -l 20 https://staging.myapp.io/\n  Send 5000 requests using 10 connections from 20 lambdas\n  (for a total of 10 * 500 * 20 = 100,000 requests)')
        .argv;

  debugV(argv2);

  try {
    config = require('../../config.json');
  } catch (err) {
    console.log(err, err.stack);
    console.log('Can\'t find config.json - make sure to run "dino setup" first');
    return;
  }

  try {
    var parsed = url.parse(argv2.t);
  } catch (e) {
    console.log('Cannot parse "%s" as an URL', argv2.t);
    return;
  }

  if (!parsed.protocol || !/^https?:$/i.test(parsed.protocol)) {
    console.log('target must be a HTTP or HTTPS URL');
    return;
  }

  numLambdas = Number(argv2.l);
  if (numLambdas === NaN) {
    console.log('-l must be a number');
    return;
  }
  if (numLambdas < 1 || numLambdas > 100) {
    console.log('-l must be a value between 1 and 100');
    return;
  }

  console.log(`
                          _._
                        _/:|:
                       /||||||.
                       ||||||||.
                      /|||||||||:
   _ _               /|||||||||||
 _| |_|___ ___      .|||||||||||||
| . | |   | . |     | ||||||||||||:
|___|_|_|_|___|   _/| |||||||||||||:_=---.._
                  | | |||||:'''':||  '~-._  '-.
                _/| | ||'         '-._   _:    ;
                | | | '               '~~     _;
                | '                _.=._    _-~
             _.~                  {     '-_'
     _.--=.-~       _.._          {_       }
 _.-~   @-,        {    '-._     _. '~==+  |
('          }       \\_      \\_.=~       |  |
\`======='  /_         ~-_    )         <_oo_>
\`-----~~/ /'===...===' +   /
         <_oo_>         /  //
                       /  //
                      <_oo_>
`);


  var script = createScript(argv2, parsed);

  debug(JSON.stringify(script, null, 4));

  maxRequests = argv2.c * numLambdas * argv2.n;
  console.log('Expecting to make up to %s requests', maxRequests);
  debug('maxRequests: %s', maxRequests);

  currentUuid = uuid.v4();
  debug('currentUuid set to %s', currentUuid);
  var payload = {
    script: script,
    TopicArn: config.TopicArn,
    uid: currentUuid
  };

  var params = {
    FunctionName: 'dinoRun',
    InvocationType: 'RequestResponse',
    LogType: 'Tail',
    Payload: JSON.stringify(payload)
  };

  for(var i = 0; i < numLambdas; i++) {
    lambda.invoke(params, function(err, data) {
      if (err) {
        console.log(err, err.stack);
        throw err;
      }

      if (data.FunctionError) {
        // TODO: Handle this properly
        console.log(data);
        console.log(new Buffer(data.LogResult, 'base64').toString());
        throw new Error();
      }
      debug('lambda.invoke callback data:\n%j', data);
    });
  }
  startedAt = Date.now();
  interval = setInterval(recv, 500);

  return;
}

function createScript(opts, parsedURL) {
  var result = JSON.parse(JSON.stringify(template));

  result.config.target = util.format(
    '%s//%s',
    parsedURL.protocol,
    parsedURL.host);

  if (opts.k) {
    result.config.tls = {
      rejectUnauthorized: false
    };
  }

  result.config.phases[0].arrivalRate = opts.c || 1;
  result.scenarios[0].flow[0].count = opts.n;
  result.scenarios[0].flow[0].loop[0].get.url = parsedURL.path;
  return result;
}

function recv() {
  process.stdout.write('.');
  var params = {
    QueueUrl: config.QueueUrl,
    MaxNumberOfMessages: 10
  };

  sqs.receiveMessage(params, onMessage);
}

function onMessage(err, data) {
  if (err) {
    console.log(err);
    return;
  }

  if (data && data.Messages && data.Messages.length > 0) {
    data.Messages.forEach(function processMessage (msgData) {
      if (seen.indexOf(msgData.MessageId) > -1) {
        return;
      }
      seen.push(msgData.MessageId);

      var body = JSON.parse(msgData.Body);
      var msg = JSON.parse(body.Message);

      debugV('msg.uid = %s', msg.uid);

      if (msg.uid === currentUuid) {
        if (msg.type === 'final') {
          lambdasFinished++;
          //console.log('A Lambda is done, remaining: %s', numLambdas - lambdasFinished);

          finalStats.push(msg.stats.aggregate);

          if (lambdasFinished >= numLambdas) {
            // Let any outstanding intermediate reports come through
            printFinalReport(finalStats);
            process.stdout.write('Spinning down...');
            setTimeout(function() {
              clearInterval(interval);
              console.log('\nDino ran for %ss', round((Date.now() - startedAt) / 1000, 1));
            }, 1000 * 2);
          }
        } else {
          var prev = totalSent;
          totalSent += msg.stats.requestsCompleted;
          var delta = totalSent - prev;
          if (totalSent >= (maxRequests / 10) * steps) {
            steps++;
            console.log('\nRequests processed so far: %s', totalSent);

            reports.push(msg.stats.latencies);
            codes.push(msg.stats.codes);
            errors.push(msg.stats.errors);

            printReport(reports);
            // The numbers don't always add up - look at SQS ordering
            //printCodes(codes);
            //printErrors(errors);
            console.log();
          }
        }
      }

      if (msg.uid === currentUuid) {
        var params = {
          QueueUrl: config.QueueUrl,
          ReceiptHandle: msgData.ReceiptHandle
        };
        debugV('deleting message with handle %s', msgData.ReceiptHandle);
        sqs.deleteMessage(params, function onDelete(err2, data) {
          if (err2) {
            console.log(err2, err2.stack);
          }
        });
      }
    });
  }
}

function printReport(reports) {
  var latencies = L.map(L.flatten(reports), function(rec) {
    return rec[2];
  });

  var min = round(L.min(latencies) / 1e6, 1);
  var max = round(L.max(latencies) / 1e6, 1);
  var median = round(sl.median(latencies) / 1e6, 1);
  var p95 = round(sl.percentile(latencies, 0.95) / 1e6, 1);
  var p99 = round(sl.percentile(latencies, 0.99) / 1e6, 1);

  console.log('Response times so far:');
  console.log('  min: %s', min);
  console.log('  max: %s', max);
  console.log('  p50: %s', median);
  console.log('  p95: %s', p95);
  console.log('  p99: %s', p99);
}

function printCodes(codes) {
  var total = L.reduce(codes,
                      function(acc, rec) {
                        // rec is like: {'200': 100, '500': 10} etc
                        L.each(rec, function(v, k) {
                          if (acc[k]) {
                            acc[k] += v;
                          } else {
                            acc[k] = v;
                          }
                        });
                        return acc;
                      }, {});

  if (L.keys(total).length > 0) {
    L.each(total, function(v, k) {
      console.log('Response codes:');
      console.log('  %s - %s', k, v);
    });
  }
}

function printErrors(errors) {
  var total = L.reduce(errors,
                      function(acc, rec) {
                        // rec is like: {'ECONNRESET': 100, 'ENOTFOUND': 10} etc
                        L.each(rec, function(v, k) {
                          if (acc[k]) {
                            acc[k] += v;
                          } else {
                            acc[k] = v;
                          }
                        });
                        return acc;
                      }, {});

  if (L.keys(total).length > 0) {
    console.log('Errors:');
    L.each(total, function(v, k) {
      console.log('%s - %s', k, v);
    });
  }
}

function round(number, decimals) {
  var m = Math.pow(10, decimals);
  return Math.round(number * m) / m;
}

function printFinalReport(finalStats) {
  debug('finalStats: %j', finalStats);
  var totalRequests = L.reduce(finalStats, function(acc, stats) {
    acc += stats.requestsCompleted;
    return acc;
  }, 0);

  console.log('\nTotal requests processed: %s', totalRequests);

  printReport(reports);
  printCodes(L.map(finalStats, function(stats) { return stats.codes; }));
  printErrors(L.map(finalStats, function(stats) { return stats.errors; }));
  console.log();
}
