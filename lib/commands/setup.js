/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';

var aws = require('aws-sdk');
var A = require('async');
var fs = require('fs');

var SNS_TOPIC_NAME = 'artillery_lambda';
var SQS_QUEUE_NAME= 'artillery_lambda';

module.exports = setup;

var config = {};

aws.config.update({
  region: process.env.AWS_REGION || 'eu-west-1'
});

var sns = new aws.SNS();
var sqs = new aws.SQS();
var lambda = new aws.Lambda();

var role;

function setup(yargs, argv) {
  if (!process.env.AWS_REGION) {
    console.log('AWS_REGION not set, defaulting to eu-west-1');
  }

  if (!process.env.AWS_PROFILE) {
    console.log('AWS_PROFILE not set - setup may fail');
  }

  var argv2 = yargs
        .usage('Usage: $0 setup -r <role>')
        .option('r', {description: 'role - AWS role ARN for the lambda', type: 'string'})
        .demand('r')
        .help('help')
        .argv;

  var config = null;
  try {
    config = require('../../config.json');
  } catch (err) {
  }

  if (config) {
    console.log('config.json already exists. If you want to rerun setup delete it first');
    return;
  }

  role = argv2.r;

  A.waterfall([
    A.constant({}),
    createTopic,
    createQueue,
    getQueueArn,
    subscribeToTopic,
    setQueueAttr
  ], function(err, context) {
    if (err) {
      console.log(err, err.stack);
      return;
    }
    fs.writeFileSync('config.json', JSON.stringify(context, null, 2));
    console.log('+ SNS and SQS resources created. Creating the lambda...');
    createLambda();
  });
}

function createTopic(context, cb) {
  sns.createTopic({
    Name: SNS_TOPIC_NAME
  }, function(err, result) {
    if (err) {
      return cb(err, context);
    }
    context.TopicArn = result.TopicArn;
    return cb(null, context);
  });
}

function createQueue(context, cb) {
  sqs.createQueue({
    QueueName: SQS_QUEUE_NAME,
    Attributes: {
      VisibilityTimeout: '0',
      MessageRetentionPeriod: '300'
    }
  }, function(err, result) {
    if (err) {
      return cb(err, context);
    }

    context.QueueUrl = result.QueueUrl;
    return cb(null, context);
  });
}

function getQueueArn(context, cb) {
  sqs.getQueueAttributes({
    QueueUrl: context.QueueUrl,
    AttributeNames: ['QueueArn']
  }, function(err, result) {
    if (err) {
      return cb(err, context);
    }

    context.QueueArn = result.Attributes.QueueArn;
    return cb(null, context);
  });
}

function subscribeToTopic(context, cb) {
  sns.subscribe({
    TopicArn: context.TopicArn,
    Protocol: 'sqs',
    Endpoint: context.QueueArn
  }, function(err, result) {
    return cb(err, context);
  });
}

function setQueueAttr(context, cb) {
  var attrs = {
    Version: '2008-10-17',
    Id: context.QueueArn + '/SQSDefaultPolicy',
    Statement: [
      {
        Sid: 'Sid' + new Date().getTime(),
        Effect: 'Allow',
        Principal: {
          AWS: '*'
        },
        Action: 'SQS:SendMessage',
        Resource: context.QueueArn,
        Condition: {
          ArnEquals: {
            'aws:SourceArn': context.TopicArn
          }
        }
      }
    ]
  };

  sqs.setQueueAttributes({
    QueueUrl: context.QueueUrl,
    Attributes: {
      Policy: JSON.stringify(attrs)
    }
  }, function(err, result) {
    return cb(err, context);
  });
}

function createLambda() {
  // distribute with a zip - ready to push out
  var params = {
    Code: {
      ZipFile: fs.readFileSync('./lambda.zip')
    },
    FunctionName: 'dinoRun',
    Handler: 'index.handler',
    Role: role,
    Runtime: 'nodejs',
    Description: 'Project Dino runner - https://artillery.io',
    MemorySize: 512,
    Publish: true,
    Timeout: 300
  };

  lambda.createFunction(params, function(err, data) {
    if (err) {
      console.log(err, err.stack);
      return;
    }

    console.log(data);
    console.log('+ Lambda created');
    console.log('you can "dino run" now');
  });
}
