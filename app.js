
var async = require('async')
  , git_commands = require('./git-commands')
  , git = require('nodegit')
  , sleep = require('sleep')
  , winston = require('winston')
  , mdb = require('./mdb')
// Actions
  , compileActivities = require('./actions/compileActivities')
  , compileCourses = require('./actions/compileCourses');


var tar = require("tar")
, fstream = require("fstream")
, rimraf = require("rimraf")
, fs = require("fs");

var temp = require('temp');
temp.track();

var path = require('path');

var exec = require('child_process').exec;
var child_process = require('child_process');

if (!process.env.XIMERA_MONGO_DATABASE ||
    !process.env.XIMERA_MONGO_URL) {
    throw "Appropriate environment variables not set.";
}

/* This should be using git clone --mirror so that I can git clone without pulling everything from github every single time. */

/* Then I have to
   * update the mirror (which should only pull the new data)
   * git clone (from the mirror).
   * get this into qemu using sandbox.sh
   * pdflatex all the tex files inside the sandbox
   * store the log output under the the sha1's for the tex file
   * store the PDFs
   * rasterize the PNGs 
   * convert the PDFs to SVGs
*/

////////////////////////////////////////////////////////////////
// createMirror asynchronously initializes a bare repoDirectory with the contents of the github repo at githubIdentifier
function createMirror( githubIdentifier, repoDirectory, callback ) {
    
    async.waterfall([
    	function (callback) {
	    winston.info( "Creating a bare repo at " + repoDirectory + "..." );
	    git.Repository.init(repoDirectory, 1 ).then( function(repo) {
		callback( null, repo );
	    }).catch( function(err) { callback(err); });
	},
	
	function (repo, callback) {
	    winston.info( "Creating an 'origin' remote with the mirror fetch refspec..." );
	    var result = git.Remote.createWithFetchspec(repo, "origin", "http://github.com/" + githubIdentifier, "+refs/*:refs/*").then( function(origin) {
		callback( null, repo, origin );
	    }).catch( function(err) { callback(err); });
	},
	
	function (repo, origin, callback) {
	    winston.info( "Opening repository configuration options..." );
	    repo.config().then( function(config) {
		winston.info( "Setting remote.origin.mirror = true for compatibility with git-core..." );
		// There is a missing config.setBool method, but setString does the right thing in the repository's config file
		callback( config.setString("remote.origin.mirror", "true" ), repo, origin );
	    }).catch( function(err) { callback(err); });
	},
	
    ], function (err, result) {
	callback( err );
    });
}

////////////////////////////////////////////////////////////////
// updateCachedMirror asynchronously creates (or refreshes) a bare repo containing a mirrored copy of the repo at githubIdentifier
//
// callback will be called with the repoDirectory, which is a base64 encoding of the github identifier in a .cache directory
function updateCachedMirror( githubIdentifier, callback ) {
    var homeDirectory = process.env.HOME;
    var cacheDirectory = path.resolve( homeDirectory, '.cache', 'ximera' );
    var cacheSubdirectory = new Buffer(githubIdentifier).toString('base64');
    var repoDirectory = path.resolve( cacheDirectory, cacheSubdirectory );    
    
    async.waterfall([
	function (callback) {
	    // Create bare repo if repoDirectory doesn't exist
	    winston.info( "Checking if there is a repo at " + repoDirectory + "..." );
	    fs.exists(repoDirectory, function(exists) {
		if (!exists) {
		    createMirror( githubIdentifier, repoDirectory, callback );
		} else {
		    callback( null );
		}
	    });
	},

	function (callback) {
	    winston.info( "Opening bare repository at " + repoDirectory + "..." );
	    git.Repository.openBare(repoDirectory).then( function(repo) {
		callback( null, repo );
	    }).catch( function(err) { callback(err); });
	},

	function (repo, callback) {
	    winston.info( "Getting remote..." );
	    git.Remote.load( repo, "origin" ).then( function(remote) {
		callback( null, repo, remote );
	    }).catch( function(err) { callback(err); });
	},

	function (repo, origin, callback) {
	    winston.info( "Fetching remote from http://github.com/" + githubIdentifier + "..." );
	    origin.fetch(git.Signature.now( "Ximera", "ximera@math.osu.edu" ), "fetch").then( function() {
		callback( null, repoDirectory );
	    });
	},
    ], function (err, result) {
	callback( err, result );
    });
}

