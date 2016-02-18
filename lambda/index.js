/*
 * The source code in this file is distributed under the terms of the
 * Apache License, Version 2.0. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 */

'use strict';

var aws = require('aws-sdk');
var runner = require('./out').runner;

var sns = new aws.SNS();

function publish(arn, msg, cb) {
  var params = {
    TopicArn: arn,
    Message: msg
  };

  return sns.publish(params, cb);
}

module.exports.handler = function(event, context) {
  var script = event.script;
  var uid = event.uid;
  var topicArn = event.TopicArn;

  var response = {
    intermediate: 0,
    uid: uid
  };

  console.log('event:\n%s', JSON.stringify(event, null, 2));

  var ee = runner(script);

  ee.on('stats', function(stats) {
    response.intermediate++;
    publish(topicArn,
            JSON.stringify({uid: uid, stats: stats, type: 'intermediate'}),
            function(err, data) {
              if (err) {
                console.log(err, err.stack);
                context.done(err, null);
              }
              console.log('stats pushed to SQS');
            });
  });

  ee.on('done', function(stats) {
    stats.intermediate = [];
    stats.latencies = [];
    if (stats.aggregate) {
      stats.aggregate.latencies = []; // otherwise will go over 256kb for longer tests - can still reconstruct from intermediates on the client
    }

    publish(topicArn,
            JSON.stringify({uid: uid, stats: stats, type: 'final'}),
            function(err, data) {
              if (err) {
                console.log(err, err.stack);
                response.stats = stats;
                publish(topicArn,
                        JSON.stringify({uid: uid, stats: {}}),
                        function() {});
                context.done(err, response);
              }
              console.log('done');
              context.done(null, response);
            });
  });

  ee.run();
};
