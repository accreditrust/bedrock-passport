/*
 * Copyright (c) 2012-2015 Digital Bazaar, Inc. All rights reserved.
 */
var async = require('async');
var passport = require('passport');
var bedrock = require('bedrock');
var brIdentity = require('bedrock-identity');
var docs = require('bedrock-docs');
var rest = require('bedrock-rest');
var url = require('url');
var views = require('bedrock-views');

var BedrockError = bedrock.tools.BedrockError;
var getDefaultViewVars = views.getDefaultViewVars;
var validate = require('bedrock-validation').validate;

// constants
var MODULE_NS = 'bedrock.services';

// module API
var api = {};
module.exports = api;

// add routes
bedrock.events.on('bedrock-express.configure.routes', addRoutes);

function addRoutes(app) {
  // creating new identities must be enabled via website flags
  var flags = bedrock.config.website.views.vars.clientData.flags;
  if(flags.enableCreateIdentity) {
    app.get('/join',
      function(req, res, next) {
        getDefaultViewVars(req, function(err, vars) {
          if(err) {
            return next(err);
          }
          vars.redirect = false;
          res.render('create.html', vars);
        });
    });

    app.post('/join',
      validate('services.session.postJoin'),
      function(req, res, next) {
        async.waterfall([
          function(callback) {
            api._createIdentity({}, req, callback);
          },
          function(results, callback) {
            req.body.sysIdentifier = results.identity.id;
            req.body.password = req.body.sysPassword;
            _login(req, res, next, function(err) {
              if(err) {
                return next(new BedrockError(
                  'Could not create a session for the newly created identity.',
                  MODULE_NS + '.AutoLoginFailed', {}, err));
              }
              // return identity
              res.set('Location', results.identity.id);
              res.json(201, results.identity);
            });
          }
        ], function(err) {
          if(err) {
            return next(err);
          }
        });
      });
  }

  app.get('/session/login', rest.makeResourceHandler());
  docs.annotate.get('/session/login', {hide: true});

  app.post('/session/login',
    validate('services.session.postLogin'),
    function(req, res, next) {
      _login(req, res, next, function(err, user, choice) {
        if(err) {
          return next(err);
        }
        var out = {};
        // multiple identities matched credentials
        if(!user) {
          out.email = choice.email;
          out.identities = choice.identities;
        } else {
          out.identity = user.identity;
        }
        res.json(out);
      });
  });
  docs.annotate.post('/session/login', {
    description: 'Perform a login by posting a username and password.',
    schema: 'services.session.postLogin',
    responses: {
      200: 'The login was successful.',
      400: 'The login was unsuccessful.'
    }
  });

  app.get('/session/logout',
    function(req, res, next) {
      if(req.session) {
        return req.session.destroy(function(err) {
          if(err) {
            next(err);
          }
          res.redirect('/');
        });
      }
      res.redirect('/');
  });
  docs.annotate.get('/session/logout', {
    description: 'Perform a logout which destroys the session cookie.',
    responses: {
      307: 'The logout was successful. The Location header contains ' +
        'the location of the post-logout resource.'
    }
  });

  app.post('/session/password/reset',
    validate('services.session.postPasswordReset'),
    function(req, res, next) {
      // either an identity slug or email address
      var identifier = req.body.sysIdentifier;
      async.waterfall([
        function(callback) {
          brIdentity.resolveIdentityIdentifier(identifier, callback);
        },
        function(identityIds, callback) {
          // try to set password for all identities until one is successful
          var success = 0;
          async.until(function() {return success !== 0;}, function(callback) {
            if(identityIds.length === 0) {
              success = -1;
              return callback();
            }
            var next = identityIds.shift();
            var identity = bedrock.tools.clone(req.body);
            identity.id = next;
            brIdentity.setIdentityPassword(
              {id: next}, identity, function(err) {
                if(!err) {
                  success = 1;
                }
                callback();
              });
          }, function(err) {
            callback(null, success === 1);
          });
        },
        function(success, callback) {
          if(!success) {
            return callback(new BedrockError(
              'The password reset failed for the given identity.',
              MODULE_NS + '.PasswordResetFailed', {
                sysIdentifier: req.body.sysIdentifier,
                httpStatusCode: 403,
                'public': true}));
          }
          callback();
        }
      ], function(err) {
        if(err) {
          return next(err);
        }
        res.send(204);
      });
  });
  docs.annotate.post('/session/password/reset', {
    description: 'Resets a password given an email address and passcode.',
    schema: 'services.session.postPasswordReset',
    responses: {
      204: 'The password reset was successful.',
      403: 'The password reset failed.'
    }
  });

  app.get('/session/passcode',
    validate({query: 'services.session.getPasscodeQuery'}),
    function(req, res, next) {
    getDefaultViewVars(req, function(err, vars) {
      if(err) {
        return next(err);
      }
      vars.redirect = false;
      if('passcode' in req.query) {
        vars.clientData.sysPasscode = req.query.passcode;
      }
      res.render('passcode.html', vars);
    });
  });
  docs.annotate.get('/session/passcode', {hide: true});

  app.post('/session/passcode',
    validate('services.session.postPasscode'),
    function(req, res, next) {
      var identifier = req.body.sysIdentifier;
      async.waterfall([
        function(callback) {
          brIdentity.resolveIdentityIdentifier(identifier, callback);
        },
        function(identityIds, callback) {
          // identity not found
          if(identityIds.length === 0) {
            return callback(new BedrockError(
              'The given email address is not registered.',
              MODULE_NS + '.IdentityNotFound', {
                sysIdentifier: req.body.sysIdentifier,
                httpStatusCode: 404,
                'public': true
              }));
          }
          // look up identities
          var query = {id: {$in: []}};
          identityIds.forEach(function(identityId) {
            query.id.$in.push(bedrock.db.hash(identityId));
          });
          brIdentity.getIdentities(
            null, query, {identity: true}, function(err, records) {
              if(err) {
                return callback(err);
              }
              // send passcode for every identity match
              var identities = [];
              records.forEach(function(record) {
                identities.push(record.identity);
              });
              // determine passcode usage based on query param
              var usage = 'reset';
              if(req.query.usage === 'verify') {
                usage = 'verify';
              } else if(req.query.usage === 'reset') {
                usage = 'reset';
              }
              brIdentity.sendIdentityPasscodes(
                identities, usage, callback);
            });
        }
      ], function(err) {
        if(err) {
          return next(err);
        }
        res.send(204);
      });
  });
  docs.annotate.post('/session/passcode', {
    description: 'Send a password reset passcode to the email associated ' +
      'with the given system identifier.',
    schema: 'services.session.postPasscode',
    responses: {
      204: 'The passcode was successfully transmitted to the registered ' +
        'email address.',
      404: 'The given system identifier does not exist in the system.'
    }
  });
}