function updateRepo(githubIdentifier) {
    var repositoryDirectory = "";
    var bareDirectory = "";
    var sandboxTarPath = "";
    var overlayPath = "";
    var outputTarPath = "";
    
    async.waterfall([
	// Get the repository from the repo
	function (callback) {
	    mdb.GitRepo.findOne({gitIdentifier: githubIdentifier}).exec( function (err, repoInformation) {
		callback(err, repoInformation);
	    });
	},

	function (repoInformation, callback) {
	    winston.info( "Creating or updating the mirror..." );
	    updateCachedMirror( githubIdentifier, function(err, directory) {
		bareDirectory = directory;
		callback( null ); 
	    });
	},

	function (callback) {
	    repositoryDirectory = "/tmp/sandbox";
	    winston.info( "Clearing temporary directory " + repositoryDirectory + "..." );
	    rimraf(repositoryDirectory, function(err) {
		callback( err );
	    });
	},

	/*
	function (callback) {
	    winston.info( "Creating temporary directory..." );
	    temp.mkdir('sandbox', function(err, dirPath) {
		repositoryDirectory = dirPath;
		callback( null );
	    });
	},
	*/
	
	function (callback) {
	    winston.info( "Cloning the mirror from " + bareDirectory + " into " + repositoryDirectory );
	    git.Clone.clone(bareDirectory, repositoryDirectory, null ).then( function(repo) {
		callback( null  );
	    }).catch( function(err) { callback(err); });
	},

	/*
	function (callback) {
	    winston.info( "Display README.md for fun" );
	    fs.readFile(path.resolve( repositoryDirectory, "README.md" ), 'utf8', function (err,data) {
		console.log( data );
		//exec( "cat " + repositoryDirectory + "/README.md" );
		callback( null );
	    });
	},
	*/
	
	function (callback) {
	    winston.info( "Queueing sandbox commands..." );
	    commands = "";
	    commands = commands + "#!/bin/bash\n";
	    // Change to the sandbox directory
	    commands = commands + "cd ~/sandbox\n";
	    // Set up some of the environment
	    commands = commands + "export HOME=/root\n";
	    commands = commands + "export TEXMFHOME=/root/texmf\n";
	    // Add the tikzexport class option to every tex file
	    commands = commands + 'find . -iname \'*.tex\' -execdir sed -i \'1s/^/\\\\PassOptionsToClass{tikzexport}{ximera}\\\\nonstopmode/\' {} \\;\n';
	    // Run pdflatex twice on all tex files
	    commands = commands + 'find . -iname \'*.tex\' -execdir pdflatex -shell-escape {} \\; > /dev/ttyS0\n';
	    commands = commands + 'find . -iname \'*.tex\' -execdir pdflatex -shell-escape {} \\; > /dev/ttyS0\n';
	    // Exit
	    commands = commands + "tar -cvf /dev/sdc .\n";
	    // Exit
	    commands = commands + "poweroff\n";
	    
	    fs.writeFile(path.resolve( repositoryDirectory, "sandbox.sh" ), commands, function (err,data) {
		callback( err );
	    });
	},

	function (callback) {
	    winston.info( "Making sandbox.sh executable..." );
	    fs.chmod(path.resolve( repositoryDirectory, "sandbox.sh" ), '700', function(err,data) {
		callback(err);
	    });
	},

	function (callback) {
	    winston.info( "Creating temporary tar file..." );
	    temp.open({prefix: "sandbox", suffix: ".tar"}, function(err, info) {
		sandboxTarPath = info.path;
		callback(err);
	    });
	},
			      
	function (callback) {
	    winston.info( "Packing tarfile with repository contents..." );

	    var destination = fs.createWriteStream(sandboxTarPath);
	    
	    var packer = tar.Pack({ noProprietary: true })
		.on('error', callback)
		.on('end', function () { callback(null); } );

	    fstream.Reader({ path: repositoryDirectory, type: "Directory" })
		.on('error', callback)
		.pipe(packer)
		.pipe(destination);
	},

	function (callback) {
	    winston.info( "Creating temp overlay file..." );
	    temp.open('overlay', function(err, info) {
		overlayPath = info.path;
		callback( err );
	    });
	},
	
	function( callback ) {
	    winston.info( "Initializing disk overlay with linux image..." );
	    var qemu_img = child_process.spawn( "qemu-img", ['create',
							     '-o','backing_file=' + path.resolve(process.cwd(),'linux','archlinux.raw') + ',backing_fmt=raw',
							     '-f','qcow2',
							     overlayPath] );

	    qemu_img.stdout.on('data', function (data) {
		winston.info('stdout: ' + data);
	    });

	    qemu_img.stderr.on('data', function (data) {
		winston.info('stderr: ' + data);
	    });
	    
	    qemu_img.on('close', function (code) {
		if (code == 0) {
		    callback( null );
		} else {
		    callback( code );
		}
	    });
	},

	function( callback ) {
	    winston.info( "Initializing empty disk..." );
	    
	    temp.open({prefix: "output", suffix: ".tar"}, function(err, info) {
		if (err) {
		    callback( err );
		} else {
		    outputTarPath = info.path;
		    
		    // 50 megabytes of available output space
		    var writeBuffer = new Buffer (1024*1024*50);
		    
		    var bufferPosition = 0,
			bufferLength = writeBuffer.length,
			filePosition = null;
		    
		    fs.write( info.fd,
			      writeBuffer,
			      bufferPosition,
			      bufferLength,
			      filePosition,
			      function (err, written) {
				  if (err) {
				      callback( err, overlayPath, null );
				  } else {
				      fs.close(info.fd, function(err) {
					  callback( err );
				      });
				  }
			      });
		}
	    });
	},
	
	function( callback ) {
	    winston.info( "Running LaTeX inside sandbox..." );
	    
	    var qemu = child_process.spawn( "qemu-system-x86_64", ['-enable-kvm',
								   '-cpu','host',
								   '-m','256',
								   '-hda', overlayPath,
								   '-hdb', sandboxTarPath,
								   '-hdc', outputTarPath,
								   '-kernel',"linux/vmlinuz-linux",
								   "-initrd","linux/initramfs-linux.img",
								   "-append",'console=ttyS0 root=/dev/sda',
								   "-nographic"
								  ]);

	    // Look at each line of output---although sometimes line are split when they are fed to stdout.on
	    var remainder = "";
	    var qemuLog = [];
	    var qemuError = null;

	    var lastOutputTime = process.hrtime();
	    
	    qemu.stdout.on('data', function (data) {
		var lines = (remainder + data).split( "\n" );
		remainder = lines.pop();

		lines.forEach( function(line) {
		    qemuLog.push( line );
		    console.log( line );

		    if (line.match("Failed to start Sandbox Service.")) {
			qemuError = "Failed to start Sandbox Service.";
			qemu.kill();
		    }
		});

		lastOutputTime = process.hrtime();
	    });

	    // Every second, see if we have gone a while without seeing any output from the sandboxed process
	    var watchdog = setInterval( function() {
		var secondsSinceLastOutput = process.hrtime(lastOutputTime)[0];

		// If so, kill the sandbox.
		if (secondsSinceLastOutput > 10) {
		    qemuError = "Seconds passed without output.";
		    qemu.kill();
		}
	    }, 1000 );
	    

	    qemu.on('close', function (code) {
		clearInterval( watchdog );
		callback( qemuError );
	    });
	},

	function (callback) {
	    winston.info( "Reading output tarfile..." );

	    fs.createReadStream(outputTarPath)
		.pipe(tar.Parse())
		.on("entry", function (e) {
		    console.error("entry", e.props);
		    /*
		    e.on("data", function (c) {
			console.error(" >>>" + c.toString().replace(/\n/g, "\\n"))
		    })
		    e.on("end", function () {
			console.error(" <<<EOF")
		    })
		    */
		}).on("end", function (e) {
		    callback( null );
		});
	},
	
	function (callback) {
	    temp.cleanup(function(err, stats) {
		winston.info("Cleaned up " + stats.files + " temp files");
		callback(err);
	    });
	},
	
	function (callback) {
	    console.log( "All done." );
	    callback( null );
	},
    ], function (err, result) {
	console.log( "Done." );
	// This needs to post an appropriate error as a GitHub status, with a link to a Ximera page which details all the errors
        if (err) {
	    winston.error(JSON.stringify(err));
	    winston.error(err.toString('utf-8'));
	    console.log( "err!" );
	    console.log( err.message() );
	    //mdb.GitRepo.update( repo, {$set: { feedback : err.toString('utf-8') }}, {}, function( err, document ) {} );

        } else {
	    winston.info("Success.");
	}
        //process.exit();
    });
}


