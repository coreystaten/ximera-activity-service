var async = require('async')
  , dive = require('node-dive')
  , path = require('path');

function convertRepoAction (repo, gitDirPath, callback) {
    var seenError = false;

    // This ignores hidden files/folders by default; files/folders can be hidden by prepending '.'
    dive.dive(gitDirPath, function (err, filepath) {
        if (err) {
            seenError = err;
        }
        else {
            // Only attempt to convert files with a .tex extension.
            if (path.extname(filepath) == ".tex") {
                convertTexFile(filepath)                
            }
        }
    }, function () {
        if (seenError) callback(seenError);
        else callback();
    });
}

function convertTexFile(filepath) {
    // Only applies to files with a .tex
}