bedrock.events.on('bedrock-express.configure.errorHandlers', function(app) {
  // handle permission denied by sending login page
  app.use(function(err, req, res, next) {
    if(err.name !== 'bedrock.website.PermissionDenied') {
      return next(err);
    }

    // don't send login page if user agent doesn't accept html or if it's an
    // XHR request
    if(!(req.accepts('html') && !req.xhr)) {
      return next(err);
    }

    // don't send login page if the method isn't GET or a POST using
    // content type 'application/x-www-form-urlencoded'
    // TODO: express 4.0 supports alias req.is('urlencoded')
    if(!(req.method === 'GET' ||
      (req.method === 'POST' && req.is('application/x-www-form-urlencoded')))) {
      return next(err);
    }

    // not authenticated, send login page
    getDefaultViewVars(req, function(err, vars) {
      if(err) {
        return next(err);
      }

      // queue current request if not to /session/login
      var parsed = url.parse(req.url, true);
      if(parsed.pathname !== '/session/login') {
        vars.clientData.queuedRequest = {
          method: req.method,
          url: req.protocol + '://' + req.get('Host') + req.url,
          body: req.body || {}
        };
      }
      res.render('main.html', vars);
    });
  });
});

/**
 * Identity creation service. Used by normal and testing services.
 */
api._createIdentity = function(options, req, callback) {
  var identityId = brIdentity.createIdentityId(req.body.sysSlug);
  async.auto({
    createIdentity: function(callback) {
      // create identity
      var identityId = brIdentity.createIdentityId(req.body.sysSlug);
      var identity = {
        '@context': bedrock.config.constants.CONTEXT_URL,
        id: identityId,
        sysSlug: req.body.sysSlug,
        label: req.body.label,
        email: req.body.email,
        sysPassword: req.body.sysPassword
      };
      brIdentity.createIdentity(
        null, identity, function(err, record) {
        if(err) {
          return callback(err);
        }
        callback(null, record.identity);
      });
    }
  }, function(err, results) {
    if(err) {
      if(bedrock.db.isDuplicateError(err)) {
        err = new BedrockError(
          'Could not create identity, it is a duplicate.',
          MODULE_NS + '.DuplicateIdentity', {
            identity: identityId,
            'public': true,
            httpStatusCode: 400
          });
      }
      return callback(err);
    }
    // result details
    var details = {identity: results.createIdentity};
    // schedule identity created event
    bedrock.events.emitLater({
      type: 'brIdentity.created',
      details: details
    });
    callback(null, details);
  });
};

// perform login
function _login(req, res, next, callback) {
  passport.authenticate('bedrock.password', function(err, user, info) {
    if(!user) {
      // multiple identity matches
      if(info.matches) {
        // get mapping of identity ID to identity
        var choice = {
          email: info.email,
          identities: {}
        };
        return async.forEach(info.matches, function(id, callback) {
          brIdentity.getIdentity(
            null, id, function(err, identity) {
              if(err) {
                return callback(err);
              }
              choice.identities[id] = identity;
              callback();
            });
        }, function(err) {
          if(err) {
            return next(err);
          }
          callback(null, false, choice);
        });
      }
      // some other error
      err = new BedrockError(
        'The email address and password combination ' +
        'you entered is incorrect.', MODULE_NS + '.InvalidLogin',
        {'public': true, httpStatusCode: 400});
    }
    if(err) {
      return next(err);
    }
    req.logIn(user, function(err) {
      callback(err, user);
    });
  })(req, res, next);
}
