var async = require('async')
  , findit = require("findit")
  , fs = require('fs')
  , git = require('./git')
  , sleep = require('sleep')
  , exec = require('child_process').exec
  , util = require('util')
  , mdb = require('./mdb')
  , crypto = require('crypto')
  , winston = require('winston');


git.initialize();

// Following commands will be replaced by environments so that Pandoc will receive raw blocks for them.
var replaceCommands = ["headline", "activitytitle"];

// For now, just run through main loop once.

function main () {
	async.series([
		// Update all Git Repos.
		function (callback) {
			git.actOnGitFiles(git.updateGitAction, callback);
		});

		// Compile TeX files in all repos and save the results.
		function (callback) {
			git.actOnGitFiles(compileAndStoreTexFiles, callback)
		}
	]);
}

function compileAndStoreTexFiles(repo, gitDirPath, callback) {
    var finder = findit(gitDirPath);
    var locals = {stopped: false, newActivityIds: []};

    finder.on('directory', function (dir, stat, stop) {
    	if (dir.startsWith(".")) {
    		// Don't navigate hidden folders.
    		stop();
    	}
    });
    finder.on('file', function(path, stat) {
    	if (path.startsWith('.')) {
    		// Don't do anything with hidden files.
    		return;
    	}
    	else if (path.endsWith('.tex')) {
    		// TODO: Completely replace GitRepo activity list each time; holding on to historical activities disconnected from GitRepos
    		var htmlPath = path.substring(0, path.length - 4) + ".html";
    		// TODO: LaTeX is not trustable; this needs to be sandboxed using a Linux container or other mechanism before accepting user-generated content.
    		// Run .tex file through pandoc with appropriate filter.
    		async.map(replaceCommands, function(command, callback) {
    			exec(util.format("cat %s | sed -e 's/(\\\\%s)\\{([^\\}]*)\\}/\\\\begin\\{\\1}\\2\\\\end\\{\\1\\}' > %s", path, command), callback);
    		}, function (err) {
    			if (err) { callback (err) }
    			else {
		    		var filterPath = process.env.XIMERA_FILTER_PATH
		    		async.sequence([
		    			// Pandoc compilation.
		    			function (callback) {
							exec(util.format('pandoc --standalone --metadata=repoId:%d --parse-raw -f latex -t html --filter=%s %s %s', repo._id, filterPath, path, htmlPath), callback);
						},
						// Hash file.
						function (callback) {
							var readStream = fs.createReadStream(htmlPath);
							var hasher = crypto.createHash('sha1');
							hasher.setEncoding('hex');							
							readStream.on('end', function() {
							    hasher.end();
							    locals.hash = hasher.read();
							    callback();
							});
							readStream.pipe(hasher);
						},
						// Find activity entry if it exists.
						function (callback) {
						    mdb.Activity.findOne({hash: hash}, function (err, activity) {
						    	if (err)  { callback(err); }
						    	else {
						    		locals.activity = activity;
						    		callback();
						    	}
						},
						// If activity doesn't exist, save file and create one.  Add activity id to new activity list.
						function (callback) {
					    	if (locals.activity) {
					    		// No need to load activity.
					    		newActivityIds.push(locals.activity._id);
					    	}
					    	else {
					    		var fileObjectId = ObjectId()
					    		copyLocalFileToGfs(htmlPath, fileObjectId, function (err) {
					    			if (err) callback (err);
					    			else {
							    		locals.activity = new Activity({
							    			htmlFileId: fileObjectId,
							    			fileHash: hash,
							    			repoId: repo._id
							    		});
							    		locals.activity.save(function (err) {
							  				if (err) callback (err);
							  				else {
							    				newActivityIds.push(locals.activity._id);							  					
							    				callback();
							  				}
							    		});
					    			}
					    		});						    							    		
					    	}							
						}],
						function (err) {
							if (err) {
								if (!locals.stopped) {
									locals.stopped = true;
									finder.stop();
									callback(err);						
								}
							}
						}
					);
    			}
    		});
    	}
    });

    find.on('end', function () {
    	if (!locals.stopped) {
	    	// Update GitRepo's list of activities to only reflect those we just loaded. (Deleted activities will disappear.)
	    	repo.currentActivityIds = newActivityIds;
	    	repo.save(callback);
	    }
    });
}

