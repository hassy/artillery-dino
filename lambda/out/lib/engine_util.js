/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

var debug = require('debug')('engine_util');
// const hogan = require('hogan.js');
// const traverse = require('traverse');
// const esprima = require('esprima');
var L = require('lodash');
// const vm = require('vm');
var A = require('async');

module.exports = {
  createThink: createThink,
  createLoopWithCount: createLoopWithCount
};

function createThink(requestSpec) {
  var thinktime = requestSpec.think * 1000;

  var f = function(context, callback) {
    debug('think %s -> %s', requestSpec.think, thinktime);
    setTimeout(function() {
      callback(null, context);
    }, thinktime);
  };

  return f;
}

// template: template,
// evil: evil
function createLoopWithCount(count, steps) {
  return function aLoop(context, callback) {
    var i = 0;
    var newContext = context;
    A.whilst(function test() {
      return i < count;
    }, function repeated(cb) {
      var zero = function zero(cb2) {
        return cb2(null, newContext);
      };
      var steps2 = L.flatten([zero, steps]);
      A.waterfall(steps2, function (err, context2) {
        i++;
        newContext = context2;
        return cb(err, context2);
      });
    }, function (err, finalContext) {
      return callback(err, finalContext);
    });
  };
}

// function template(o, context) {
//   let result;
//   if (typeof o === 'object') {
//     result = traverse(o).map(function(x) {

//       if (typeof x === 'string') {
//         this.update(template(x, context));
//       } else {
//         return x;
//       }
//     });
//   } else {
//     if (!/{{/.test(o)) {
//       return o;
//     }
//     const funcCallRegex = /{{\s*(\$[A-Za-z0-9_]+\s*\(\s*.*\s*\))\s*}}/;
//     let match = o.match(funcCallRegex);
//     if (match) {
//       // This looks like it could be a function call:
//       const syntax = esprima.parse(match[1]);
//       // TODO: Use a proper schema for what we expect here
//       if (syntax.body && syntax.body.length === 1 &&
//           syntax.body[0].type === 'ExpressionStatement') {
//         let funcName = syntax.body[0].expression.callee.name;
//         let args = L.map(syntax.body[0].expression.arguments, function(arg) {
//           return arg.value;
//         });
//         if (funcName in context.funcs) {
//           return template(o.replace(funcCallRegex, context.funcs[funcName].apply(null, args)), context);
//         }
//       }
//     } else {
//       if (!o.match(/{{/)) {
//         return o;
//       }

//       result = (hogan.compile(o)).render(context.vars);
//     }
//   }
//   return result;
// }

// // Presume code is valid JS code (i.e. that it has been checked elsewhere)
// function evil(sandbox, code) {
//   let context = vm.createContext(sandbox);
//   let script = new vm.Script(code);
//   return script.runInContext(context);
// }
