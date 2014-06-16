var async = require('async');
var Grid = require('gridfs-stream');
var mongoose = require('mongoose');
var temp = require("temp");
var fs = require("fs");
var git = require("./git-basic")
var path = require('path');
var wrench = require('wrench');
var winston = require('winston');
var fstream = require('fstream');
var exec = require('child_process').exec;
var mdb = require('./mdb');
var util = require('util');
var _ = require('underscore');

temp.track();

exports = module.exports;

var readGridFile = function(id, callback) {
    var locals = {data: new Buffer(0)};
    var readStream = mdb.gfs.createReadStream({_id: id});
    readStream.on('error', function (err) {
        winston.info("error in readGridFile");
        try {
            locals.err = err;
        }
        catch (e) {
            winston.info("ERROR in error: %s", e);
        }
    });
    readStream.on('end', function () {
        winston.info("end in readGridFile");
        try {
            if (locals.err) callback(err);
            else callback(null, locals.data.toString('binary'));
        }
        catch (e) {
            winston.info("ERROR in end: %s", e);
        }
    });
    readStream.on('data', function (data) {
        winston.info("data in readGridFile");
        try {
            locals.data = Buffer.concat([locals.data, new Buffer(data)]);
        }
        catch (e) {
            winston.info("ERROR in data: %s", e);
        }
    });
};

var writeGridFile = function(id, data, callback) {
    var writeStream = mdb.gfs.createWriteStream({_id: id, mode: 'w'});
    var locals = {};
    writeStream.on('error', function (err) {
        locals.err = err;
    });
    writeStream.on('close', function () {
        if (locals.err) callback(err);
        else callback();
    });

    writeStream.write(data);
    writeStream.end();
};


// TODO: Detect errors in repositories, and reclone if any.
exports.actOnGitFiles = function actOnGitFiles(action, callback) {
    var locals = {};

    winston.info('Acting on git files with ', util.inspect(action));

    winston.info('Finding all GitRepos.');
    mdb.GitRepo.find(function (err, repos) {
        winston.info('Found %d repos; mapping action.', repos.length);

	// BADBAD: ignore some broken repos
	repos = _.filter( repos, function(repo) { return !repo.gitIdentifier.match( 'serge' ) } );

        async.mapSeries(repos, function (repo, callback) {
            var locals = {};
            var repoUrl = 'https://github.com/' + repo.gitIdentifier + '.git';
            winston.info('Mapping to repo %s at %s', repo.gitIdentifier.toString(), repoUrl);

            async.series([
                // Find out if archive file is in GFS.
                function (callback) {
                    //TODO: Temporary hack: always clone on the pull action, since corruption is sometimes happening?
                    if (util.inspect(action) === '[Function: updateGitAction]') {
                        locals.inGfs = false;
                        callback();
                    }
                    else {
                        if (repo.file) {
                            winston.info("Searching for archive file %s in GFS.", repo.gitIdentifier.toString());
                            mdb.gfs.files.find({ _id: repo.file }).count(function (err, count) {
                                if (err) { callback(err); }
                                else {
                                    locals.inGfs = count > 0;
                                    callback();
                                }
                            });
                        }
                        else {
                            winston.info("Archive not yet cloned.");
                            locals.inGfs = false;
                            callback();
                        }
                    }
                },

                function (callback) {
                    // If archive file is in GFS, pull it out and unzip it.
                    if (locals.inGfs) {
                        winston.info("Archive file for %s found in GFS.", repo.gitIdentifier.toString());
                        async.series([
                            // Pulling the file out.
                            function (callback) {
                                locals.archivePath = temp.path() + ".tar";
                                winston.info("Loading file %s from GFS to %s", repo.file.toString(), locals.archivePath);
                                try {
                                readGridFile(repo.file, function (err, data) {
                                    try {
                                    if (err) callback(err);
                                    else {
                                        winston.info("Writing grid file locally to %s", locals.archivePath);
                                        fs.writeFile(locals.archivePath, data, 'binary', callback);
                                    }
                                    }
                                    catch (e) {
                                        winston.info("Error in readGridFile callback: %s", e);
                                    }
                                });
                                }
                                catch (e) {
                                    winston.info("Error reading grid file: %s", e);
                                }
                            },
                            // Unpacking temporary file.
                            function (callback) {
                                winston.info('Unpacking');
                                locals.gitDirPath = temp.path();
                                exec(util.format('(mkdir %s && tar -C %s -xvf %s)', locals.gitDirPath, locals.gitDirPath, locals.archivePath), callback);
                            },
                            ],
                            function (err) {
                                if (err) {callback(err)}
                                else {callback();}
                            });
                    }
                    // Otherwise, clone it and save it.
                    else {
                        locals.gitDirPath = temp.path();
                        winston.info("Archive file for %s not found; cloning from repository to %s.", repo.gitIdentifier.toString(), locals.gitDirPath);
                        git.clone(repoUrl, locals.gitDirPath, function (err) {
                            if (err) { callback(err); }
                            else {
                                winston.info("Repository successfully cloned.");
                                exports.updateGitAction(repo, locals.gitDirPath, callback);
                            }
                        });
                    }
                },

                // Perform the action.
                function (callback) {
                    winston.info("Performing action on %s", repo.gitIdentifier.toString());
                    action(repo, locals.gitDirPath, function (err, result) {
                        if (err) { callback(err) }
                        else {
                            locals.result = result;
                            callback();
                        }
                    });
                }],
                // Final callback; attempt to perform cleanup and return result.
                function (err) {
                    if (locals.archivePath) {
                        winston.info("Attempting cleanup of temporary file %s", locals.archivePath);
                        //fs.unlink(locals.archivePath, function (err) {if (err) {winston.error(err)}});
                    }

                    var deletePath;
                    if (locals.extractPath) {
                        deletePath = locals.extractPath;
                    }
                    else {
                        deletePath = locals.gitDirPath;
                    }
                    winston.info("Attempting cleanup of temporary directory %s", deletePath);
                    //wrench.rmdirRecursive(deletePath, false, function (err) {if (err) {winston.error(err);}});

                    winston.info("Cleanup done");
                    callback(err, {repo: repo, result: locals.result});
                }
            );
        },
        function (err) {
            winston.info("Mapping action complete.");
            callback(err);
        });
    });
}

