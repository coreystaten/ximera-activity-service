
var async = require('async')
  , git = require('./git')
  , sleep = require('sleep')
  , winston = require('winston')
  , mdb = require('./mdb')
// Actions
  , compileActivities = require('./actions/compileActivities')
  , compileCourses = require('./actions/compileCourses');


if (!process.env.XIMERA_MONGO_DATABASE ||
    !process.env.XIMERA_MONGO_URL) {
    throw "Appropriate environment variables not set.";
}

function updateRepo(gitIdentifier) {
    mdb.GitRepo.findOne({gitIdentifier: gitIdentifier}).exec( function (err, repo) {

	async.series([
	    // Update all Git Repos.
	    function (callback) {
		winston.info( 'git.updateGitAction on ' + repo.gitIdentifier );
		git.actOnGitFiles([repo], git.updateGitAction, callback);
	    },
	    
	    // Compile TeX files in all repos and save the results.
	    function (callback) {
		winston.info( 'compileActivities on ' + repo.gitIdentifier );
		git.actOnGitFiles([repo], compileActivities, callback)
	    },
	    
            // Compile Xim files in all repos and save the results.
            function (callback) {
		winston.info( 'compileCourses on ' + repo.gitIdentifier );
		git.actOnGitFiles([repo], compileCourses, callback);
            },

	    // Record that this has been successful
	    function (callback) {
		winston.info( 'update gitrepo on ' + repo.gitIdentifier );
		mdb.GitRepo.update( repo, {$set: { needsUpdate : false }, $unset: { feedback : '' }}, {}, function( err, document ) {
		    callback(err);
		} );
	    }

	], function (err) {
            if (err) {
		mdb.GitRepo.update( repo, {$set: { feedback : err.toString('utf-8') }}, {}, function( err, document ) {} );
		winston.error(err.toString('utf-8'));
            }
            //process.exit();
	});

    });
}

mdb.initialize(function(error) {
    winston.info( "I am listening for work." );

    mdb.channel.on( 'update', function(message) {
	winston.info( "Updating " + message );
	updateRepo( message );
    });

    mdb.channel.on( 'create', function(message) {
	winston.info( "Creating " + message );
	// Creating is not different from updating
	updateRepo( message );
    });
});
