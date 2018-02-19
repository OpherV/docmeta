#! /usr/bin/env node

const path = require('path');
const simpleGit= require('simple-git');
const git = simpleGit(process.cwd());
const fs = require('fs-extra');
const del = require('del');
const pwd = path.resolve(process.cwd());
const q = require('q');
const argv = require('yargs').argv;
const replace = require('replace-in-file');

let options = {
    repoURL: "https://github.com/lance-gg/lance.git",
    deployRepoURL: "git@github.com:lance-gg/lance-docs-site.git",
    buildDocCommand: "npm",
    buildDocCommandArgs: "run docs",
    ignoreTags: ['r0.1.0', 'r0.2.0', 'r0.9.1', 'r0.9.3', 'r1.0.0',
        'r1.0.4',
        'r1.0.5',
        'r1.0.6',
        'r1.0.8',
        'r1.0.9'
    ]
};


const DIRS = {
    out: "docs_out",
    inner_out: "docs_out",
    temp: "docmeta_temp",
    temp_deploy: "docmeta_temp_deploy",
};


let mainGit, deployGit, tempGit;

let docVersions = [];


function cleanup(){
    console.log("cleaning up");

    let deferred = q.defer();

    //cleanup dirs
    fs.removeSync(path.join(pwd, DIRS.out));
    fs.removeSync(path.join(pwd, DIRS.temp));
    fs.removeSync(path.join(pwd, DIRS.temp_deploy));

    //recreate out dir
    fs.mkdirpSync(path.join(pwd, DIRS.out));
    fs.mkdirpSync(path.join(pwd, DIRS.temp));

    deferred.resolve();
    return deferred.promise;
}

function deployDocs(){
    let deferred = q.defer();

    console.log("Deploying docs");
    console.log(`cloning from ${options.deployRepoURL}`);
    mainGit.clone(
        options.deployRepoURL,
        path.join(pwd, DIRS.temp_deploy),
        [],afterClone);

    function afterClone(){
        console.log(`Done cloning`);

        //remove everything but the git
        del.sync(['!'+path.join(DIRS.temp_deploy,'.git/'), path.join(DIRS.temp_deploy,'*') ]);
        del.sync([path.join(DIRS.temp_deploy,'.gitignore')]);
        fs.copySync(path.join(pwd, DIRS.out), path.join(pwd, DIRS.temp_deploy));

        deployGit = simpleGit(path.join(pwd, DIRS.temp_deploy))
            .addConfig('user.name', 'Travis CI')
            .addConfig('user.email', process.env.COMMIT_AUTHOR_EMAIL)
            .add('./*')
            .commit("Autoupdate docs").then(afterCommit);
    }

    function afterCommit(){
        console.log("Done comitting. Pushing");
        deployGit.push();
        deferred.resolve();
    }

    return deferred.promise;
}

let generateRedirectFile = wrapSyncFunctionWithPromise(function(data){
    let redirectVersion = data.latest;
    console.log('redirect version', redirectVersion );

    const options = {
        files: path.join(DIRS.out,'index.html'),
        from: '${LANCEVERSION}',
        to: redirectVersion
    };

    const changes = replace.sync(options);
    console.log('Modified files:', changes.join(', '));
});

let generateDefaultFiles = wrapSyncFunctionWithPromise(function (){
    console.log('copying docmeta default files', path.join(pwd, '/node_modules/docmeta/src'), path.join(pwd, DIRS.out));
    fs.copySync(path.join(pwd, './node_modules/docmeta/src'), path.join(pwd, DIRS.out));
});

function generateDocsForAllVersions(){
    let deferred = q.defer();

    mainGit = simpleGit() ;
    tempGit = simpleGit(path.join(pwd, DIRS.temp)) ;

    let promises = [];

    git.tags(function(err,tags){
        console.log("available tags", tags);

        //push all tags to be built, except if defined otherwise in the ignoreTags options
        for (let tag of tags.all){
            if (options.ignoreTags.indexOf(tag) == -1) {
                docVersions.push(tag);
            }
        }
        docVersions.push('develop');


        if (!argv.nodocs) {
            for (let version of docVersions) {
                console.log(`generating docs for version ${version}`);
                let promise = generateDocsForVersion(version).then(function () {
                    console.log(`done generating docs for version ${version}`);
                });

                promises.push(promise);
            }
        }

        q.all(promises).then(function(){
            let latest = docVersions.length>0?docVersions[docVersions.length-2]:'develop';

            deferred.resolve({
                versions: docVersions,
                // is the latest a non ignored tag? if not use develop
                latest: latest
            });
        })

    });

    return deferred.promise;
}


function generateDocsForVersion(name){
    let deferred = q.defer();

    let versionPath = getVersionPath(name);

    tempGit.clone(
        options.repoURL,
        path.join(pwd, DIRS.temp, name),
        [
            `--branch`, `${name}`,
            `--depth`, `1`,
            `--single-branch`
        ],afterClone);

    function afterClone(){
        // console.log('after clone for version', name);
        // console.log('running npm install in versionpath', versionPath);
        process.chdir(versionPath);
        run_cmd('npm', ['install'], afterNpmInstall);
    }

    function afterNpmInstall(){
        // console.log('after npm install for version', name);
        process.chdir(versionPath);
        run_cmd(options.buildDocCommand, ['run', 'docs'], afterBuildDocsCommand)
    }

    function afterBuildDocsCommand(){
        // console.log('after build docs for version', name);
        process.chdir(pwd);
        fs.copySync(path.join(versionPath,DIRS.inner_out), path.join(DIRS.out,name));
        deferred.resolve();
    }

    return deferred.promise;
}

function getVersionPath(name){
    return path.join(pwd, DIRS.temp, name);
}


function wrapSyncFunctionWithPromise(func){
    return function(data) {
        let deferred = q.defer();
        q.resolve(func(data));
        return q.promise;
    }
}

function run_cmd(cmd, args, callBack ) {
    let spawn = require('cross-spawn');
    let child = spawn(cmd, args);
    let resp = "";

    child.stdout.on('data', function (buffer) { resp += buffer.toString() });
    child.stdout.on('end', function() { callBack (resp) });
}



//actual run command

let defer = q.defer();
p = defer.promise;
if (!argv.nocleanup){ p = p.then(cleanup); }
p = p.then(generateDefaultFiles);
p = p.then(generateDocsForAllVersions);
p = p.then(generateRedirectFile);
if (argv.deploy){ p = p.then(deployDocs); }

defer.resolve();
