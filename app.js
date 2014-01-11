var async = require('async')
  , git = require('./git')
  , sleep = require('sleep')
  , winston = require('winston')
  , mdb = require('./mdb')
// Actions
  , compileActivities = require('./actions/compileActivities');


// For now, just run through main loop once.

function main () {
    winston.info('Starting main loop.');
	async.series([
		// Update all Git Repos.
		function (callback) {
			git.actOnGitFiles(git.updateGitAction, callback);
		},

		// Compile TeX files in all repos and save the results.
		function (callback) {
			git.actOnGitFiles(compileActivities, callback)
		}
	], function (err) {
        if (err) {
            winston.error(err);
        }
    });
}



mdb.initialize();
main();