function updateRepoBad(gitIdentifier) {
    mdb.GitRepo.findOne({gitIdentifier: gitIdentifier}).exec( function (err, repo) {
	async.series([
	    // Update all Git Repos.
	    function (callback) {
		winston.info( 'git.updateGitAction on ' + repo.gitIdentifier );
		git_commands.actOnGitFiles([repo], git_commands.updateGitAction, callback);
	    },
	    
	    // Compile TeX files in all repos and save the results.
	    function (callback) {
		winston.info( 'compileActivities on ' + repo.gitIdentifier );
		git_commands.actOnGitFiles([repo], compileActivities, callback)
	    },
	    
            // Compile Xim files in all repos and save the results.
            function (callback) {
		winston.info( 'compileCourses on ' + repo.gitIdentifier );
		git_commands.actOnGitFiles([repo], compileCourses, callback);
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

console.log( "whee" );

//updateRepo( "bartsnapp/ximeraMajoringInMathematics" );
updateRepo( "kisonecat/git-pull-test" );

mdb.initialize(function(error) {
    winston.info( "I am listening for work." );

    mdb.channel.on( 'update', function(message) {
	winston.info( "Updating " + message );
	updateRepo( message );
    });

    mdb.channel.on( 'create', function(message) {
	winston.info( "Creating " + message );
	// Creating is no different than updating
	updateRepo( message );
    });
});