exports.storeAlteredRepo = function storeDirectory(repo, gitDirPath, callback) {
    var locals = { archivePath: temp.path() + ".tar" };

    async.series([
        // Put files into archive.
        function (callback) {
            winston.info("Packing archive for %s to %s", repo.gitIdentifier.toString(), locals.archivePath);
            var shellStr = util.format('(cd %s && tar -cf %s .)', gitDirPath, locals.archivePath)
            winston.info(shellStr);
            exec(shellStr, callback);
        },

        // Save archive to GFS
        function (callback) {
            winston.info("Saving archive from %s to GFS for repo %s", locals.archivePath, repo.gitIdentifier.toString());
            var fileId = repo.file ? repo.file : mdb.ObjectId();
            fs.readFile(locals.archivePath, 'binary', function (err, data) {
                if (err) callback(err);
                else {
                    writeGridFile(fileId, data, function (err) {
                        if (err) callback(err);
                        repo.file = fileId;
                        repo.save(callback);
                    });
                }
            });
        }],
        // Final callback, attempt to perform cleanup.
        function (err) {
            winston.info("Archive saved.");
            if (err) {
                winston.error(err);
            }

            winston.info("Attempting cleanup of %s", locals.archivePath);
//            fs.unlink(locals.archivePath, callback);
            callback();
        }
    );
}

exports.updateGitAction = function updateGitAction(repo, gitDirPath, callback) {
    async.series([
        // Perform a pull on the git repository.
        function (callback) {
            winston.info("Pulling git repository for %s at ", repo.gitIdentifier.toString(), gitDirPath);
            git.pull(gitDirPath, function (err, stdout, stderr) {
                winston.info("Stdout: %s", stdout);
                winston.info("Stderr: %s", stderr);
                callback();
            });
        },
        // Store
        function (callback) {
            exports.storeAlteredRepo(repo, gitDirPath, callback);
        }],
        callback
    );
}

exports.readTestAction = function readTestAction(repo, gitDirPath, callback) {
    var fileToRead = path.join(gitDirPath, 'test.tex');
    winston.info("Reading file %s.", fileToRead)
    fs.readFile(fileToRead, function (err, data) {
        winston.info("Read file. Data: %s", data ? data.toString() : "undefined");
        callback(err, data);
    });
}
