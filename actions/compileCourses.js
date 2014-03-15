var async = require('async')
  , winston = require('winston')
  , findit = require("findit")
  , fs = require('fs')
  , exec = require('child_process').exec
  , util = require('util')
  , mdb = require('../mdb')
  , misc = require('../misc')
  , crypto = require('crypto')
  , path = require('path')
  , _ = require('underscore')
  , yaml = require('js-yaml');

// Course unique identifier is gitusername/gitrepo:relativeFilePath. Do not keep old versions.

// Active/inactive tag for course files (and activities?)
// Sessions expressed via new course file, e.g. moocolus-autumn-2013.xim

// Tag scopes with date updated; index by activity/user/date, index user/activity
// Tag activity with date updated; index gitIdent/date, index hash

module.exports = function compileCourses(repo, gitDirPath, callback) {
    winston.info('Compiling courses from Git repo.');
    var locals = {};

    async.series([
        // Get list of .xim files to process
        function (callback) {
            winston.info('Finding .xim files in repo.');
            misc.getUnhiddenFileList(gitDirPath, '.xim', function (err, filePaths) {
                if (err) {callback(err)}
                else {
                    locals.filePaths = filePaths;
                    callback();
                }
            })
        },
        // Process each .xim file.
        function (callback) {
            winston.info('Processing .xim files.');
            async.eachSeries(locals.filePaths, _.partial(compileCourseFile, repo, gitDirPath), callback);
        }], callback);
}

function compileCourseFile(repo, gitDirPath, filePath, callback) {
    var locals = {};
    var fileName = path.basename(filePath).toString();
    var relativePath = path.relative(gitDirPath, filePath);
    async.series([
        function (callback) {
            winston.info('Reading .xim file.');
            fs.readFile(filePath, 'utf8', function (err, data) {
                if (err) callback (err)
                else {
                    locals.fileData = data;
                    callback();
                }
            });
        },
        function (callback) {
            winston.info('Parsing .xim file.');
            locals.ximDoc = parseXimDoc(locals.fileData, repo.gitIdentifier);
            fillOutXimDocTreeActivities(locals.ximDoc.activityTree, callback);
        },
        function (callback) {
            // Save course file.
            winston.info('Saving compiled course file.');
            var courseKey = {relativePath: relativePath, repo: repo._id};
            mdb.Course.findOne(courseKey, function (err, course) {
                if (err) callback(err);
                else {
                    if (!course) {
                        course = new mdb.Course(courseKey);
                    }
                    course.activityTree = locals.ximDoc.activityTree;
                    course.name = locals.ximDoc.metadata.name;
                    course.description = locals.ximDoc.metadata.description;
                    course.slug = repo.gitIdentifier + '/' + relativePath.replace(/.xim$/, '' );
                    course.markModified('activityTree');
                    course.save(callback);
                }
            });
        }], callback);
}

function fillOutXimDocTreeActivities(ximDocTree, callback) {
    async.eachSeries(ximDocTree, function(activityEntry, callback) {
        winston.info('Filling out ximdoc');
        mdb.Activity.findOne({slug: activityEntry.slug, recent: true}, function (err, activity) {
            if (err) callback(err);
            else if (activity) {
                winston.info("Filling out activity %s", activityEntry.slug);
                activityEntry.title = activity.title;
                activityEntry.description = activity.description;
                activityEntry.activity = activity._id;
                fillOutXimDocTreeActivities(activityEntry.children, callback);
            }
            else {
                callback('Activity not found: ' + activityEntry.slug);
            }
        });
    }, callback);
}


function parseXimDoc(data, gitIdent) {
    lines = data.split('\n')
    var ximTree = []
    var context = {subtree: ximTree, prev: null, indent: 0}
    var lastAct = null;
    var inMeta = false;
    var meta = "";

    _.each(lines, function(line) {
        var indent = line.match(/^ */)[0].length;
        var trimmedLine = line.trim();

        if (trimmedLine === "") {
            return;
        }
        else if (trimmedLine === "---") {
            // Toggle meta mode.
            inMeta = !inMeta;
            return;
        }

        if (inMeta) {
            meta += line + "\n";
        }
        else {
            if (indent > context.indent) {
                // Descend.
                if (context.subtree.length > 0) {
                    context = {subtree: _.last(context.subtree).children, prev: context, indent: indent}
                }
                else {
                    throw 'Incorrect course file format: can not start indented.';
                }
            }
            else {
                // Ascend if necessary.
                while (indent < context.indent) {
                    context = context.prev;
                }
                if (indent != context.indent) {
                    throw "Incorrect indentation in course file. " + indent + " vs " + context.indent;
                }
            }
            lastAct = trimmedLine;
            // Is a relative path for this repo: prefix repo's gitIdent.
            if (lastAct.indexOf(':') == -1) {
                lastAct = gitIdent + ':' + lastAct;
            }
            context.subtree.push({slug: lastAct, children: []});
        }
    });
    var metadata = yaml.safeLoad(meta);
    return {activityTree: ximTree, metadata: metadata};
}
